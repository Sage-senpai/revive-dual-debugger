#!/usr/bin/env node
/**
 * ReviveDebugSession — the Debug Adapter Protocol implementation.
 *
 * This file is the entry point for the debug adapter process (runs as a
 * separate Node.js subprocess, launched by VS Code via package.json "program").
 *
 * Implements the DAP for:
 *   - REVM backend: opcode-level stepping via debug_traceTransaction
 *   - PVM backend:  syscall-level stepping via strace log parsing
 *   - BOTH:         runs both connectors simultaneously for comparison
 */

import {
  LoggingDebugSession,
  InitializedEvent,
  StoppedEvent,
  OutputEvent,
  TerminatedEvent,
  BreakpointEvent,
  Thread,
  StackFrame,
  Scope,
  Variable,
  Source,
  Breakpoint
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import * as path from 'path';

import {
  BackendType,
  DebugConfig,
  ReviveBreakpoint,
  ExecutionMetrics
} from './backendConnector';
import { NodeOrchestrator, NodeOrchestratorConfig } from './nodeOrchestrator';
import { RevmConnector } from './revmConnector';
import { PvmConnector } from './pvmConnector';
import { SourceMapper } from './sourceMapper';
import { WeightMeter } from './weightMeter';
import { ContractDeployer } from './contractDeployer';

// ─── Launch Arguments ─────────────────────────────────────────────────────────

interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
  contractFile: string;
  backend: BackendType;
  ethRpcUrl: string;
  substrateUrl: string;
  nodePath: string;
  ethRpcPath: string;
  resolcPath: string;
  solcPath: string;
  constructorArgs: unknown[];
  autoStartNode: boolean;
  trace: boolean;
}

const DEFAULT_ARGS: Partial<LaunchRequestArguments> = {
  backend: 'BOTH',
  ethRpcUrl: 'http://localhost:8545',
  substrateUrl: 'ws://localhost:9944',
  nodePath: 'revive-dev-node',
  ethRpcPath: 'pallet-revive-eth-rpc',
  resolcPath: 'resolc',
  solcPath: 'solc',
  constructorArgs: [],
  autoStartNode: true,
  trace: false
};

// Thread IDs — one per backend
const REVM_THREAD_ID = 1;
const PVM_THREAD_ID = 2;

// ─── ReviveDebugSession ───────────────────────────────────────────────────────

export class ReviveDebugSession extends LoggingDebugSession {
  private currentBackend: BackendType = 'BOTH';
  private orchestrator: NodeOrchestrator | null = null;
  private revmConnector: RevmConnector | null = null;
  private pvmConnector: PvmConnector | null = null;
  private sourceMapper: SourceMapper;
  private weightMeter: WeightMeter;
  private deployer: ContractDeployer | null = null;
  private launchArgs: LaunchRequestArguments | null = null;

  // Breakpoint tracking
  private breakpointMap: Map<string, ReviveBreakpoint[]> = new Map();
  private nextBreakpointId = 1;

  // Active thread tracking
  private stoppedThread: number | null = null;

  constructor() {
    super('revive-debug.log');
    this.sourceMapper = new SourceMapper();
    this.weightMeter = new WeightMeter();

    // Show column numbers
    this.setDebuggerColumnsStartAt1(false);
    this.setDebuggerLinesStartAt1(true);
  }

  // ─── DAP: initializeRequest ────────────────────────────────────────────────

  protected initializeRequest(
    response: DebugProtocol.InitializeResponse,
    _args: DebugProtocol.InitializeRequestArguments
  ): void {
    response.body = response.body ?? {};
    response.body.supportsConfigurationDoneRequest = true;
    response.body.supportsEvaluateForHovers = true;
    response.body.supportsStepBack = false;
    response.body.supportsRestartRequest = true;
    response.body.supportsTerminateRequest = true;
    response.body.supportsBreakpointLocationsRequest = true;
    response.body.supportsSingleThreadExecutionRequests = false;

    this.sendResponse(response);
    this.sendEvent(new InitializedEvent());
  }

  // ─── DAP: launchRequest ────────────────────────────────────────────────────

