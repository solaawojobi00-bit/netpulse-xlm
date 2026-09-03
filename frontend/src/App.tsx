import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FeePercentileChart } from "./components/FeePercentileChart";
import { FeeSpreadTrendChart } from "./components/FeeSpreadTrendChart";
import { HistoryView } from "./components/HistoryView";
import { LedgerCloseTimeChart } from "./components/LedgerCloseTimeChart";
import { OperationCountChart } from "./components/OperationCountChart";
import { SorobanActivityChart } from "./components/SorobanActivityChart";
import { StatTile } from "./components/StatTile";
import { SyncStatus } from "./components/SyncStatus";
import { ThemeToggle } from "./components/ThemeToggle";
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
import { useTheme } from "./useTheme";

const congestionTone: Record<string, "good" | "warn" | "bad" | "neutral"> = {
  low: "good",
  moderate: "warn",
  high: "bad",
  unknown: "neutral",
};

export function App() {
  const [network, setNetwork] = useState<Network>("mainnet");
  const { theme, toggleTheme } = useTheme();
  const { health, ledgers, feeSnapshots, soroban, error } = useSubscription(network);
  // null until the first fetch resolves, so HistoryView can tell "still
  // loading" apart from "loaded and empty".
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Switching networks discards the previous network's history rather than
    // showing it under the new label while the fetch is in flight.
    setHistoryPoints(null);
    setHistoryError(null);

    function loadHistory() {
      fetchHistory(network, "24h")
        .then((res) => {
          if (cancelled) return;
          setHistoryPoints(res.points);
          setHistoryError(null);
        })
        .catch((err: unknown) => {
          // Previously swallowed, which made a failing history fetch
          // indistinguishable from a quiet one.
          if (cancelled) return;
          setHistoryError(err instanceof Error ? err.message : String(err));
        });
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
          <div className="app__header-actions">
            {health?.horizonUrl && (
              <span className="network-badge">{formatHorizonEndpoint(health.horizonUrl)}</span>
            )}
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </div>
        <p className="app__subtitle">
          Live Stellar {network === "testnet" ? "testnet" : "mainnet"} health, via public Horizon
        </p>
      </header>

      {/*
        The header sits outside the boundary so the network selector and theme
        toggle keep working when the data below fails to render. Keying the
        boundary by network clears a stale fallback when the visitor switches
        away from the network whose data caused it.
      */}
      <ErrorBoundary key={network}>
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

        {/*
          Nulls are passed through rather than collapsed with `?? []`: that is
          the only thing distinguishing "not loaded yet" from "loaded and
          genuinely empty" by the time data reaches a chart.

          The six live charts share `error` from the WebSocket subscription;
          history carries its own, so one failing source cannot blank the
          other.
        */}
        <section className="chart-grid">
          <LedgerCloseTimeChart ledgers={ledgers} error={error} />
          <OperationCountChart ledgers={ledgers} error={error} />
          <TransactionSuccessChart ledgers={ledgers} error={error} />
          <FeePercentileChart fees={health?.fees ?? null} error={error} />
          <FeeSpreadTrendChart snapshots={feeSnapshots} error={error} />
          <SorobanActivityChart soroban={soroban} error={error} />
        </section>

        <HistoryView points={historyPoints} range="24h" error={historyError} />

        <footer className="app__footer">
          {health && (
            <SyncStatus
              lastUpdated={health.lastUpdated}
              secondsSinceLastUpdate={health.secondsSinceLastUpdate}
              status={health.status}
            />
          )}
        </footer>
      </ErrorBoundary>
    </div>
  );
}
