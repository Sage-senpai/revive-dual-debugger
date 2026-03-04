/**
 * DualTracePanel — VS Code WebviewPanel showing the REVM opcode trace
 * side-by-side with the PVM syscall trace, plus the Weight Meter dashboard.
 *
 * Updates in real-time as the debug session advances.
 */
import * as vscode from 'vscode';
import { ExecutionMetrics } from '../backendConnector';
import { WeightMeter } from '../weightMeter';
export type WebviewMessage = {
    type: 'updateRevm';
    trace: SerializableOpcodeStep[];
    metrics: SerializableMetrics;
} | {
    type: 'updatePvm';
    trace: SerializableSyscallStep[];
    metrics: SerializableMetrics;
} | {
    type: 'updateSnapshot';
    snapshot: SerializableSnapshot;
} | {
    type: 'clearTraces';
} | {
    type: 'setBackend';
    backend: string;
} | {
    type: 'highlight';
    backend: 'revm' | 'pvm';
    index: number;
};
interface SerializableOpcodeStep {
    pc: number;
    op: string;
    gasCost: string;
    gasRemaining: string;
    depth: number;
    stack: string[];
    file?: string;
    line?: number;
}
interface SerializableSyscallStep {
    address: string;
    name: string;
    args: string;
    result?: string;
    isEntry: boolean;
    file?: string;
    line?: number;
}
interface SerializableMetrics {
    gasUsed: string;
    gasLimit: string;
    refTime: string;
    proofSize: string;
    storageDeposit: string;
}
interface SerializableSnapshot {
    gasUsed: string;
    gasPercent: number;
    refTime: string;
    proofSize: string;
    refTimePercent: number;
    proofSizePercent: number;
    storageDeposit: string;
    estimatedFee: string;
    warnings: string[];
    verdict?: string;
}
export declare class DualTracePanel {
    private static instance;
    private panel;
    private weightMeter;
    private extensionUri;
    private revmTrace;
    private pvmTrace;
    private constructor();
    static createOrShow(extensionUri: vscode.Uri, weightMeter: WeightMeter): DualTracePanel;
    static getInstance(): DualTracePanel | undefined;
    updateRevmTrace(metrics: ExecutionMetrics): void;
    updatePvmTrace(metrics: ExecutionMetrics): void;
    clear(): void;
    highlightStep(backend: 'revm' | 'pvm', index: number): void;
    private sendSnapshot;
    private serializeMetrics;
    private postMessage;
    private handleJumpToSource;
    private handleCopyTrace;
    private getHtml;
    private getInlineHtml;
    dispose(): void;
}
export declare function getDualTraceHtml(): string;
export {};
//# sourceMappingURL=dualTracePanel.d.ts.map