import {
  HORIZON_URLS,
  fetchFeeStats,
  fetchRecentLedgers,
  fetchRecentOperations,
  type Network,
} from "./horizon.js";
import { logger } from "./logger.js";
import type {
  FeeSnapshot,
  LedgerSample,
  OperationBreakdownResponse,
  OperationTypeCount,
  OperationTypeSample,
  SorobanMetricsResponse,
  SorobanSample,
} from "./types.js";

const MAX_LEDGERS = 50;
const MAX_FEE_SNAPSHOTS = 10;
const MAX_SOROBAN_SAMPLES = 20;
const LEDGERS_PER_POLL = 20;

/** Operation-type samples are kept in step with the Soroban ones — same poll. */
const MAX_OPERATION_SAMPLES = MAX_SOROBAN_SAMPLES;

/*
 * A defensive ceiling on distinct type keys held per sample, not a display
 * choice. Stellar defines roughly fifteen operation types, so this is never
 * reached in practice; it exists so that a Horizon that starts returning novel
 * type strings — a protocol upgrade, a bug, a hostile response — cannot grow
 * the store without limit. Overflow is folded into the `other` bucket, so the
 * total stays right even when individual rare types are dropped.
 */
const MAX_TRACKED_TYPES = 30;

/*
 * How many named types the response carries before the tail is grouped. The
 * distribution is very uneven — payments and offers dominate while several
 * types sit near zero — so charting all fifteen produces a row of slivers with
 * unreadable labels.
 */
const TOP_N_TYPES = 6;

/**
 * The grouped-tail bucket. Consumers should read `isOther` rather than compare
 * against this string, so a future Horizon type genuinely called "other"
 * cannot be mistaken for the bucket.
 */
export const OTHER_OPERATION_TYPE = "other";

/**
 * Counts operations by type, folding anything past MAX_TRACKED_TYPES into
 * `other` so the returned map is bounded regardless of the input.
 *
 * Exported for testing: this is the part with the edge cases.
 */
export function countOperationTypes(
  operations: readonly { type?: unknown }[],
): OperationTypeSample {
  const counts: Record<string, number> = {};
  let total = 0;

  for (const op of operations) {
    // A record whose type is missing or non-string still happened, so it is
    // counted — as `other` rather than as a key like "undefined".
    const type = typeof op?.type === "string" && op.type.length > 0 ? op.type : OTHER_OPERATION_TYPE;
    counts[type] = (counts[type] ?? 0) + 1;
    total += 1;
  }

  const keys = Object.keys(counts);
  if (keys.length > MAX_TRACKED_TYPES) {
    // Keep the largest types by count; everything else becomes `other`. Ties
    // break on the type name so the result does not depend on key order.
    const ranked = keys.sort((a, b) => counts[b] - counts[a] || a.localeCompare(b));
    const kept = ranked.slice(0, MAX_TRACKED_TYPES - 1);
    const dropped = ranked.slice(MAX_TRACKED_TYPES - 1);

    const trimmed: Record<string, number> = {};
    for (const key of kept) trimmed[key] = counts[key];
    trimmed[OTHER_OPERATION_TYPE] =
      (trimmed[OTHER_OPERATION_TYPE] ?? 0) +
      dropped.reduce((acc, key) => acc + counts[key], 0);

    return { timestamp: new Date().toISOString(), total, counts: trimmed };
  }

  return { timestamp: new Date().toISOString(), total, counts };
}

export class RollingStore {
  private ledgers: LedgerSample[] = [];
  private feeSnapshots: FeeSnapshot[] = [];
  private sorobanSamples: SorobanSample[] = [];
  private operationTypeSamples: OperationTypeSample[] = [];
  private lastSuccessAt: Date | null = null;
  private lastErrorMessage: string | null = null;

