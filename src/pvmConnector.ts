/**
 * PvmConnector — PolkaVM (RISC-V) backend connector.
 *
 * Observability is achieved via host-function (syscall) tracing:
 *   RUST_LOG="runtime::revive::strace=trace,runtime::revive=debug"
 *
 * The connector attaches to the strace log stream emitted by NodeOrchestrator
 * and builds a step-through debugger at the syscall boundary level.
 *
 * Weight metrics (ref_time, proof_size, storage_deposit) are parsed from
 * substrate runtime logs and optionally queried via Substrate JSON-RPC.
 */

import { EventEmitter } from 'events';
import WebSocket from 'ws';
import {
  BackendConnector,
  BackendType,
  DebugConfig,
  ExecutionEvent,
  ExecutionMetrics,
  ReviveBreakpoint,
  ReviveStackFrame,
  ReviveVariable,
  SyscallStep
} from './backendConnector';
import {
  StraceParser,
  StraceCallEntry,
  StraceCallExit,
  StraceWeight,
  describeHostFunction
} from './straceParser';
import { SourceMapper } from './sourceMapper';
import { NodeOrchestrator } from './nodeOrchestrator';

// ─── Substrate RPC Types ──────────────────────────────────────────────────────

interface SubstrateRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params: unknown[];
}

// ─── PVM Connector ────────────────────────────────────────────────────────────

export class PvmConnector extends EventEmitter implements BackendConnector {
  readonly backendType: BackendType = 'PVM';

  private config: DebugConfig | null = null;
  private sourceMapper: SourceMapper;
  private orchestrator: NodeOrchestrator | null = null;
  private straceParser: StraceParser;
  private breakpoints: Map<string, ReviveBreakpoint[]> = new Map();
  private syscallTrace: SyscallStep[] = [];
  private callStack: ReviveStackFrame[] = [];
  private currentSyscallIndex = -1;
  private currentMetrics: ExecutionMetrics = { backend: 'PVM' };
  private metricsCallbacks: Array<(m: ExecutionMetrics) => void> = [];
  private eventCallbacks: Array<(e: ExecutionEvent) => void> = [];
  private nextBreakpointId = 1;
  private ws: WebSocket | null = null;
  private rpcId = 1;
  private pendingRpcCalls: Map<number | string, (result: unknown) => void> = new Map();

  // Step-through control
  private stepResolvers: Array<() => void> = [];
  private isRunning = false;
  private isPaused = false;

  // Current weight metrics (updated as logs arrive)
  private latestRefTime = 0n;
  private latestProofSize = 0n;
  private latestStorageDeposit = 0n;

  // Deployed contract address
  private contractAddress: string | null = null;

  constructor(sourceMapper: SourceMapper, orchestrator: NodeOrchestrator) {
    super();
    this.sourceMapper = sourceMapper;
    this.orchestrator = orchestrator;
    this.straceParser = new StraceParser();
  }

  // ─── BackendConnector Interface ────────────────────────────────────────────

  async connect(config: DebugConfig): Promise<void> {
    this.config = config;

    // Connect to substrate WebSocket RPC
    await this.connectWebSocket(config.substrateUrl);

    // Attach to strace log stream from the node orchestrator
    this.orchestrator?.on('straceLine', (line: string) => {
      this.processStraceLine(line);
    });

    // Subscribe to runtime events for weight metrics
    await this.subscribeToRuntimeEvents();
  }

  async disconnect(): Promise<void> {
    this.ws?.close();
    this.ws = null;
    this.config = null;
    this.syscallTrace = [];
    this.callStack = [];
    this.currentSyscallIndex = -1;
    this.straceParser.reset();
  }

  async setBreakpoint(file: string, line: number): Promise<ReviveBreakpoint> {
    const bp: ReviveBreakpoint = {
      id: this.nextBreakpointId++,
      verified: true,  // PVM breakpoints are approximate — at syscall boundaries
      file,
      line
    };
    const existing = this.breakpoints.get(file) ?? [];
    this.breakpoints.set(file, [...existing, bp]);
    return bp;
  }

  async clearBreakpoints(file: string): Promise<void> {
    this.breakpoints.delete(file);
  }

  async step(): Promise<import('./backendConnector').StepResult> {
    if (this.currentSyscallIndex >= this.syscallTrace.length - 1) {
      return { stopped: true, reason: 'exit' };
    }
    this.currentSyscallIndex++;
    return this.buildStepResult();
  }

