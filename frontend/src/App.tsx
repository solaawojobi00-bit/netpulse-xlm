import { FeePercentileChart } from "./components/FeePercentileChart";
import { LedgerCloseTimeChart } from "./components/LedgerCloseTimeChart";
import { OperationCountChart } from "./components/OperationCountChart";
import { StatTile } from "./components/StatTile";
import { SyncStatus } from "./components/SyncStatus";
import { fetchHealth, fetchRecentLedgers } from "./api";
import { usePolling } from "./usePolling";

function formatSeconds(value: number | null, digits = 1): string {
  return value === null ? "—" : `${value.toFixed(digits)}s`;
}

function formatStroops(value: number | null): string {
  return value === null ? "—" : `${value.toLocaleString()} stroops`;
}

function formatPercent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function formatRate(value: number | null): string {
  return value === null ? "—" : value.toFixed(1);
}

function formatHorizonEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host;
    const network = host.includes("testnet") ? "Testnet" : "Mainnet";
    return `${network} · ${host}`;
  } catch {
    return url;
  }
}

const congestionTone: Record<string, "good" | "warn" | "bad" | "neutral"> = {
  low: "good",
  moderate: "warn",
  high: "bad",
  unknown: "neutral",
};

export function App() {
  const { data: health, error: healthError } = usePolling(fetchHealth);
  const { data: ledgers, error: ledgersError } = usePolling(fetchRecentLedgers);

  const isLoading = health === null;
  const isStale = health?.status === "stale";

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__header-top">
          <h1>NetPulse</h1>
          {health?.horizonUrl && (
            <span className="network-badge">{formatHorizonEndpoint(health.horizonUrl)}</span>
          )}
        </div>
        <p className="app__subtitle">Live Stellar mainnet health, via public Horizon</p>
      </header>

      {(isStale || healthError || ledgersError) && (
        <div className="banner banner--warn">
          {healthError || ledgersError
            ? "Unable to reach the NetPulse backend. Retrying…"
            : `Data may be stale — backend hasn't refreshed from Horizon in a while.`}
        </div>
      )}

      <section className="stat-grid">
        <StatTile
          label="Ledger close time"
          value={formatSeconds(health?.ledgerCloseTime.currentSeconds ?? null)}
          sublabel={`avg ${formatSeconds(health?.ledgerCloseTime.averageSeconds ?? null)}`}
          loading={isLoading}
        />
        <StatTile
          label="Base fee"
          value={formatStroops(health?.fees.baseFeeStroops ?? null)}
          loading={isLoading}
        />
        <StatTile
          label="Network congestion"
          value={formatPercent(health?.congestion.ledgerCapacityUsage ?? null)}
          sublabel={health?.congestion.band ?? "unknown"}
          tone={congestionTone[health?.congestion.band ?? "unknown"]}
          loading={isLoading}
        />
        <StatTile
          label="Throughput"
          value={`${formatRate(health?.throughput.operationsPerSecond ?? null)} ops/s`}
          sublabel={`${formatRate(health?.throughput.transactionsPerSecond ?? null)} txs/s`}
          loading={isLoading}
        />
      </section>

      <section className="chart-grid">
        <LedgerCloseTimeChart ledgers={ledgers ?? []} />
        <OperationCountChart ledgers={ledgers ?? []} />
        {health && <FeePercentileChart fees={health.fees} />}
      </section>

      <footer className="app__footer">
        {health && (
          <SyncStatus
            lastUpdated={health.lastUpdated}
            secondsSinceLastUpdate={health.secondsSinceLastUpdate}
            status={health.status}
          />
        )}
      </footer>
    </div>
  );
}