  setLedgers(fresh: LedgerSample[]): void {
    const bySequence = new Map<number, LedgerSample>();
    for (const sample of [...this.ledgers, ...fresh]) {
      bySequence.set(sample.sequence, sample);
    }
    this.ledgers = [...bySequence.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .slice(-MAX_LEDGERS);
  }

  addFeeSnapshot(snapshot: FeeSnapshot): void {
    this.feeSnapshots.push(snapshot);
    if (this.feeSnapshots.length > MAX_FEE_SNAPSHOTS) {
      this.feeSnapshots.shift();
    }
  }

  addSorobanSample(sample: SorobanSample): void {
    this.sorobanSamples.push(sample);
    if (this.sorobanSamples.length > MAX_SOROBAN_SAMPLES) {
      this.sorobanSamples.shift();
    }
  }

  getSorobanSamples(): SorobanSample[] {
    return this.sorobanSamples;
  }

  addOperationTypeSample(sample: OperationTypeSample): void {
    this.operationTypeSamples.push(sample);
    if (this.operationTypeSamples.length > MAX_OPERATION_SAMPLES) {
      this.operationTypeSamples.shift();
    }
  }

  getOperationTypeSamples(): OperationTypeSample[] {
    return this.operationTypeSamples;
  }

  /**
   * Empties the store. The samples are deliberately cumulative across polls,
   * which makes exact assertions in tests depend on whatever ran before them;
   * this gives a test a clean window without reaching into private fields.
   */
  reset(): void {
    this.ledgers = [];
    this.feeSnapshots = [];
    this.sorobanSamples = [];
    this.operationTypeSamples = [];
    this.lastSuccessAt = null;
    this.lastErrorMessage = null;
  }

  markSuccess(): void {
    this.lastSuccessAt = new Date();
    this.lastErrorMessage = null;
  }

  markError(message: string): void {
    this.lastErrorMessage = message;
  }

  getLedgers(): LedgerSample[] {
    return this.ledgers;
  }

  getLatestFeeSnapshot(): FeeSnapshot | null {
    return this.feeSnapshots.at(-1) ?? null;
  }

  getFeeSnapshots(): FeeSnapshot[] {
    return this.feeSnapshots;
  }

  getLastSuccessAt(): Date | null {
    return this.lastSuccessAt;
  }

  getLastErrorMessage(): string | null {
    return this.lastErrorMessage;
  }
}

export const stores: Record<Network, RollingStore> = {
  mainnet: new RollingStore(),
  testnet: new RollingStore(),
};

export const store = stores.mainnet;

type StoreUpdateListener = (network: Network) => void;
const updateListeners: StoreUpdateListener[] = [];

export function onStoreUpdate(listener: StoreUpdateListener): () => void {
  updateListeners.push(listener);
  return () => {
    const idx = updateListeners.indexOf(listener);
    if (idx !== -1) updateListeners.splice(idx, 1);
  };
}

function notifyUpdate(network: Network): void {
  for (const listener of updateListeners) {
    try {
      listener(network);
    } catch (err) {
      logger.error("Error in store update listener", { component: "poller", err });
    }
  }
}

import { db } from "./db.js";

async function pollFeeStats(network: Network): Promise<void> {
  const currentStore = stores[network];
  const url = HORIZON_URLS[network];
  try {
    const feeStats = await fetchFeeStats(url);
    currentStore.addFeeSnapshot(feeStats);
    db.insertFeeSnapshot(network, feeStats);
    currentStore.markSuccess();
    notifyUpdate(network);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    currentStore.markError(message);
    logger.warn("Fee stats poll failed", { component: "poller", network, err });
  }
}

export async function pollOperations(network: Network): Promise<void> {
  const currentStore = stores[network];
  const url = HORIZON_URLS[network];
  try {
    const rawOps = await fetchRecentOperations(100, url);
    const operations = Array.isArray(rawOps) ? rawOps : [];
    const sorobanOps = operations.filter((op) => op.type === "invoke_host_function");
    const successfulCount = sorobanOps.filter((op) => op.transaction_successful).length;
    const failedCount = sorobanOps.length - successfulCount;

    const sample: SorobanSample = {
      timestamp: new Date().toISOString(),
      invocationsCount: sorobanOps.length,
      successfulCount,
      failedCount,
    };

    currentStore.addSorobanSample(sample);
    // The same fetch already carries every operation's type; this poll used to
    // narrow to invoke_host_function and discard the rest.
    currentStore.addOperationTypeSample(countOperationTypes(operations));
    currentStore.markSuccess();
    notifyUpdate(network);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Operations poll failed", { component: "poller", network, err });
  }
}

async function pollNetwork(network: Network): Promise<void> {
  const currentStore = stores[network];
  const url = HORIZON_URLS[network];
  try {
    const [ledgers, feeStats] = await Promise.all([
      fetchRecentLedgers(LEDGERS_PER_POLL, url),
      fetchFeeStats(url),
    ]);
    currentStore.setLedgers(ledgers);
    currentStore.addFeeSnapshot(feeStats);
    db.insertLedgers(network, ledgers);
    db.insertFeeSnapshot(network, feeStats);
    await pollOperations(network);
    currentStore.markSuccess();
    notifyUpdate(network);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    currentStore.markError(message);
    logger.warn("Horizon poll failed", { component: "poller", network, err });
  }
}

export async function pollOnce(network?: Network): Promise<void> {
  if (network) {
    await pollNetwork(network);
  } else {
    await Promise.all([pollNetwork("mainnet"), pollNetwork("testnet")]);
  }
}

export async function startStreamForNetwork(
  network: Network,
  signal?: AbortSignal,
): Promise<void> {
  const currentStore = stores[network];
  const url = HORIZON_URLS[network];

  // 1. Initial warm-up
  try {
    const [initialLedgers, initialFees] = await Promise.all([
      fetchRecentLedgers(LEDGERS_PER_POLL, url),
      fetchFeeStats(url),
    ]);
    currentStore.setLedgers(initialLedgers);
    currentStore.addFeeSnapshot(initialFees);
    db.insertLedgers(network, initialLedgers);
    db.insertFeeSnapshot(network, initialFees);
    currentStore.markSuccess();
    notifyUpdate(network);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    currentStore.markError(message);
    logger.warn("Initial warm-up failed", { component: "stream", network, err });
  }

  // Determine starting cursor from newest ledger sequence, or fallback to "now"
  let cursor =
    currentStore.getLedgers().at(-1)?.sequence?.toString() ?? "now";
  let backoffDelay = 1000;

  const { connectHorizonLedgerStream, recordToSample } = await import("./horizon.js");

  // Run persistent streaming loop with reconnect-with-backoff
  while (!signal?.aborted) {
    try {
      await connectHorizonLedgerStream(
        url,
        cursor,
        (record) => {
          if (record.paging_token) {
            cursor = record.paging_token;
          } else if (record.sequence) {
            cursor = String(record.sequence);
          }

          const existingLedgers = currentStore.getLedgers();
          const prevClosedAt = existingLedgers.at(-1)?.closedAt;
          const sample = recordToSample(record, prevClosedAt);

          currentStore.setLedgers([sample]);
          db.insertLedgers(network, [sample]);
          currentStore.markSuccess();
          backoffDelay = 1000;
          notifyUpdate(network);
        },
        signal,
      );
    } catch (err) {
      if (signal?.aborted) break;
      const message = err instanceof Error ? err.message : String(err);
      currentStore.markError(message);
      logger.info(
        `Horizon SSE disconnected (${message}). Reconnecting in ${backoffDelay}ms from cursor ${cursor}...`,
        { component: "stream", network, backoffDelay, cursor },
      );
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve();
        const onAbort = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, backoffDelay);
        signal?.addEventListener("abort", onAbort);
      });
      backoffDelay = Math.min(30000, backoffDelay * 2);
    }
  }
}