  async stepIn(): Promise<import('./backendConnector').StepResult> {
    return this.step();
  }

  async stepOut(): Promise<import('./backendConnector').StepResult> {
    // In PVM syscall tracing, stepOut skips to the next exit event
    while (this.currentSyscallIndex < this.syscallTrace.length - 1) {
      this.currentSyscallIndex++;
      const step = this.syscallTrace[this.currentSyscallIndex];
      if (!step.isEntry) {
        break;
      }
    }
    return this.buildStepResult();
  }

  async continue(): Promise<void> {
    while (this.currentSyscallIndex < this.syscallTrace.length - 1) {
      this.currentSyscallIndex++;
      const step = this.syscallTrace[this.currentSyscallIndex];
      if (step.sourceLocation && this.isBreakpointAt(step.sourceLocation.file, step.sourceLocation.line)) {
        this.emitExecutionEvent('breakpointHit', {
          syscall: step.name,
          location: step.sourceLocation
        });
        return;
      }
    }
    this.emitExecutionEvent('executionFinished', {});
  }

  async pause(): Promise<void> {
    this.isPaused = true;
  }

  async getCallStack(): Promise<ReviveStackFrame[]> {
    return [...this.callStack];
  }

  async getVariables(frameId: number): Promise<ReviveVariable[]> {
    const step = this.syscallTrace[frameId] ?? this.syscallTrace[this.currentSyscallIndex];
    if (!step) return [];

    const vars: ReviveVariable[] = [
      {
        name: 'syscall',
        value: step.name,
        type: 'host_function',
        variablesReference: 0
      },
      {
        name: 'args',
        value: step.args || '(none)',
        type: 'encoded_args',
        variablesReference: 0
      },
      {
        name: 'result',
        value: step.result ?? 'pending',
        type: 'Result<T, E>',
        variablesReference: 0
      },
      {
        name: 'ref_time',
        value: this.latestRefTime.toString(),
        type: 'u64',
        variablesReference: 0
      },
      {
        name: 'proof_size',
        value: this.latestProofSize.toString(),
        type: 'u64',
        variablesReference: 0
      },
      {
        name: 'storage_deposit',
        value: this.latestStorageDeposit.toString(),
        type: 'u128',
        variablesReference: 0
      }
    ];

    return vars;
  }

  getCurrentMetrics(): ExecutionMetrics {
    return { ...this.currentMetrics };
  }

  onMetricsUpdate(cb: (metrics: ExecutionMetrics) => void): void {
    this.metricsCallbacks.push(cb);
  }

  onExecutionEvent(cb: (event: ExecutionEvent) => void): void {
    this.eventCallbacks.push(cb);
  }

  // ─── Strace Log Processing ─────────────────────────────────────────────────

  private processStraceLine(line: string): void {
    const event = this.straceParser.parseLine(line);
    if (!event) return;

    switch (event.type) {
      case 'callEntry': {
        const entry = event as StraceCallEntry;
        const syscall = this.straceParser.toSyscallStep(entry);
        syscall.sourceLocation = this.resolveSyscallLocation(entry.name);
        this.syscallTrace.push(syscall);

        // Update call stack
        this.callStack.push({
          id: this.callStack.length,
          name: `${entry.name}(${entry.args.slice(0, 60)}${entry.args.length > 60 ? '...' : ''})`,
          source: syscall.sourceLocation?.file,
          line: syscall.sourceLocation?.line,
          depth: this.straceParser.currentDepth,
          contractAddress: entry.address,
          syscallName: entry.name
        });

        this.emitExecutionEvent('syscallEmitted', {
          name: entry.name,
          args: entry.args,
          description: describeHostFunction(entry.name),
          address: entry.address
        });
        break;
      }

      case 'callExit': {
        const exit = event as StraceCallExit;
        const ret = this.straceParser.toSyscallReturn(exit);
        this.syscallTrace.push(ret);

        // Pop from call stack
        if (this.callStack.length > 0) {
          this.callStack.pop();
        }

        // Update last entry's result
        const lastEntry = this.syscallTrace.slice().reverse()
          .find(s => s.isEntry && s.address === exit.address);
        if (lastEntry) {
          lastEntry.result = `${exit.status}(${exit.data.slice(0, 100)})`;
        }
        break;
      }

      case 'weight': {
        const w = event as StraceWeight;
        this.latestRefTime = w.refTime;
        this.latestProofSize = w.proofSize;
        if (w.storageDeposit !== undefined) {
          this.latestStorageDeposit = w.storageDeposit;
        }
        this.updateMetrics();
        break;
      }

      case 'deploy': {
        const d = event;
        if (d.type === 'deploy') {
          this.contractAddress = d.contractAddress;
          this.emitExecutionEvent('contractDeployed', {
            address: d.contractAddress
          });
        }
        break;
      }
    }
  }

