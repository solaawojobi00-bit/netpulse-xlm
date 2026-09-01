import type { FeeSnapshot, LedgerSample } from "./types.js";

export const HORIZON_URLS = {
  mainnet: process.env.HORIZON_URL ?? "https://horizon.stellar.org",
  testnet: process.env.HORIZON_TESTNET_URL ?? "https://horizon-testnet.stellar.org",
} as const;

export type Network = keyof typeof HORIZON_URLS;

const HORIZON_URL = HORIZON_URLS.mainnet;

interface HorizonLedgerRecord {
  sequence: number;
  closed_at: string;
  successful_transaction_count: number;
  failed_transaction_count: number;
  operation_count: number;
  tx_set_operation_count: number;
  base_fee_in_stroops: number;
  max_tx_set_size: number;
}

interface HorizonLedgersResponse {
  _embedded: {
    records: HorizonLedgerRecord[];
  };
}

interface HorizonFeeStatsResponse {
  last_ledger_base_fee: string;
  ledger_capacity_usage: string;
  fee_charged: {
    p10: string;
    p50: string;
    p90: string;
    p99: string;
  };
}

async function horizonFetch<T>(path: string, horizonUrl: string = HORIZON_URL): Promise<T> {
  const res = await fetch(`${horizonUrl}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Horizon request failed: ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

export async function fetchRecentLedgers(
  limit: number,
  horizonUrl: string = HORIZON_URL,
): Promise<LedgerSample[]> {
  const data = await horizonFetch<HorizonLedgersResponse>(
    `/ledgers?order=desc&limit=${limit}`,
    horizonUrl,
  );
  const records = data._embedded.records;

  // Horizon returns newest-first; compute close-time deltas against the
  // next-older ledger, then present oldest-first for charting.
  const chronological = [...records].reverse();

  return chronological.map((record, index): LedgerSample => {
    const previous = chronological[index - 1];
    const closeTimeSeconds = previous
      ? (new Date(record.closed_at).getTime() -
          new Date(previous.closed_at).getTime()) /
        1000
      : null;

    return {
      sequence: record.sequence,
      closedAt: record.closed_at,
      closeTimeSeconds,
      successfulTransactionCount: record.successful_transaction_count,
      failedTransactionCount: record.failed_transaction_count,
      operationCount: record.operation_count,
      txSetOperationCount: record.tx_set_operation_count,
      baseFeeInStroops: record.base_fee_in_stroops,
      maxTxSetSize: record.max_tx_set_size,
    };
  });
}

export async function fetchFeeStats(
  horizonUrl: string = HORIZON_URL,
): Promise<FeeSnapshot> {
  const data = await horizonFetch<HorizonFeeStatsResponse>("/fee_stats", horizonUrl);

  return {
    fetchedAt: new Date().toISOString(),
    lastLedgerBaseFee: Number(data.last_ledger_base_fee),
    ledgerCapacityUsage: Number(data.ledger_capacity_usage),
    feeChargedP10: Number(data.fee_charged.p10),
    feeChargedP50: Number(data.fee_charged.p50),
    feeChargedP90: Number(data.fee_charged.p90),
    feeChargedP99: Number(data.fee_charged.p99),
  };
}
