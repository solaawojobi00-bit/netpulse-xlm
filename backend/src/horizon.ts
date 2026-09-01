import type { FeeSnapshot, LedgerSample } from "./types.js";

export const HORIZON_URLS = {
  mainnet: process.env.HORIZON_URL ?? "https://horizon.stellar.org",
  testnet: process.env.HORIZON_TESTNET_URL ?? "https://horizon-testnet.stellar.org",
} as const;

export type Network = keyof typeof HORIZON_URLS;

const HORIZON_URL = HORIZON_URLS.mainnet;

export interface HorizonLedgerRecord {
  paging_token?: string;
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

export function recordToSample(
  record: HorizonLedgerRecord,
  prevClosedAt?: string | null,
): LedgerSample {
  const closeTimeSeconds = prevClosedAt
    ? (new Date(record.closed_at).getTime() - new Date(prevClosedAt).getTime()) / 1000
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
}

export async function connectHorizonLedgerStream(
  horizonUrl: string,
  cursor: string,
  onLedger: (record: HorizonLedgerRecord) => void,
  signal?: AbortSignal,
): Promise<void> {
  const url = `${horizonUrl}/ledgers?cursor=${cursor}&order=asc`;
  const res = await fetch(url, {
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
    },
    signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`Horizon SSE stream failed: ${url} -> ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      const lines = part.split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ")) {
          const raw = line.slice(6).trim();
          if (raw && raw !== '"hello"') {
            try {
              const record = JSON.parse(raw) as HorizonLedgerRecord;
              if (record && record.sequence) {
                onLedger(record);
              }
            } catch {
              // Ignore non-JSON or heartbeat comments
            }
          }
        }
      }
    }
  }
}
