import { useEffect, useState } from "react";
import { FeePercentileChart } from "./components/FeePercentileChart";
import { FeeSpreadTrendChart } from "./components/FeeSpreadTrendChart";
import { HistoryView } from "./components/HistoryView";
import { LedgerCloseTimeChart } from "./components/LedgerCloseTimeChart";
import { OperationCountChart } from "./components/OperationCountChart";
import { SorobanActivityChart } from "./components/SorobanActivityChart";
import { StatTile } from "./components/StatTile";
import { SyncStatus } from "./components/SyncStatus";
import { TransactionSuccessChart } from "./components/TransactionSuccessChart";
import {
  fetchHealth,
  fetchHistory,
  fetchRecentFees,
  fetchRecentLedgers,
  type HistoryPoint,
  type Network,
} from "./api";
import {
  formatHorizonEndpoint,
  formatPercent,
  formatRate,
  formatSeconds,
  formatStroops,
} from "./format";
import { useSubscription } from "./useSubscription";

const congestionTone: Record<string, "good" | "warn" | "bad" | "neutral"> = {
  low: "good",
  moderate: "warn",
  high: "bad",
  unknown: "neutral",
};

export function App() {
  const [network, setNetwork] = useState<Network>("mainnet");
  const { health, ledgers, feeSnapshots, soroban, error } = useSubscription(network);
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[]>([]);

  useEffect(() => {
    let cancelled = false;
    function loadHistory() {
      fetchHistory(network, "24h")
        .then((res) => {
          if (!cancelled) setHistoryPoints(res.points);
        })
        .catch(() => {});
    }
    loadHistory();
    const interval = setInterval(loadHistory, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [network]);

  const isLoading = health === null;
  const isStale = health?.status === "stale";

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__header-top">
          <div className="app__header-brand">
            <h1>NetPulse</h1>
            <div className="network-selector" role="group" aria-label="Stellar Network">
              <button
                type="button"
                className={`network-selector__btn ${network === "mainnet" ? "network-selector__btn--active" : ""}`}
                onClick={() => setNetwork("mainnet")}
              >
                Mainnet
              </button>
              <button
                type="button"
                className={`network-selector__btn ${network === "testnet" ? "network-selector__btn--active" : ""}`}
                onClick={() => setNetwork("testnet")}
              >
                Testnet
              </button>
            </div>
          </div>
          {health?.horizonUrl && (
            <span className="network-badge">{formatHorizonEndpoint(health.horizonUrl)}</span>
          )}
        </div>
        <p className="app__subtitle">
          Live Stellar {network === "testnet" ? "testnet" : "mainnet"} health, via public Horizon
        </p>
      </header>

      {health?.congestion.band === "high" && (
        <div className="banner banner--danger">
          <strong>High Network Congestion:</strong> Ledger capacity usage is currently{" "}
          {formatPercent(health.congestion.ledgerCapacityUsage)}
          {health.congestion.alertThreshold !== undefined &&
            ` (alert threshold: ${Math.round(health.congestion.alertThreshold * 100)}%)`}
          . Transactions may experience surge pricing or delayed inclusion.
        </div>
      )}

      {(isStale || error) && (
        <div className="banner banner--warn">
          {error
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
        <StatTile
          label="Soroban smart contracts"
          value={`${soroban?.invocationsPerSecond ?? 0} inv/s`}
          sublabel={`${soroban?.recentInvocationsTotal ?? 0} recent invocations`}
          loading={isLoading}
        />
      </section>

      <section className="chart-grid">
        <LedgerCloseTimeChart ledgers={ledgers ?? []} />
        <OperationCountChart ledgers={ledgers ?? []} />
        <TransactionSuccessChart ledgers={ledgers ?? []} />
        {health && <FeePercentileChart fees={health.fees} />}
        <FeeSpreadTrendChart snapshots={feeSnapshots ?? []} />
        <SorobanActivityChart soroban={soroban} />
      </section>

      <HistoryView points={historyPoints} range="24h" />

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
