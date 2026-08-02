import { store } from "./poller.js";
import type { HealthResponse } from "./types.js";

const THROUGHPUT_WINDOW = 20;
const STALE_AFTER_MS = 3 * Number(process.env.POLL_INTERVAL_MS ?? 6000);

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function congestionBand(usage: number | null): "low" | "moderate" | "high" | "unknown" {
  if (usage === null) return "unknown";
  if (usage < 0.5) return "low";
  if (usage < 0.8) return "moderate";
  return "high";
}

export function buildHealthResponse(): HealthResponse {
  const ledgers = store.getLedgers();
  const latestFee = store.getLatestFeeSnapshot();
  const lastSuccessAt = store.getLastSuccessAt();

  const closeTimes = ledgers
    .map((l) => l.closeTimeSeconds)
    .filter((v): v is number => v !== null);
  const currentCloseTime = closeTimes.at(-1) ?? null;
  const averageCloseTime = average(closeTimes);

  const recentWindow = ledgers.slice(-THROUGHPUT_WINDOW);
  const windowSpanSeconds =
    recentWindow.length >= 2
      ? (new Date(recentWindow.at(-1)!.closedAt).getTime() -
          new Date(recentWindow[0].closedAt).getTime()) /
        1000
      : null;
  const totalOps = recentWindow.reduce((sum, l) => sum + l.operationCount, 0);
  const totalTxs = recentWindow.reduce(
    (sum, l) => sum + l.successfulTransactionCount,
    0,
  );

  const secondsSinceLastUpdate = lastSuccessAt
    ? (Date.now() - lastSuccessAt.getTime()) / 1000
    : null;
  const isStale =
    lastSuccessAt === null || Date.now() - lastSuccessAt.getTime() > STALE_AFTER_MS;

  return {
    status: isStale ? "stale" : "ok",
    lastUpdated: lastSuccessAt ? lastSuccessAt.toISOString() : null,
    secondsSinceLastUpdate,
    ledgerCloseTime: {
      currentSeconds: currentCloseTime,
      averageSeconds: averageCloseTime,
    },
    fees: {
      baseFeeStroops: latestFee?.lastLedgerBaseFee ?? null,
      p10: latestFee?.feeChargedP10 ?? null,
      p50: latestFee?.feeChargedP50 ?? null,
      p90: latestFee?.feeChargedP90 ?? null,
      p99: latestFee?.feeChargedP99 ?? null,
    },
    congestion: {
      ledgerCapacityUsage: latestFee?.ledgerCapacityUsage ?? null,
      band: congestionBand(latestFee?.ledgerCapacityUsage ?? null),
    },
    throughput: {
      operationsPerSecond:
        windowSpanSeconds && windowSpanSeconds > 0 ? totalOps / windowSpanSeconds : null,
      transactionsPerSecond:
        windowSpanSeconds && windowSpanSeconds > 0 ? totalTxs / windowSpanSeconds : null,
    },
    recentLedgerCount: ledgers.length,
  };
}
