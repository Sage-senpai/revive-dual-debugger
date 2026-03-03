/**
 * WeightMeter — tracks and compares Substrate Weight vs EVM Gas across
 * execution steps. Provides formatted snapshots for the Dual-Trace UI.
 *
 * Polkadot fee formula:
 *   Total Fee = max(ref_time_weight, proof_size_weight) × Multiplier + Length Fee
 */

import { ExecutionMetrics, formatGas, formatWeight } from './backendConnector';

// ─── Snapshot ─────────────────────────────────────────────────────────────────

export interface MetricsSnapshot {
  // REVM
  gasUsed: bigint;
  gasLimit: bigint;
  gasPercent: number;

  // PVM
  refTime: bigint;
  proofSize: bigint;
  storageDeposit: bigint;
  estimatedFee: bigint;
  refTimePercent: number;
  proofSizePercent: number;

  // Formatted strings for display
  formatted: {
    gasUsed: string;
    gasLimit: string;
    refTime: string;
    proofSize: string;
    storageDeposit: string;
    estimatedFee: string;
  };

  // Step counts
  opcodeCount: number;
  syscallCount: number;
  timestamp: number;
}

// ─── Historical Data Point ────────────────────────────────────────────────────

export interface MetricsDataPoint {
  step: number;
  gasUsed: number;     // as Number for charting
  refTime: number;
  proofSize: number;
  label?: string;      // e.g. opcode name or syscall name
}

// ─── Weight Meter ─────────────────────────────────────────────────────────────

export class WeightMeter {
  // REVM state
  private gasUsed = 0n;
  private gasLimit = 30_000_000n;   // default block gas limit

  // PVM state
  private refTime = 0n;
  private proofSize = 0n;
  private storageDeposit = 0n;

  // Limits (configurable, sensible defaults for local dev)
  private refTimeLimit = 500_000_000_000n;    // 500ms block ref_time
  private proofSizeLimit = 5_242_880n;         // 5 MB proof_size

  // Fee multiplier (1 = no adjustment, on-chain this is dynamic)
  private feeMultiplier = 1n;
  private lengthFee = 0n;

  // History for charting
  private history: MetricsDataPoint[] = [];
  private stepCounter = 0;

  // ─── Update Methods ──────────────────────────────────────────────────────────

  updateFromRevmMetrics(metrics: Partial<ExecutionMetrics>): void {
    if (metrics.gasUsed !== undefined) {
      this.gasUsed = metrics.gasUsed;
    }
    if (metrics.gasLimit !== undefined) {
      this.gasLimit = metrics.gasLimit;
    }

    const lastOpcode = metrics.opcodeTrace?.at(-1);
    this.history.push({
      step: this.stepCounter++,
      gasUsed: Number(this.gasUsed),
      refTime: Number(this.refTime),
      proofSize: Number(this.proofSize),
      label: lastOpcode?.op
    });
  }

  updateFromPvmMetrics(metrics: Partial<ExecutionMetrics>): void {
    if (metrics.refTime !== undefined) {
      this.refTime = metrics.refTime;
    }
    if (metrics.proofSize !== undefined) {
      this.proofSize = metrics.proofSize;
    }
    if (metrics.storageDeposit !== undefined) {
      this.storageDeposit = metrics.storageDeposit;
    }

    const lastSyscall = metrics.syscallTrace?.at(-1);
    this.history.push({
      step: this.stepCounter++,
      gasUsed: Number(this.gasUsed),
      refTime: Number(this.refTime),
      proofSize: Number(this.proofSize),
      label: lastSyscall?.name
    });
  }

  // ─── Snapshot ────────────────────────────────────────────────────────────────

