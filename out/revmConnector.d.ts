/**
 * RevmConnector — REVM (EVM) backend connector.
 *
 * Interfaces with the pallet-revive-eth-rpc adapter via Ethereum JSON-RPC.
 * Uses debug_traceTransaction for opcode-level execution traces,
 * mapping each opcode step back to Solidity source via solc source maps.
 */
import { EventEmitter } from 'events';
import { BackendConnector, BackendType, DebugConfig, ExecutionEvent, ExecutionMetrics, ReviveBreakpoint, ReviveStackFrame, ReviveVariable } from './backendConnector';
import { SourceMapper } from './sourceMapper';
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
export declare class RevmConnector extends EventEmitter implements BackendConnector {
    readonly backendType: BackendType;
    private client;
    private rpcId;
    private config;
    private sourceMapper;
    private breakpoints;
    private currentTrace;
    private currentStepIndex;
    private currentMetrics;
    private metricsCallbacks;
    private eventCallbacks;
    private nextBreakpointId;
    private gasLimit;
    constructor(sourceMapper: SourceMapper);
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
    /**
     * Send a transaction and capture its full opcode trace.
     * Returns the trace ready for step-through debugging.
     */
    traceTransaction(from: string, to: string | null, data: string, value?: string): Promise<string>;
    /** Load a pre-fetched trace (for replay or testing). */
    loadTrace(traceResult: DebugTraceResult, receipt: TransactionReceipt): void;
    getDefaultAccount(): Promise<string>;
    getBalance(address: string): Promise<bigint>;
    private buildStepResult;
    private buildOpcodeTrace;
    private isBreakpointAt;
    private notifyMetrics;
    private emitExecutionEvent;
    private rpcCall;
}
export {};
//# sourceMappingURL=revmConnector.d.ts.map