export function buildSorobanResponse(network: Network): SorobanMetricsResponse {
  const store = stores[network] ?? stores.mainnet;
  const samples = store.getSorobanSamples();
  const recentInvocationsTotal = samples.reduce((acc, s) => acc + s.invocationsCount, 0);
  const successfulInvocationsTotal = samples.reduce((acc, s) => acc + s.successfulCount, 0);
  const failedInvocationsTotal = samples.reduce((acc, s) => acc + s.failedCount, 0);

  let invocationsPerSecond: number | null = null;
  if (samples.length >= 2) {
    const start = new Date(samples[0].timestamp).getTime();
    const end = new Date(samples[samples.length - 1].timestamp).getTime();
    const elapsedSeconds = (end - start) / 1000;
    if (elapsedSeconds > 0) {
      invocationsPerSecond = Number((recentInvocationsTotal / elapsedSeconds).toFixed(2));
    }
  } else if (samples.length === 1) {
    invocationsPerSecond = 0;
  }

  return {
    network,
    invocationsPerSecond,
    recentInvocationsTotal,
    successfulInvocationsTotal,
    failedInvocationsTotal,
    samples,
  };
}

/**
 * Totals the stored samples and groups the long tail.
 *
 * The window is a rolling sample of recent polls, not a per-ledger or all-time
 * figure — `sampleCount` and `windowSeconds` are returned so the chart can say
 * so rather than presenting the number bare.
 */
