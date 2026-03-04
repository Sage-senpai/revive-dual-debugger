/**
 * StraceParser — parses runtime::revive::strace log lines emitted by
 * the substrate node when running with:
 *   RUST_LOG="runtime::revive::strace=trace,runtime::revive=debug"
 *
 * Log formats observed in pallet-revive:
 *
 *   CALL ENTRY:
 *     runtime::revive::strace: [0xADDR] seal_get_storage(key: 0x1234...)
 *     runtime::revive::strace: [0xADDR] seal_call(callee: 0x..., value: 0, ...)
 *
 *   CALL EXIT:
 *     runtime::revive::strace: [0xADDR] -> Result: Ok(data: 0x...)
 *     runtime::revive::strace: [0xADDR] -> Result: Err(module error: ...)
 *
 *   WEIGHT LOG:
 *     runtime::revive: weight consumed: ref_time: 12345, proof_size: 6789
 *
 *   DEPLOY LOG:
 *     runtime::revive: deployed contract at 0xADDR
 */
import { SyscallStep } from './backendConnector';
export type StraceEventType = 'callEntry' | 'callExit' | 'weight' | 'deploy' | 'unknown';
export interface StraceCallEntry {
    type: 'callEntry';
    address: string;
    name: string;
    args: string;
    parsedArgs: Record<string, string>;
    raw: string;
}
export interface StraceCallExit {
    type: 'callExit';
    address: string;
    status: 'Ok' | 'Err';
    data: string;
    raw: string;
}
export interface StraceWeight {
    type: 'weight';
    refTime: bigint;
    proofSize: bigint;
    storageDeposit?: bigint;
    raw: string;
}
export interface StraceDeploy {
    type: 'deploy';
    contractAddress: string;
    raw: string;
}
export interface StraceUnknown {
    type: 'unknown';
    raw: string;
}
export type StraceEvent = StraceCallEntry | StraceCallExit | StraceWeight | StraceDeploy | StraceUnknown;
export declare class StraceParser {
    private callDepth;
    private stepCounter;
    /** Parse a single log line. Returns null if the line is not strace-related. */
    parseLine(line: string): StraceEvent | null;
    /** Convert a StraceCallEntry into a SyscallStep for the UI. */
    toSyscallStep(entry: StraceCallEntry): SyscallStep;
    /** Convert a StraceCallExit into a SyscallStep return for the UI. */
    toSyscallReturn(exit: StraceCallExit): SyscallStep;
    reset(): void;
    get currentDepth(): number;
}
/**
 * Known pallet-revive host functions (UAPI syscalls).
 * Used to annotate traces with human-readable descriptions.
 */
export declare const HOST_FUNCTIONS: Record<string, string>;
/** Get human-readable description for a host function name. */
export declare function describeHostFunction(name: string): string;
//# sourceMappingURL=straceParser.d.ts.map