/**
 * RevmConnector — REVM (EVM) backend connector.
 *
 * Interfaces with the pallet-revive-eth-rpc adapter via Ethereum JSON-RPC.
 * Uses debug_traceTransaction for opcode-level execution traces,
 * mapping each opcode step back to Solidity source via solc source maps.
 */

import axios, { AxiosInstance } from 'axios';
import { EventEmitter } from 'events';
import {
  BackendConnector,
  BackendType,
  DebugConfig,
  ExecutionEvent,
  ExecutionMetrics,
  OpcodeStep,
  ReviveBreakpoint,
  ReviveStackFrame,
  ReviveVariable
} from './backendConnector';
import { SourceMapper } from './sourceMapper';

// ─── JSON-RPC Types ───────────────────────────────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: unknown[];
}

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
}

interface OpcodeTraceStep {
  pc: number;
  op: string;
  gas: number;
  gasCost: number;
  depth: number;
  stack: string[];
  memory?: string[];
  storage?: Record<string, string>;
  reason?: string;
}

interface DebugTraceResult {
  gas: number;
  failed: boolean;
  returnValue: string;
  structLogs: OpcodeTraceStep[];
}

interface TransactionReceipt {
  transactionHash: string;
  blockNumber: string;
  gasUsed: string;
  status: string;
  contractAddress?: string;
}

// ─── REVM Connector ───────────────────────────────────────────────────────────

export class RevmConnector extends EventEmitter implements BackendConnector {
  readonly backendType: BackendType = 'REVM';

  private client: AxiosInstance | null = null;
  private rpcId = 1;
  private config: DebugConfig | null = null;
  private sourceMapper: SourceMapper;
  private breakpoints: Map<string, ReviveBreakpoint[]> = new Map();
  private currentTrace: OpcodeTraceStep[] = [];
  private currentStepIndex = -1;
  private currentMetrics: ExecutionMetrics = { backend: 'REVM' };
  private metricsCallbacks: Array<(m: ExecutionMetrics) => void> = [];
  private eventCallbacks: Array<(e: ExecutionEvent) => void> = [];
  private nextBreakpointId = 1;
  private gasLimit = 30_000_000n;

  constructor(sourceMapper: SourceMapper) {
    super();
    this.sourceMapper = sourceMapper;
  }

  // ─── BackendConnector Interface ────────────────────────────────────────────

  async connect(config: DebugConfig): Promise<void> {
    this.config = config;
    this.client = axios.create({
      baseURL: config.ethRpcUrl,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10_000
    });

    // Verify connectivity
    const blockNumber = await this.rpcCall<string>('eth_blockNumber', []);
    this.emit('connected', { blockNumber });

    // Fetch gas limit from latest block
    const block = await this.rpcCall<{ gasLimit: string }>(
      'eth_getBlockByNumber',
      ['latest', false]
    );
    if (block?.gasLimit) {
      this.gasLimit = BigInt(block.gasLimit);
    }
  }

  async disconnect(): Promise<void> {
    this.client = null;
    this.config = null;
    this.currentTrace = [];
    this.currentStepIndex = -1;
  }

  async setBreakpoint(file: string, line: number): Promise<ReviveBreakpoint> {
    const pc = this.sourceMapper.lineToNearestPc(file, line);
    const bp: ReviveBreakpoint = {
      id: this.nextBreakpointId++,
      verified: pc !== undefined,
      file,
      line,
      bytecodeOffset: pc
    };

    const existing = this.breakpoints.get(file) ?? [];
    this.breakpoints.set(file, [...existing, bp]);
    return bp;
  }

  async clearBreakpoints(file: string): Promise<void> {
    this.breakpoints.delete(file);
  }

  async step(): Promise<import('./backendConnector').StepResult> {
    if (this.currentStepIndex >= this.currentTrace.length - 1) {
      return { stopped: true, reason: 'exit' };
    }
    this.currentStepIndex++;
    return this.buildStepResult();
  }

  async stepIn(): Promise<import('./backendConnector').StepResult> {
    return this.step();
  }

  async stepOut(): Promise<import('./backendConnector').StepResult> {
    const currentDepth = this.currentTrace[this.currentStepIndex]?.depth ?? 0;
    while (this.currentStepIndex < this.currentTrace.length - 1) {
      this.currentStepIndex++;
      if (this.currentTrace[this.currentStepIndex].depth < currentDepth) {
        break;
      }
    }
    return this.buildStepResult();
  }

  async continue(): Promise<void> {
    // Advance until breakpoint or end
    while (this.currentStepIndex < this.currentTrace.length - 1) {
      this.currentStepIndex++;
      const step = this.currentTrace[this.currentStepIndex];
      const loc = this.sourceMapper.pcToSourceLocation(step.pc);
      if (loc && this.isBreakpointAt(loc.file, loc.line)) {
        this.emitExecutionEvent('breakpointHit', { step, location: loc });
        return;
      }
    }
    this.emitExecutionEvent('executionFinished', {});
  }

  async pause(): Promise<void> {
    // For trace-based replay, pause just stops advancing
  }

  async getCallStack(): Promise<ReviveStackFrame[]> {
    const frames: ReviveStackFrame[] = [];
    const step = this.currentTrace[this.currentStepIndex];
    if (!step) return frames;

    const loc = this.sourceMapper.pcToSourceLocation(step.pc);
    frames.push({
      id: 0,
      name: `${step.op} @ PC:${step.pc}`,
      source: loc?.file,
      line: loc?.line,
      column: loc?.column,
      depth: step.depth,
      opcodeIndex: this.currentStepIndex
    });
    return frames;
  }

