import {
  HORIZON_URLS,
  fetchFeeStats,
  fetchRecentLedgers,
  fetchRecentOperations,
  type Network,
} from "./horizon.js";
import { logger } from "./logger.js";
import type { FeeSnapshot, LedgerSample, SorobanMetricsResponse, SorobanSample } from "./types.js";

const MAX_LEDGERS = 50;
const MAX_FEE_SNAPSHOTS = 10;
const MAX_SOROBAN_SAMPLES = 20;
const LEDGERS_PER_POLL = 20;

export class RollingStore {
  private ledgers: LedgerSample[] = [];
  private feeSnapshots: FeeSnapshot[] = [];
  private sorobanSamples: SorobanSample[] = [];
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
