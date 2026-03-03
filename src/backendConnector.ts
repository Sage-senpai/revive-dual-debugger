/**
 * BackendConnector — abstraction layer over REVM and PolkaVM backends.
 * All DAP interactions route through this interface so the debug session
 * remains backend-agnostic.
 */

// ─── Execution Metrics ────────────────────────────────────────────────────────

export interface OpcodeStep {
  pc: number;
  op: string;
  gasCost: bigint;
  gasRemaining: bigint;
  depth: number;
  stack: string[];
  memory?: string;
  storage?: Record<string, string>;
  sourceLocation?: SourceLocation;
}

export interface SyscallStep {
  address: string;
  name: string;
  args: string;
  result?: string;
  isEntry: boolean;         // true = call entry, false = return
  timestamp: number;
  sourceLocation?: SourceLocation;
}

export interface ExecutionMetrics {
  // REVM / EVM
  gasUsed?: bigint;
  gasLimit?: bigint;
  gasPrice?: bigint;
  opcodeTrace?: OpcodeStep[];

  // PVM / Substrate
  refTime?: bigint;
  proofSize?: bigint;
  storageDeposit?: bigint;
  syscallTrace?: SyscallStep[];

  // Shared
  backend: BackendType;
  contractAddress?: string;
  txHash?: string;
  blockNumber?: number;
  success?: boolean;
  revertReason?: string;
}

// ─── Source Mapping ───────────────────────────────────────────────────────────

export interface SourceLocation {
  file: string;
  line: number;
  column?: number;
  length?: number;
}

// ─── Breakpoint ───────────────────────────────────────────────────────────────

export interface ReviveBreakpoint {
  id: number;
  verified: boolean;
  file: string;
  line: number;
  bytecodeOffset?: number;
}

// ─── Call Stack ───────────────────────────────────────────────────────────────

export interface ReviveStackFrame {
  id: number;
  name: string;
  source?: string;
  line?: number;
  column?: number;
  depth: number;
  contractAddress?: string;
  // REVM specific
  opcodeIndex?: number;
  // PVM specific
  syscallName?: string;
}

// ─── Variables ────────────────────────────────────────────────────────────────

export interface ReviveVariable {
  name: string;
  value: string;
  type: string;
  variablesReference: number;
}

// ─── Step Result ──────────────────────────────────────────────────────────────

export interface StepResult {
  stopped: boolean;
  reason: 'breakpoint' | 'step' | 'exception' | 'entry' | 'exit' | 'goto';
  location?: SourceLocation;
  metrics?: Partial<ExecutionMetrics>;
  message?: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

export type BackendType = 'REVM' | 'PVM' | 'BOTH';

export interface DebugConfig {
  contractFile: string;
  backend: BackendType;
  ethRpcUrl: string;
  substrateUrl: string;
  resolcPath: string;
  solcPath: string;
  constructorArgs: unknown[];
  trace: boolean;
  contractAddress?: string;
  txHash?: string;
}

// ─── BackendConnector Interface ───────────────────────────────────────────────

export interface BackendConnector {
  readonly backendType: BackendType;

  /** Connect to the execution backend. */
  connect(config: DebugConfig): Promise<void>;

  /** Disconnect and clean up resources. */
  disconnect(): Promise<void>;

  /** Register a breakpoint at source file + line. Returns resolved breakpoint. */
  setBreakpoint(file: string, line: number): Promise<ReviveBreakpoint>;

  /** Clear all breakpoints in a file. */
  clearBreakpoints(file: string): Promise<void>;

  /** Step to the next instruction/syscall. */
  step(): Promise<StepResult>;

  /** Step into a function call. */
  stepIn(): Promise<StepResult>;

  /** Step out of the current function. */
  stepOut(): Promise<StepResult>;

  /** Continue execution until the next breakpoint or end. */
  continue(): Promise<void>;

  /** Pause execution. */
  pause(): Promise<void>;

  /** Get the current call stack frames. */
  getCallStack(): Promise<ReviveStackFrame[]>;

  /** Get variables in a given stack frame. */
  getVariables(frameId: number): Promise<ReviveVariable[]>;

  /** Get the latest execution metrics snapshot. */
  getCurrentMetrics(): ExecutionMetrics;

  /** Subscribe to metric updates (streaming). */
  onMetricsUpdate(cb: (metrics: ExecutionMetrics) => void): void;

  /** Subscribe to execution events (breakpoints, exits, etc.). */
  onExecutionEvent(cb: (event: ExecutionEvent) => void): void;
}

// ─── Execution Events ─────────────────────────────────────────────────────────

export type ExecutionEventType =
  | 'breakpointHit'
  | 'stepCompleted'
  | 'contractDeployed'
  | 'transactionSent'
  | 'executionFinished'
  | 'executionFailed'
  | 'syscallEmitted'
  | 'opcodeExecuted';

export interface ExecutionEvent {
  type: ExecutionEventType;
  backend: BackendType;
  data: Record<string, unknown>;
  timestamp: number;
}

// ─── Weight Calculation Helpers ───────────────────────────────────────────────

/**
 * Polkadot fee formula:
 *   Total Fee = max(ref_time_weight, proof_size_weight) × Multiplier + Length Fee
 */
export function calculateSubstrateFee(
  refTime: bigint,
  proofSize: bigint,
  multiplier: bigint = 1n,
  lengthFee: bigint = 0n
): bigint {
  const weightFee = refTime > proofSize ? refTime : proofSize;
  return weightFee * multiplier + lengthFee;
}

/** Format a bigint weight value for display (converts to human-readable units). */
export function formatWeight(weight: bigint): string {
  if (weight === 0n) {
    return '0';
  }
  if (weight < 1_000n) {
    return `${weight} ps`;
  }
  if (weight < 1_000_000n) {
    return `${(Number(weight) / 1_000).toFixed(2)} ns`;
  }
  if (weight < 1_000_000_000n) {
    return `${(Number(weight) / 1_000_000).toFixed(2)} μs`;
  }
  return `${(Number(weight) / 1_000_000_000).toFixed(2)} ms`;
}

/** Format gas for display. */
export function formatGas(gas: bigint): string {
  if (gas < 1_000n) {
    return gas.toString();
  }
  if (gas < 1_000_000n) {
    return `${(Number(gas) / 1_000).toFixed(1)}K`;
  }
  return `${(Number(gas) / 1_000_000).toFixed(2)}M`;
}