  protected async launchRequest(
    response: DebugProtocol.LaunchResponse,
    args: LaunchRequestArguments
  ): Promise<void> {
    this.launchArgs = { ...DEFAULT_ARGS, ...args } as LaunchRequestArguments;
    this.currentBackend = this.launchArgs.backend;

    try {
      // 1. Start local dev node if requested
      if (this.launchArgs.autoStartNode) {
        await this.startNode();
      }

      // 2. Set up connectors
      await this.initializeConnectors();

      // 3. Compile and deploy contract
      await this.compileAndDeploy();

      this.sendResponse(response);
      this.log(`ReviveDualDebugger started — backend: ${this.currentBackend}`);
      this.log('Use "Step Over" (F10) to advance through opcodes/syscalls');
      this.log('Use "Continue" (F5) to run to the next breakpoint');

    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.sendErrorResponse(response, 1000, `Launch failed: ${message}`);
      this.sendEvent(new TerminatedEvent());
    }
  }

  // ─── DAP: configurationDoneRequest ────────────────────────────────────────

  protected configurationDoneRequest(
    response: DebugProtocol.ConfigurationDoneResponse,
    _args: DebugProtocol.ConfigurationDoneArguments
  ): void {
    this.sendResponse(response);
    // Signal that the debuggee is now stopped at entry
    this.sendStopped('entry', REVM_THREAD_ID);
  }

  // ─── DAP: setBreakpointsRequest ───────────────────────────────────────────

  protected async setBreakpointsRequest(
    response: DebugProtocol.SetBreakpointsResponse,
    args: DebugProtocol.SetBreakpointsArguments
  ): Promise<void> {
    const file = args.source.path ?? '';
    const requestedLines = args.breakpoints?.map(b => b.line) ?? [];

    // Clear old breakpoints for this file
    this.revmConnector?.clearBreakpoints(file);
    this.pvmConnector?.clearBreakpoints(file);
    this.breakpointMap.delete(file);

    const resolvedBreakpoints: DebugProtocol.Breakpoint[] = [];

    for (const line of requestedLines) {
      let revmBp: ReviveBreakpoint | undefined;
      let pvmBp: ReviveBreakpoint | undefined;

      if (this.revmConnector && (this.currentBackend === 'REVM' || this.currentBackend === 'BOTH')) {
        revmBp = await this.revmConnector.setBreakpoint(file, line);
      }
      if (this.pvmConnector && (this.currentBackend === 'PVM' || this.currentBackend === 'BOTH')) {
        pvmBp = await this.pvmConnector.setBreakpoint(file, line);
      }

      const bp = revmBp ?? pvmBp;
      if (bp) {
        resolvedBreakpoints.push(new Breakpoint(bp.verified, bp.line, 0, new Source(
          path.basename(file), file
        )));
      }
    }

    this.breakpointMap.set(file, resolvedBreakpoints.map((b, i) => ({
      id: this.nextBreakpointId++,
      verified: b.verified ?? false,
      file,
      line: requestedLines[i]
    })));

    response.body = { breakpoints: resolvedBreakpoints };
    this.sendResponse(response);
  }

  // ─── DAP: threadsRequest ──────────────────────────────────────────────────

  protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
    const threads: Thread[] = [];
    if (this.currentBackend === 'REVM' || this.currentBackend === 'BOTH') {
      threads.push(new Thread(REVM_THREAD_ID, 'REVM (EVM)'));
    }
    if (this.currentBackend === 'PVM' || this.currentBackend === 'BOTH') {
      threads.push(new Thread(PVM_THREAD_ID, 'PolkaVM (RISC-V)'));
    }
    response.body = { threads };
    this.sendResponse(response);
  }

  // ─── DAP: stackTraceRequest ───────────────────────────────────────────────

  protected async stackTraceRequest(
    response: DebugProtocol.StackTraceResponse,
    args: DebugProtocol.StackTraceArguments
  ): Promise<void> {
    const isRevm = args.threadId === REVM_THREAD_ID;
    const connector = isRevm ? this.revmConnector : this.pvmConnector;
    const frames = await (connector?.getCallStack() ?? Promise.resolve([]));

    response.body = {
      stackFrames: frames.map(f => {
        const src = f.source
          ? new Source(path.basename(f.source), f.source)
          : undefined;
        return new StackFrame(f.id, f.name, src, f.line, f.column);
      }),
      totalFrames: frames.length
    };
    this.sendResponse(response);
  }

  // ─── DAP: scopesRequest ───────────────────────────────────────────────────

  protected scopesRequest(
    response: DebugProtocol.ScopesResponse,
    args: DebugProtocol.ScopesArguments
  ): void {
    response.body = {
      scopes: [
        new Scope('Execution', args.frameId * 10 + 1, false),
        new Scope('Weight Metrics', args.frameId * 10 + 2, false),
        new Scope('EVM Stack', args.frameId * 10 + 3, false),
      ]
    };
    this.sendResponse(response);
  }

  // ─── DAP: variablesRequest ────────────────────────────────────────────────

  protected async variablesRequest(
    response: DebugProtocol.VariablesResponse,
    args: DebugProtocol.VariablesArguments
  ): Promise<void> {
    const scopeType = args.variablesReference % 10;
    const frameId = Math.floor(args.variablesReference / 10);

    let variables: Variable[] = [];

    if (scopeType === 2) {
      // Weight Metrics scope
      const snap = this.weightMeter.getSnapshot();
      const warnings = this.weightMeter.getWarnings();
      variables = [
        new Variable('EVM Gas Used', snap.formatted.gasUsed, 0),
        new Variable('EVM Gas Limit', snap.formatted.gasLimit, 0),
        new Variable('EVM Gas %', `${snap.gasPercent.toFixed(1)}%`, 0),
        new Variable('PVM ref_time', snap.formatted.refTime, 0),
        new Variable('PVM proof_size', snap.formatted.proofSize, 0),
        new Variable('PVM storage_deposit', snap.formatted.storageDeposit, 0),
        new Variable('PVM Estimated Fee', snap.formatted.estimatedFee, 0),
        new Variable('Warnings', warnings.length > 0 ? warnings.join('; ') : 'none', 0),
      ];
    } else if (scopeType === 1) {
      // Execution scope — get from active connector
      const revmVars = this.revmConnector
        ? await this.revmConnector.getVariables(frameId)
        : [];
      const pvmVars = this.pvmConnector
        ? await this.pvmConnector.getVariables(frameId)
        : [];
      variables = [
        ...revmVars.map(v => new Variable(`[REVM] ${v.name}`, v.value, v.variablesReference)),
        ...pvmVars.map(v => new Variable(`[PVM] ${v.name}`, v.value, v.variablesReference))
      ];
    } else {
      // EVM Stack — REVM specific
      const revmVars = this.revmConnector
        ? await this.revmConnector.getVariables(frameId)
        : [];
      variables = revmVars.map(v => new Variable(v.name, v.value, 0));
    }

    response.body = { variables };
    this.sendResponse(response);
  }

  // ─── DAP: nextRequest (Step Over) ─────────────────────────────────────────

  protected async nextRequest(
    response: DebugProtocol.NextResponse,
    args: DebugProtocol.NextArguments
  ): Promise<void> {
    this.sendResponse(response);
    const isRevm = args.threadId === REVM_THREAD_ID;
    const connector = isRevm ? this.revmConnector : this.pvmConnector;
    const threadId = isRevm ? REVM_THREAD_ID : PVM_THREAD_ID;

    if (!connector) {
      this.sendStopped('step', threadId);
      return;
    }

    const result = await connector.step();
    if (result.metrics) {
      if (isRevm) {
        this.weightMeter.updateFromRevmMetrics(result.metrics);
      } else {
        this.weightMeter.updateFromPvmMetrics(result.metrics);
      }
    }
    this.sendStopped(result.stopped ? 'step' : 'exit', threadId);
  }

  // ─── DAP: stepInRequest ───────────────────────────────────────────────────

  protected async stepInRequest(
    response: DebugProtocol.StepInResponse,
    args: DebugProtocol.StepInArguments
  ): Promise<void> {
    this.sendResponse(response);
    const isRevm = args.threadId === REVM_THREAD_ID;
    const connector = isRevm ? this.revmConnector : this.pvmConnector;
    const threadId = isRevm ? REVM_THREAD_ID : PVM_THREAD_ID;

    const result = await (connector?.stepIn() ?? Promise.resolve({ stopped: true, reason: 'exit' as const }));
    this.sendStopped('step', threadId);
  }

  // ─── DAP: stepOutRequest ──────────────────────────────────────────────────

  protected async stepOutRequest(
    response: DebugProtocol.StepOutResponse,
    args: DebugProtocol.StepOutArguments
  ): Promise<void> {
    this.sendResponse(response);
    const isRevm = args.threadId === REVM_THREAD_ID;
    const connector = isRevm ? this.revmConnector : this.pvmConnector;
    const threadId = isRevm ? REVM_THREAD_ID : PVM_THREAD_ID;

    await (connector?.stepOut() ?? Promise.resolve({ stopped: true, reason: 'exit' as const }));
    this.sendStopped('step', threadId);
  }

  // ─── DAP: continueRequest ─────────────────────────────────────────────────

  protected async continueRequest(
    response: DebugProtocol.ContinueResponse,
    args: DebugProtocol.ContinueArguments
  ): Promise<void> {
    response.body = { allThreadsContinued: false };
    this.sendResponse(response);

    const isRevm = args.threadId === REVM_THREAD_ID;
    const connector = isRevm ? this.revmConnector : this.pvmConnector;
    const threadId = isRevm ? REVM_THREAD_ID : PVM_THREAD_ID;

    await (connector?.continue() ?? Promise.resolve());
    this.sendStopped('breakpoint', threadId);
  }

  // ─── DAP: evaluateRequest ─────────────────────────────────────────────────

  protected async evaluateRequest(
    response: DebugProtocol.EvaluateResponse,
    args: DebugProtocol.EvaluateArguments
  ): Promise<void> {
    const expr = args.expression.trim().toLowerCase();

    if (expr === 'metrics' || expr === 'weight') {
      const snap = this.weightMeter.getSnapshot();
      const report = this.weightMeter.generateComparisonReport();
      response.body = {
        result: [
          `EVM Gas: ${snap.formatted.gasUsed} / ${snap.formatted.gasLimit} (${snap.gasPercent.toFixed(1)}%)`,
          `PVM ref_time: ${snap.formatted.refTime}`,
          `PVM proof_size: ${snap.formatted.proofSize}`,
          `Storage deposit: ${snap.formatted.storageDeposit}`,
          `Verdict: ${report.verdict}`
        ].join('\n'),
        variablesReference: 0
      };
    } else {
      response.body = {
        result: `Cannot evaluate '${args.expression}' — use the Variables panel to inspect state`,
        variablesReference: 0
      };
    }
    this.sendResponse(response);
  }

  // ─── DAP: customRequest ───────────────────────────────────────────────────

  protected customRequest(
    command: string,
    response: DebugProtocol.Response,
    args: Record<string, unknown>
  ): void {
    switch (command) {
      case 'switchBackend': {
        const newBackend = args.backend as BackendType;
        this.currentBackend = newBackend;
        this.log(`Backend switched to: ${newBackend}`);
        this.sendEvent(new OutputEvent(`[ReviveDualDebugger] Backend switched to ${newBackend}\n`, 'important'));
        break;
      }
      case 'getWeightSnapshot': {
        response.body = this.weightMeter.getSnapshot();
        break;
      }
      case 'getComparisonReport': {
        response.body = this.weightMeter.generateComparisonReport();
        break;
      }
      case 'resetMetrics': {
        this.weightMeter.reset();
        this.log('Metrics reset');
        break;
      }
      case 'getSyscallTrace': {
        response.body = { trace: this.pvmConnector?.getSyscallTrace() ?? [] };
        break;
      }
    }
    this.sendResponse(response);
  }

  // ─── DAP: terminateRequest ────────────────────────────────────────────────

  protected async terminateRequest(
    response: DebugProtocol.TerminateResponse,
    _args: DebugProtocol.TerminateArguments
  ): Promise<void> {
    await this.cleanupSession();
    this.sendResponse(response);
    this.sendEvent(new TerminatedEvent());
  }

  protected async disconnectRequest(
    response: DebugProtocol.DisconnectResponse,
    _args: DebugProtocol.DisconnectArguments
  ): Promise<void> {
    await this.cleanupSession();
    this.sendResponse(response);
  }

  // ─── Internal Initialization ───────────────────────────────────────────────

  private async startNode(): Promise<void> {
    const args = this.launchArgs!;
    const orchConfig: NodeOrchestratorConfig = {
      nodePath: args.nodePath,
      ethRpcPath: args.ethRpcPath,
      ethRpcUrl: args.ethRpcUrl,
      substrateUrl: args.substrateUrl,
      enableStrace: args.backend === 'PVM' || args.backend === 'BOTH',
      trace: args.trace
    };

    this.orchestrator = new NodeOrchestrator(orchConfig);

    this.orchestrator.on('log', (line) => {
      const category =
        line.level === 'error' ? 'stderr' :
        line.level === 'warn' ? 'important' : 'stdout';
      this.sendEvent(new OutputEvent(`[${line.source}] ${line.message}\n`, category));
    });

    this.orchestrator.on('error', (err: Error) => {
      this.sendEvent(new OutputEvent(`[node] ERROR: ${err.message}\n`, 'stderr'));
    });

    await this.orchestrator.start();
    this.log('Local dev node is running');
  }

  private async initializeConnectors(): Promise<void> {
    const args = this.launchArgs!;
    const config: DebugConfig = {
      contractFile: args.contractFile,
      backend: args.backend,
      ethRpcUrl: args.ethRpcUrl,
      substrateUrl: args.substrateUrl,
      resolcPath: args.resolcPath,
      solcPath: args.solcPath,
      constructorArgs: args.constructorArgs,
      trace: args.trace
    };

    if (args.backend === 'REVM' || args.backend === 'BOTH') {
      this.revmConnector = new RevmConnector(this.sourceMapper);
      this.revmConnector.onMetricsUpdate(m => {
        this.weightMeter.updateFromRevmMetrics(m);
        this.sendWeightUpdate();
      });
      this.revmConnector.onExecutionEvent(e => {
        if (e.type === 'breakpointHit') {
          this.sendStopped('breakpoint', REVM_THREAD_ID);
        }
      });
      await this.revmConnector.connect(config);
      this.log('REVM connector ready');
    }

    if (args.backend === 'PVM' || args.backend === 'BOTH') {
      if (!this.orchestrator) {
        throw new Error('NodeOrchestrator required for PVM backend');
      }
      this.pvmConnector = new PvmConnector(this.sourceMapper, this.orchestrator);
      this.pvmConnector.onMetricsUpdate(m => {
        this.weightMeter.updateFromPvmMetrics(m);
        this.sendWeightUpdate();
      });
      this.pvmConnector.onExecutionEvent(e => {
        if (e.type === 'breakpointHit') {
          this.sendStopped('breakpoint', PVM_THREAD_ID);
        }
        if (e.type === 'contractDeployed') {
          this.log(`Contract deployed at: ${e.data['address']}`);
        }
      });
      await this.pvmConnector.connect(config);
      this.log('PVM connector ready');
    }
  }

  private async compileAndDeploy(): Promise<void> {
    const args = this.launchArgs!;
    this.deployer = new ContractDeployer({
      solcPath: args.solcPath,
      resolcPath: args.resolcPath,
      backend: args.backend,
      ethRpcUrl: args.ethRpcUrl
    });

    this.log(`Compiling: ${path.basename(args.contractFile)}`);
    const artifacts = await this.deployer.compile(args.contractFile);

    if (artifacts.evm && this.revmConnector) {
      // Load source map into SourceMapper
      const fileMap = new Map<number, string>([[0, args.contractFile]]);
      this.sourceMapper.loadFromArtifact(artifacts.evm, fileMap);
      this.log('EVM source map loaded');
    }

    this.log('Deployment complete — ready to debug');
    this.log('');
    this.log('Available backends:');
    if (this.revmConnector) this.log('  [REVM] EVM opcodes via debug_traceTransaction');
    if (this.pvmConnector) this.log('  [PVM]  PolkaVM syscalls via strace log parsing');
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  private sendStopped(reason: string, threadId: number): void {
    this.stoppedThread = threadId;
    this.sendEvent(new StoppedEvent(reason, threadId));
  }

  private sendWeightUpdate(): void {
    const snap = this.weightMeter.getSnapshot();
    this.sendEvent(new OutputEvent(
      `[Revive Meter] Gas: ${snap.formatted.gasUsed} | ref_time: ${snap.formatted.refTime} | proof_size: ${snap.formatted.proofSize}\n`,
      'telemetry'
    ));
  }

  private log(message: string): void {
    this.sendEvent(new OutputEvent(`${message}\n`));
  }

  private async cleanupSession(): Promise<void> {
    await this.revmConnector?.disconnect();
    await this.pvmConnector?.disconnect();
    await this.orchestrator?.stop();
  }
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

// When run as a standalone process (not imported), start the debug adapter
if (require.main === module) {
  const session = new ReviveDebugSession();
  session.start(process.stdin, process.stdout);
}
