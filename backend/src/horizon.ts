import { z } from "zod";
import { logger } from "./logger.js";
import type { FeeSnapshot, LedgerSample } from "./types.js";

export const HORIZON_URLS = {
  mainnet: process.env.HORIZON_URL ?? "https://horizon.stellar.org",
  testnet: process.env.HORIZON_TESTNET_URL ?? "https://horizon-testnet.stellar.org",
} as const;

export type Network = keyof typeof HORIZON_URLS;

const HORIZON_URL = HORIZON_URLS.mainnet;

export const numericCoerce = z
  .union([z.string(), z.number()])
  .refine(
    (v) => {
      if (typeof v === "number") return !Number.isNaN(v);
      return typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v));
    },
    { message: "Expected numeric string or number" },
  )
  .transform((v) => Number(v));

export const HorizonLedgerRecordSchema = z.object({
  paging_token: z.string().optional(),
  sequence: z.number(),
  closed_at: z.string(),
  successful_transaction_count: z.number(),
  failed_transaction_count: z.number(),
  operation_count: z.number(),
  tx_set_operation_count: z.number(),
  base_fee_in_stroops: z.number(),
  max_tx_set_size: z.number(),
});

export type HorizonLedgerRecord = z.infer<typeof HorizonLedgerRecordSchema>;

export const HorizonLedgersResponseSchema = z.object({
  _embedded: z.object({
    records: z.array(HorizonLedgerRecordSchema),
  }),
});

export type HorizonLedgersResponse = z.infer<typeof HorizonLedgersResponseSchema>;

export const HorizonFeeStatsResponseSchema = z.object({
  last_ledger_base_fee: numericCoerce,
  ledger_capacity_usage: numericCoerce,
  fee_charged: z.object({
    p10: numericCoerce,
    p50: numericCoerce,
    p90: numericCoerce,
    p99: numericCoerce,
  }),
});

export type HorizonFeeStatsResponse = z.infer<typeof HorizonFeeStatsResponseSchema>;

export const HorizonOperationRecordSchema = z.object({
  id: z.string(),
  paging_token: z.string(),
  transaction_successful: z.boolean(),
  type: z.string(),
  type_i: z.number().optional(),
  created_at: z.string(),
});

export type HorizonOperationRecord = z.infer<typeof HorizonOperationRecordSchema>;

export const HorizonOperationsResponseSchema = z.object({
  _embedded: z.object({
    records: z.array(HorizonOperationRecordSchema),
  }),
});

export type HorizonOperationsResponse = z.infer<typeof HorizonOperationsResponseSchema>;

async function horizonFetch<T>(
  path: string,
  schema: z.ZodType<T>,
  horizonUrl: string = HORIZON_URL,
): Promise<T> {
  const res = await fetch(`${horizonUrl}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Horizon request failed: ${path} -> ${res.status}`);
  }
  const json = await res.json();
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issueDetails = parsed.error.issues
      .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
      .join("; ");
    throw new Error(`Horizon schema validation failed for ${path}: ${issueDetails}`);
  }
  return parsed.data;
}

export async function fetchRecentLedgers(
  limit: number,
  horizonUrl: string = HORIZON_URL,
): Promise<LedgerSample[]> {
  const data = await horizonFetch(
    `/ledgers?order=desc&limit=${limit}`,
    HorizonLedgersResponseSchema,
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
  const data = await horizonFetch(
    "/fee_stats",
    HorizonFeeStatsResponseSchema,
    horizonUrl,
  );

  return {
    fetchedAt: new Date().toISOString(),
    lastLedgerBaseFee: data.last_ledger_base_fee,
    ledgerCapacityUsage: data.ledger_capacity_usage,
    feeChargedP10: data.fee_charged.p10,
    feeChargedP50: data.fee_charged.p50,
    feeChargedP90: data.fee_charged.p90,
    feeChargedP99: data.fee_charged.p99,
  };
}

export async function fetchRecentOperations(
  limit: number = 100,
  horizonUrl: string = HORIZON_URL,
): Promise<HorizonOperationRecord[]> {
  const data = await horizonFetch(
    `/operations?order=desc&limit=${limit}`,
    HorizonOperationsResponseSchema,
    horizonUrl,
  );
  return data._embedded.records;
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
              const json = JSON.parse(raw);
              const parsed = HorizonLedgerRecordSchema.safeParse(json);
              if (parsed.success) {
                onLedger(parsed.data);
              } else {
                const issueDetails = parsed.error.issues
                  .map((i) => `${i.path.join(".") || "root"}: ${i.message}`)
                  .join("; ");
                logger.warn(`Malformed SSE ledger record skipped: ${issueDetails}`, {
                  component: "stream",
                });
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