  async getVariables(frameId: number): Promise<ReviveVariable[]> {
    const step = this.currentTrace[frameId] ?? this.currentTrace[this.currentStepIndex];
    if (!step) return [];

    const vars: ReviveVariable[] = [];

    // EVM Stack
    step.stack.slice().reverse().forEach((val, i) => {
      vars.push({
        name: `stack[${i}]`,
        value: val,
        type: 'uint256',
        variablesReference: 0
      });
    });

    // Storage slots
    if (step.storage) {
      for (const [key, value] of Object.entries(step.storage)) {
        vars.push({
          name: `storage[${key.slice(0, 10)}...]`,
          value,
          type: 'bytes32',
          variablesReference: 0
        });
      }
    }

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

  // ─── High-Level: Trace a Transaction ──────────────────────────────────────

  /**
   * Send a transaction and capture its full opcode trace.
   * Returns the trace ready for step-through debugging.
   */
  async traceTransaction(
    from: string,
    to: string | null,
    data: string,
    value = '0x0'
  ): Promise<string> {
    if (!this.client) {
      throw new Error('RevmConnector not connected');
    }

    // Send the transaction
    const txHash = await this.rpcCall<string>('eth_sendTransaction', [{
      from,
      to,
      data,
      value,
      gas: `0x${this.gasLimit.toString(16)}`
    }]);

    // Wait for receipt
    let receipt: TransactionReceipt | null = null;
    for (let i = 0; i < 30; i++) {
      receipt = await this.rpcCall<TransactionReceipt | null>(
        'eth_getTransactionReceipt', [txHash]
      );
      if (receipt) break;
      await sleep(1000);
    }

    if (!receipt) {
      throw new Error(`Transaction ${txHash} not mined within timeout`);
    }

    // Trace the transaction
    const traceResult = await this.rpcCall<DebugTraceResult>(
      'debug_traceTransaction',
      [txHash, { disableStorage: false, disableMemory: false, disableStack: false }]
    );

    if (!traceResult) {
      throw new Error('debug_traceTransaction returned null');
    }

    this.loadTrace(traceResult, receipt);
    return txHash;
  }

  /** Load a pre-fetched trace (for replay or testing). */
  loadTrace(traceResult: DebugTraceResult, receipt: TransactionReceipt): void {
    this.currentTrace = traceResult.structLogs;
    this.currentStepIndex = -1;

    const gasUsed = BigInt(receipt.gasUsed);
    const opcodeTrace = this.buildOpcodeTrace(traceResult.structLogs);

    this.currentMetrics = {
      backend: 'REVM',
      gasUsed,
      gasLimit: this.gasLimit,
      opcodeTrace,
      txHash: receipt.transactionHash,
      blockNumber: parseInt(receipt.blockNumber, 16),
      success: receipt.status === '0x1',
      contractAddress: receipt.contractAddress
    };

    this.notifyMetrics(this.currentMetrics);
    this.emitExecutionEvent('transactionSent', {
      txHash: receipt.transactionHash,
      gasUsed: gasUsed.toString()
    });
  }

  // ─── Account Management ───────────────────────────────────────────────────

  async getDefaultAccount(): Promise<string> {
    const accounts = await this.rpcCall<string[]>('eth_accounts', []);
    if (!accounts || accounts.length === 0) {
      throw new Error('No accounts available from eth-rpc adapter');
    }
    return accounts[0];
  }

  async getBalance(address: string): Promise<bigint> {
    const hex = await this.rpcCall<string>('eth_getBalance', [address, 'latest']);
    return hex ? BigInt(hex) : 0n;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private buildStepResult(): import('./backendConnector').StepResult {
    const step = this.currentTrace[this.currentStepIndex];
    if (!step) {
      return { stopped: true, reason: 'exit' };
    }

    const loc = this.sourceMapper.pcToSourceLocation(step.pc);

    // Update running metrics
    const gasUsed = BigInt(step.gas);
    this.currentMetrics = {
      ...this.currentMetrics,
      gasUsed: this.gasLimit - gasUsed,
      opcodeTrace: this.buildOpcodeTrace(
        this.currentTrace.slice(0, this.currentStepIndex + 1)
      )
    };
    this.notifyMetrics(this.currentMetrics);
    this.emitExecutionEvent('opcodeExecuted', {
      op: step.op,
      pc: step.pc,
      gasCost: step.gasCost
    });

    return {
      stopped: true,
      reason: 'step',
      location: loc,
      metrics: { gasUsed: this.currentMetrics.gasUsed }
    };
  }

  private buildOpcodeTrace(logs: OpcodeTraceStep[]): OpcodeStep[] {
    return logs.map(log => ({
      pc: log.pc,
      op: log.op,
      gasCost: BigInt(log.gasCost),
      gasRemaining: BigInt(log.gas),
      depth: log.depth,
      stack: log.stack ?? [],
      storage: log.storage,
      sourceLocation: this.sourceMapper.pcToSourceLocation(log.pc)
    }));
  }

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
    const event: ExecutionEvent = { type, backend: 'REVM', data, timestamp: Date.now() };
    for (const cb of this.eventCallbacks) {
      cb(event);
    }
  }

  private async rpcCall<T>(method: string, params: unknown[]): Promise<T> {
    if (!this.client) {
      throw new Error('RevmConnector not connected');
    }
    const req: JsonRpcRequest = { jsonrpc: '2.0', id: this.rpcId++, method, params };
    const res = await this.client.post<JsonRpcResponse<T>>('/', req);
    if (res.data.error) {
      throw new Error(`JSON-RPC error ${res.data.error.code}: ${res.data.error.message}`);
    }
    return res.data.result as T;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