export function buildOperationBreakdownResponse(
  network: Network,
): OperationBreakdownResponse {
  const store = stores[network] ?? stores.mainnet;
  const samples = store.getOperationTypeSamples();

  const totals = new Map<string, number>();
  let totalOperations = 0;
  for (const sample of samples) {
    for (const [type, count] of Object.entries(sample.counts)) {
      totals.set(type, (totals.get(type) ?? 0) + count);
    }
    totalOperations += sample.total;
  }

  let windowSeconds: number | null = null;
  if (samples.length >= 2) {
    const start = new Date(samples[0].timestamp).getTime();
    const end = new Date(samples[samples.length - 1].timestamp).getTime();
    const elapsed = (end - start) / 1000;
    if (Number.isFinite(elapsed) && elapsed >= 0) {
      windowSeconds = Math.round(elapsed);
    }
  }

  // Anything already folded into `other` upstream stays out of the named
  // ranking, so it cannot displace a real type from the top N.
  const named = [...totals.entries()]
    .filter(([type]) => type !== OTHER_OPERATION_TYPE)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const kept = named.slice(0, TOP_N_TYPES);
  const tail = named.slice(TOP_N_TYPES);
  const otherCount =
    (totals.get(OTHER_OPERATION_TYPE) ?? 0) + tail.reduce((acc, [, n]) => acc + n, 0);

  const share = (count: number) =>
    totalOperations > 0 ? Number((count / totalOperations).toFixed(4)) : 0;

  const breakdown: OperationTypeCount[] = kept.map(([type, count]) => ({
    type,
    count,
    share: share(count),
    isOther: false,
  }));

  if (otherCount > 0) {
    breakdown.push({
      type: OTHER_OPERATION_TYPE,
      count: otherCount,
      share: share(otherCount),
      isOther: true,
    });
  }

  return {
    network,
    sampleCount: samples.length,
    windowSeconds,
    totalOperations,
    distinctTypes: totals.size,
    breakdown,
  };
}

export interface StreamingHandle {
  /**
   * Clears the poll interval and aborts the SSE loops, resolving once those
   * loops have actually exited. Shutdown awaits this before closing the
   * database, since the stream callbacks write to it.
   */
  stop: () => Promise<void>;
}

export function startStreaming(intervalMs: number): StreamingHandle {
  // Prune historical records older than retention policy
  try {
    db.pruneOlderThan();
  } catch (err) {
    logger.error("Prune failed", { component: "db", err });
  }

  /*
   * startStreamForNetwork already accepted an AbortSignal but nothing ever
   * supplied one, so the SSE loops ran until the process died. Keeping the
   * controller and the returned promises here is what makes them stoppable.
   */
  const controller = new AbortController();
  const streams = [
    startStreamForNetwork("mainnet", controller.signal),
    startStreamForNetwork("testnet", controller.signal),
  ];

  // Initial operations poll
  void pollOperations("mainnet");
  void pollOperations("testnet");

  // Horizon /fee_stats and /operations do not support SSE streaming; poll periodically
  const interval = setInterval(() => {
    void pollFeeStats("mainnet");
    void pollFeeStats("testnet");
    void pollOperations("mainnet");
    void pollOperations("testnet");
  }, intervalMs);

  return {
    async stop() {
      clearInterval(interval);
      controller.abort();
      // allSettled: a stream rejecting on the way out must not stop the rest
      // of shutdown, and the loops swallow their own errors anyway.
      await Promise.allSettled(streams);
    },
  };
}

export function startPolling(intervalMs: number): StreamingHandle {
  return startStreaming(intervalMs);
}