  /** Try to resolve a syscall to a Solidity source location. */
  private resolveSyscallLocation(syscallName: string): import('./backendConnector').SourceLocation | undefined {
    // Without full DWARF/RISC-V source maps, we provide a best-effort mapping
    // based on the call index in the deployment sequence
    const callIndex = this.syscallTrace.filter(s => s.isEntry).length;
    const pc = callIndex;  // placeholder — resolc source maps would provide accurate PCs
    return this.sourceMapper.pcToSourceLocation(pc);
  }

  private updateMetrics(): void {
    this.currentMetrics = {
      backend: 'PVM',
      refTime: this.latestRefTime,
      proofSize: this.latestProofSize,
      storageDeposit: this.latestStorageDeposit,
      syscallTrace: [...this.syscallTrace],
      contractAddress: this.contractAddress ?? undefined
    };
    this.notifyMetrics(this.currentMetrics);
  }

  private buildStepResult(): import('./backendConnector').StepResult {
    const step = this.syscallTrace[this.currentSyscallIndex];
    if (!step) {
      return { stopped: true, reason: 'exit' };
    }
    return {
      stopped: true,
      reason: 'step',
      location: step.sourceLocation,
      metrics: {
        refTime: this.latestRefTime,
        proofSize: this.latestProofSize,
        storageDeposit: this.latestStorageDeposit
      }
    };
  }

  // ─── Substrate WebSocket RPC ───────────────────────────────────────────────

  private connectWebSocket(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);

      this.ws.on('open', () => {
        resolve();
      });

      this.ws.on('error', (err) => {
        // Non-fatal — weight metrics from strace logs are sufficient
        this.emit('log', `Substrate WS connection failed: ${err.message} — using strace only`);
        resolve();
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          const cb = this.pendingRpcCalls.get(msg.id);
          if (cb) {
            this.pendingRpcCalls.delete(msg.id);
            cb(msg.result ?? msg.error);
          }
          // Handle subscription messages
          if (msg.method === 'state_runtimeVersion') {
            this.emit('runtimeVersion', msg.params?.result);
          }
        } catch {
          // ignore parse errors
        }
      });

      this.ws.on('close', () => {
        this.ws = null;
      });
    });
  }

  private async subscribeToRuntimeEvents(): Promise<void> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    // Subscribe to system events — will contain ExtrinsicSuccess with weight
    await this.wsSend('state_subscribeStorage', [[]]);
  }

  private wsSend(method: string, params: unknown[]): Promise<unknown> {
    return new Promise((resolve) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        resolve(null);
        return;
      }
      const id = this.rpcId++;
      this.pendingRpcCalls.set(id, resolve);
      const req: SubstrateRpcRequest = { jsonrpc: '2.0', id, method, params };
      this.ws.send(JSON.stringify(req));
      // Timeout after 5s
      setTimeout(() => {
        if (this.pendingRpcCalls.has(id)) {
          this.pendingRpcCalls.delete(id);
          resolve(null);
        }
      }, 5000);
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private isBreakpointAt(file: string, line: number): boolean {
    const bps = this.breakpoints.get(file) ?? [];
    return bps.some(bp => bp.line === line);
  }

  private notifyMetrics(metrics: ExecutionMetrics): void {
    for (const cb of this.metricsCallbacks) {
      cb(metrics);
    }
  }

  private emitExecutionEvent(type: import('./backendConnector').ExecutionEventType, data: Record<string, unknown>): void {
    const event: ExecutionEvent = { type, backend: 'PVM', data, timestamp: Date.now() };
    for (const cb of this.eventCallbacks) {
      cb(event);
    }
  }

  // ─── Accessors ─────────────────────────────────────────────────────────────

  getSyscallTrace(): SyscallStep[] {
    return [...this.syscallTrace];
  }

  getContractAddress(): string | null {
    return this.contractAddress;
  }

  resetTrace(): void {
    this.syscallTrace = [];
    this.callStack = [];
    this.currentSyscallIndex = -1;
    this.latestRefTime = 0n;
    this.latestProofSize = 0n;
    this.latestStorageDeposit = 0n;
    this.straceParser.reset();
    this.updateMetrics();
  }
}
