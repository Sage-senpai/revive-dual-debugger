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
import { BackendConnector, BackendType, DebugConfig, ExecutionEvent, ExecutionMetrics, ReviveBreakpoint, ReviveStackFrame, ReviveVariable, SyscallStep } from './backendConnector';
import { SourceMapper } from './sourceMapper';
import { NodeOrchestrator } from './nodeOrchestrator';
export declare class PvmConnector extends EventEmitter implements BackendConnector {
    readonly backendType: BackendType;
    private config;
    private sourceMapper;
    private orchestrator;
    private straceParser;
    private breakpoints;
    private syscallTrace;
    private callStack;
    private currentSyscallIndex;
    private currentMetrics;
    private metricsCallbacks;
    private eventCallbacks;
    private nextBreakpointId;
    private ws;
    private rpcId;
    private pendingRpcCalls;
    private stepResolvers;
    private isRunning;
    private isPaused;
    private latestRefTime;
    private latestProofSize;
    private latestStorageDeposit;
    private contractAddress;
    constructor(sourceMapper: SourceMapper, orchestrator: NodeOrchestrator);
    connect(config: DebugConfig): Promise<void>;
    disconnect(): Promise<void>;
    setBreakpoint(file: string, line: number): Promise<ReviveBreakpoint>;
    clearBreakpoints(file: string): Promise<void>;
    step(): Promise<import('./backendConnector').StepResult>;
    stepIn(): Promise<import('./backendConnector').StepResult>;
    stepOut(): Promise<import('./backendConnector').StepResult>;
    continue(): Promise<void>;
    pause(): Promise<void>;
    getCallStack(): Promise<ReviveStackFrame[]>;
    getVariables(frameId: number): Promise<ReviveVariable[]>;
    getCurrentMetrics(): ExecutionMetrics;
    onMetricsUpdate(cb: (metrics: ExecutionMetrics) => void): void;
    onExecutionEvent(cb: (event: ExecutionEvent) => void): void;
    private processStraceLine;
    /** Try to resolve a syscall to a Solidity source location. */
    private resolveSyscallLocation;
    private updateMetrics;
    private buildStepResult;
    private connectWebSocket;
    private subscribeToRuntimeEvents;
    private wsSend;
    private isBreakpointAt;
    private notifyMetrics;
    private emitExecutionEvent;
    getSyscallTrace(): SyscallStep[];
    getContractAddress(): string | null;
    resetTrace(): void;
}
//# sourceMappingURL=pvmConnector.d.ts.map