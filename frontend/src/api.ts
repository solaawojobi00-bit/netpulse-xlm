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

export type Network = "mainnet" | "testnet";

export async function fetchHealth(network: Network = "mainnet"): Promise<HealthResponse> {
  const res = await fetch(`/api/health?network=${network}`);
  if (!res.ok) throw new Error(`GET /api/health failed: ${res.status}`);
  return (await res.json()) as HealthResponse;
}

export async function fetchRecentLedgers(
  network: Network = "mainnet",
): Promise<LedgerSample[]> {
  const res = await fetch(`/api/ledgers/recent?network=${network}`);
  if (!res.ok) throw new Error(`GET /api/ledgers/recent failed: ${res.status}`);
  const body = (await res.json()) as { ledgers: LedgerSample[] };
  return body.ledgers;
}

export interface RecentFeesResponse {
  snapshots: FeeSnapshot[];
}

export async function fetchRecentFees(
  network: Network = "mainnet",
): Promise<FeeSnapshot[]> {
  const res = await fetch(`/api/fees/recent?network=${network}`);
  if (!res.ok) throw new Error(`GET /api/fees/recent failed: ${res.status}`);
  const body = (await res.json()) as RecentFeesResponse;
  return body.snapshots;
}

export interface HistoryPoint {
  timestamp: string;
  closeTimeSeconds: number | null;
  congestionUsage: number | null;
  operations: number;
  transactions: number;
  p50Fee: number | null;
  p90Fee: number | null;
}

export interface HistoryResponse {
  network: string;
  range: string;
  points: HistoryPoint[];
}

/*
 * The ranges the backend actually understands. See the range parsing in
 * backend/src/index.ts, which maps anything else onto 24h — typing it here
 * keeps a nonsense range from reaching the request in the first place.
 */
export const HISTORY_RANGES = ["6h", "12h", "24h"] as const;

export type HistoryRange = (typeof HISTORY_RANGES)[number];

export async function fetchHistory(
  network: Network = "mainnet",
  range: HistoryRange = "24h",
): Promise<HistoryResponse> {
  const res = await fetch(`/api/history?network=${network}&range=${range}`);
  if (!res.ok) throw new Error(`GET /api/history failed: ${res.status}`);
  return (await res.json()) as HistoryResponse;
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

export async function fetchSorobanMetrics(
  network: Network = "mainnet",
): Promise<SorobanMetricsResponse> {
  const res = await fetch(`/api/soroban?network=${network}`);
  if (!res.ok) throw new Error(`GET /api/soroban failed: ${res.status}`);
  return (await res.json()) as SorobanMetricsResponse;
}
