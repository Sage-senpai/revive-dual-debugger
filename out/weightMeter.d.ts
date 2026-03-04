/**
 * WeightMeter — tracks and compares Substrate Weight vs EVM Gas across
 * execution steps. Provides formatted snapshots for the Dual-Trace UI.
 *
 * Polkadot fee formula:
 *   Total Fee = max(ref_time_weight, proof_size_weight) × Multiplier + Length Fee
 */
import { ExecutionMetrics } from './backendConnector';
export interface MetricsSnapshot {
    gasUsed: bigint;
    gasLimit: bigint;
    gasPercent: number;
    refTime: bigint;
    proofSize: bigint;
    storageDeposit: bigint;
    estimatedFee: bigint;
    refTimePercent: number;
    proofSizePercent: number;
    formatted: {
        gasUsed: string;
        gasLimit: string;
        refTime: string;
        proofSize: string;
        storageDeposit: string;
        estimatedFee: string;
    };
    opcodeCount: number;
    syscallCount: number;
    timestamp: number;
}
export interface MetricsDataPoint {
    step: number;
    gasUsed: number;
    refTime: number;
    proofSize: number;
    label?: string;
}
export declare class WeightMeter {
    private gasUsed;
    private gasLimit;
    private refTime;
    private proofSize;
    private storageDeposit;
    private refTimeLimit;
    private proofSizeLimit;
    private feeMultiplier;
    private lengthFee;
    private history;
    private stepCounter;
    updateFromRevmMetrics(metrics: Partial<ExecutionMetrics>): void;
    updateFromPvmMetrics(metrics: Partial<ExecutionMetrics>): void;
    getSnapshot(): MetricsSnapshot;
    getHistory(): MetricsDataPoint[];
    getWarnings(): string[];
    setGasLimit(limit: bigint): void;
    setRefTimeLimit(limit: bigint): void;
    setProofSizeLimit(limit: bigint): void;
    setFeeMultiplier(multiplier: bigint): void;
    reset(): void;
    generateComparisonReport(): ComparisonReport;
    private getVerdict;
    private getRecommendation;
}
export interface ComparisonReport {
    summary: {
        evmGasUsed: string;
        evmGasPercent: number;
        pvmRefTime: string;
        pvmProofSize: string;
        pvmEstimatedFee: string;
        storageDeposit: string;
    };
    verdict: string;
    warnings: string[];
    recommendation: string;
}
//# sourceMappingURL=weightMeter.d.ts.map