  getSnapshot(): MetricsSnapshot {
    const gasPercent =
      this.gasLimit > 0n
        ? Math.min(100, Number((this.gasUsed * 100n) / this.gasLimit))
        : 0;

    const refTimePercent =
      this.refTimeLimit > 0n
        ? Math.min(100, Number((this.refTime * 100n) / this.refTimeLimit))
        : 0;

    const proofSizePercent =
      this.proofSizeLimit > 0n
        ? Math.min(100, Number((this.proofSize * 100n) / this.proofSizeLimit))
        : 0;

    const dominantWeight =
      this.refTime > this.proofSize ? this.refTime : this.proofSize;
    const estimatedFee = dominantWeight * this.feeMultiplier + this.lengthFee;

    return {
      gasUsed: this.gasUsed,
      gasLimit: this.gasLimit,
      gasPercent,
      refTime: this.refTime,
      proofSize: this.proofSize,
      storageDeposit: this.storageDeposit,
      estimatedFee,
      refTimePercent,
      proofSizePercent,
      formatted: {
        gasUsed: formatGas(this.gasUsed),
        gasLimit: formatGas(this.gasLimit),
        refTime: formatWeight(this.refTime),
        proofSize: formatWeight(this.proofSize),
        storageDeposit: formatWeight(this.storageDeposit),
        estimatedFee: formatWeight(estimatedFee)
      },
      opcodeCount: this.history.filter(h => h.refTime === 0 && h.gasUsed > 0).length,
      syscallCount: this.history.filter(h => h.refTime > 0).length,
      timestamp: Date.now()
    };
  }

  getHistory(): MetricsDataPoint[] {
    return [...this.history];
  }

  // ─── Thresholds / Warnings ───────────────────────────────────────────────────

  getWarnings(): string[] {
    const warnings: string[] = [];
    const snap = this.getSnapshot();

    if (snap.gasPercent > 80) {
      warnings.push(
        `High EVM gas usage: ${snap.formatted.gasUsed} / ${snap.formatted.gasLimit} (${snap.gasPercent.toFixed(1)}%)`
      );
    }
    if (snap.refTimePercent > 80) {
      warnings.push(
        `High ref_time: ${snap.formatted.refTime} (${snap.refTimePercent.toFixed(1)}% of block limit)`
      );
    }
    if (snap.proofSizePercent > 80) {
      warnings.push(
        `High proof_size: ${snap.formatted.proofSize} (${snap.proofSizePercent.toFixed(1)}% of block limit)`
      );
    }
    if (this.storageDeposit > 0n) {
      warnings.push(`Storage deposit locked: ${snap.formatted.storageDeposit}`);
    }

    return warnings;
  }

  // ─── Config ──────────────────────────────────────────────────────────────────

  setGasLimit(limit: bigint): void {
    this.gasLimit = limit;
  }

  setRefTimeLimit(limit: bigint): void {
    this.refTimeLimit = limit;
  }

  setProofSizeLimit(limit: bigint): void {
    this.proofSizeLimit = limit;
  }

  setFeeMultiplier(multiplier: bigint): void {
    this.feeMultiplier = multiplier;
  }

  reset(): void {
    this.gasUsed = 0n;
    this.refTime = 0n;
    this.proofSize = 0n;
    this.storageDeposit = 0n;
    this.history = [];
    this.stepCounter = 0;
  }

  // ─── Comparison Report ───────────────────────────────────────────────────────

  generateComparisonReport(): ComparisonReport {
    const snap = this.getSnapshot();
    return {
      summary: {
        evmGasUsed: snap.formatted.gasUsed,
        evmGasPercent: snap.gasPercent,
        pvmRefTime: snap.formatted.refTime,
        pvmProofSize: snap.formatted.proofSize,
        pvmEstimatedFee: snap.formatted.estimatedFee,
        storageDeposit: snap.formatted.storageDeposit
      },
      verdict: this.getVerdict(snap),
      warnings: this.getWarnings(),
      recommendation: this.getRecommendation(snap)
    };
  }

  private getVerdict(snap: MetricsSnapshot): string {
    if (snap.gasPercent > snap.refTimePercent && snap.gasPercent > snap.proofSizePercent) {
      return 'EVM (REVM) is the bottleneck — high gas consumption relative to block limit';
    }
    if (snap.proofSizePercent > snap.refTimePercent) {
      return 'PolkaVM proof_size is the bottleneck — consider reducing storage access';
    }
    return 'PolkaVM ref_time is the bottleneck — computation-heavy contract';
  }

  private getRecommendation(snap: MetricsSnapshot): string {
    if (snap.proofSizePercent > 50) {
      return 'Reduce storage reads (seal_get_storage calls) — each read increases proof_size';
    }
    if (snap.refTimePercent > 50) {
      return 'Consider caching computed values in storage — reduce redundant computation';
    }
    if (snap.gasPercent > 50) {
      return 'Profile EVM opcodes — SLOAD/SSTORE and 256-bit arithmetic are most expensive';
    }
    return 'Execution appears efficient on both backends';
  }
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
