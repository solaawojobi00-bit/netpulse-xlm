import {
  HORIZON_URLS,
  fetchFeeStats,
  fetchRecentLedgers,
  type Network,
} from "./horizon.js";
import type { FeeSnapshot, LedgerSample } from "./types.js";

const MAX_LEDGERS = 50;
const MAX_FEE_SNAPSHOTS = 10;
const LEDGERS_PER_POLL = 20;

export class RollingStore {
  private ledgers: LedgerSample[] = [];
  private feeSnapshots: FeeSnapshot[] = [];
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
    currentStore.markSuccess();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    currentStore.markError(message);
    console.error(`[poller][${network}] Horizon poll failed: ${message}`);
  }
}

export async function pollOnce(network?: Network): Promise<void> {
  if (network) {
    await pollNetwork(network);
  } else {
    await Promise.all([pollNetwork("mainnet"), pollNetwork("testnet")]);
  }
}

export function startPolling(intervalMs: number): void {
  void pollOnce();
  setInterval(() => {
    void pollOnce();
  }, intervalMs);
}
