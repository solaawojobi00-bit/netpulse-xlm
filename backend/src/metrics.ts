import { isValidCloseTimeSeconds } from "./closeTime.js";
import { HORIZON_URLS, type Network } from "./horizon.js";
import { stores } from "./poller.js";
import type { HealthResponse } from "./types.js";

const THROUGHPUT_WINDOW = 20;
const STALE_AFTER_MS = 3 * Number(process.env.POLL_INTERVAL_MS ?? 6000);

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

export function getCongestionAlertThreshold(): number {
  const envVal = Number(process.env.CONGESTION_ALERT_THRESHOLD);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : 0.8;
}

export function congestionBand(
  usage: number | null,
  highThreshold: number = getCongestionAlertThreshold(),
): "low" | "moderate" | "high" | "unknown" {
  if (usage === null) return "unknown";
  if (usage < 0.5) return "low";
  if (usage < highThreshold) return "moderate";
  return "high";
}

export function buildHealthResponse(network: Network = "mainnet"): HealthResponse {
  const currentStore = stores[network] ?? stores.mainnet;
  const horizonUrl = HORIZON_URLS[network] ?? HORIZON_URLS.mainnet;
  const ledgers = currentStore.getLedgers();
  const latestFee = currentStore.getLatestFeeSnapshot();
  const lastSuccessAt = currentStore.getLastSuccessAt();
  const alertThreshold = getCongestionAlertThreshold();

  /*
   * Filtered by validity, not merely by non-null. The ingestion fixes in #84
   * stop negative close times being produced, but this is the layer that
   * reports the average, and one bad sample dominating it is exactly the
   * symptom that surfaced the bug — a window holding 30 stale ledgers reported
   * an average of about -8.4 months. Rows already persisted before that fix,
   * or any future path that computes a delta wrongly, must not be able to
   * poison this number either.
   */
  const closeTimes = ledgers
    .map((l) => l.closeTimeSeconds)
    .filter(isValidCloseTimeSeconds);
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
    horizonUrl,
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
      band: congestionBand(latestFee?.ledgerCapacityUsage ?? null, alertThreshold),
      alertThreshold,
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
