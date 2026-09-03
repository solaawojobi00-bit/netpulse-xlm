export interface LedgerSample {
  sequence: number;
  closedAt: string;
  closeTimeSeconds: number | null;
  successfulTransactionCount: number;
  failedTransactionCount: number;
  operationCount: number;
  txSetOperationCount: number;
  baseFeeInStroops: number;
  maxTxSetSize: number;
}

export interface FeeSnapshot {
  fetchedAt: string;
  lastLedgerBaseFee: number;
  ledgerCapacityUsage: number;
  feeChargedP10: number;
  feeChargedP50: number;
  feeChargedP90: number;
  feeChargedP99: number;
}

export interface HealthResponse {
  status: "ok" | "stale";
  lastUpdated: string | null;
  secondsSinceLastUpdate: number | null;
  horizonUrl?: string;
  ledgerCloseTime: {
    currentSeconds: number | null;
    averageSeconds: number | null;
  };
  fees: {
    baseFeeStroops: number | null;
    p10: number | null;
    p50: number | null;
    p90: number | null;
    p99: number | null;
  };
  congestion: {
    ledgerCapacityUsage: number | null;
    band: "low" | "moderate" | "high" | "unknown";
    alertThreshold?: number;
  };
  throughput: {
    operationsPerSecond: number | null;
    transactionsPerSecond: number | null;
  };
  recentLedgerCount: number;
}

export interface RecentLedgersResponse {
  ledgers: LedgerSample[];
}

export interface RecentFeesResponse {
  snapshots: FeeSnapshot[];
}

export interface SorobanSample {
  timestamp: string;
  invocationsCount: number;
  successfulCount: number;
  failedCount: number;
}

export interface SorobanMetricsResponse {
  network: string;
  invocationsPerSecond: number | null;
  recentInvocationsTotal: number;
  successfulInvocationsTotal: number;
  failedInvocationsTotal: number;
  samples: SorobanSample[];
}

/**
 * One poll's worth of operation types. Stored alongside the Soroban samples
 * rather than instead of them — the same fetch feeds both.
 */
export interface OperationTypeSample {
  timestamp: string;
  /** Operations seen in this poll, including any folded into `other`. */
  total: number;
  /** Raw Horizon type string to count. Bounded — see MAX_TRACKED_TYPES. */
  counts: Record<string, number>;
}

export interface OperationTypeCount {
  /**
   * The raw Horizon type string, or the grouping bucket. Never match on this
   * to detect the bucket — read `isOther`, which cannot collide with a real
   * type Horizon might introduce.
   */
  type: string;
  count: number;
  /** Fraction of `totalOperations`, 0-1, rounded to four places. */
  share: number;
  /** True for the single row standing in for the grouped long tail. */
  isOther: boolean;
}

export interface OperationBreakdownResponse {
  network: string;
  /** How many polls the breakdown covers. */
  sampleCount: number;
  /**
   * Seconds between the first and last sample. Null with fewer than two
   * samples, when there is no span to report. The chart uses this to say the
   * figures are a sample over a window rather than an all-time total.
   */
  windowSeconds: number | null;
  totalOperations: number;
  /** Distinct types seen before the long tail was grouped. */
  distinctTypes: number;
  /** Sorted by count descending, with any `other` bucket last. */
  breakdown: OperationTypeCount[];
}
