import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FeePercentileChart } from "./components/FeePercentileChart";
import { FeeSpreadTrendChart } from "./components/FeeSpreadTrendChart";
import { HistoryView } from "./components/HistoryView";
import { LedgerCloseTimeChart } from "./components/LedgerCloseTimeChart";
import { OperationCountChart } from "./components/OperationCountChart";
import { SorobanActivityChart } from "./components/SorobanActivityChart";
import { SegmentedControl } from "./components/SegmentedControl";
import { StatTile } from "./components/StatTile";
import { SyncStatus } from "./components/SyncStatus";
import { ThemeToggle } from "./components/ThemeToggle";
import { TransactionSuccessChart } from "./components/TransactionSuccessChart";
import {
  fetchHealth,
  fetchHistory,
  fetchRecentFees,
  fetchRecentLedgers,
  HISTORY_RANGES,
  type HistoryPoint,
  type HistoryRange,
  type Network,
} from "./api";
import {
  formatHorizonEndpoint,
  formatPercent,
  formatRate,
  formatSeconds,
  formatStroops,
} from "./format";
import { useQueryParam } from "./useQueryParam";
import { useSubscription } from "./useSubscription";
import { useTheme } from "./useTheme";

const congestionTone: Record<string, "good" | "warn" | "bad" | "neutral"> = {
  low: "good",
  moderate: "warn",
  high: "bad",
  unknown: "neutral",
};

const NETWORKS = ["mainnet", "testnet"] as const satisfies readonly Network[];

const NETWORK_OPTIONS = [
  { value: "mainnet" as const, label: "Mainnet" },
  { value: "testnet" as const, label: "Testnet" },
];

const RANGE_OPTIONS = HISTORY_RANGES.map((value) => ({ value, label: value }));

export function App() {
  /*
   * Network and range live in the query string so the URL is shareable: the
   * link you paste is the view you are looking at. Both are read
   * synchronously on first render, so a URL carrying params paints that view
   * directly rather than showing mainnet/24h and snapping.
   */
  const [network, setNetwork] = useQueryParam<Network>("network", NETWORKS, "mainnet");
  const [range, setRange] = useQueryParam<HistoryRange>("range", HISTORY_RANGES, "24h");
  const { theme, toggleTheme } = useTheme();
  const { health, ledgers, feeSnapshots, soroban, error } = useSubscription(network);
  // null until the first fetch resolves, so HistoryView can tell "still
  // loading" apart from "loaded and empty".
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[] | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Switching network or range discards the previous result rather than
    // showing it under the new label while the fetch is in flight.
    setHistoryPoints(null);
    setHistoryError(null);

    function loadHistory() {
      fetchHistory(network, range)
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
  }, [network, range]);

  const isLoading = health === null;
  const isStale = health?.status === "stale";

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__header-top">
          <div className="app__header-brand">
            <h1>NetPulse</h1>
            <SegmentedControl
              label="Stellar Network"
              options={NETWORK_OPTIONS}
              value={network}
              onChange={setNetwork}
            />
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
      <main className="app__main">
        <ErrorBoundary key={network}>
          {/*
            Both banners are polite, not assertive. They appear and disappear as
            the backend recovers, and on a dashboard that reconnects on its own
            an assertive region would interrupt whatever the user is reading
            every time the network flaps. Polite queues the announcement instead
            of cutting in, which is the right trade for information that is
            about the page rather than about something the user just did.

            This is the same reasoning as the per-chart error states from #48:
            announce once, politely, and let the visible text carry the detail.
          */}
          {health?.congestion.band === "high" && (
            <div className="banner banner--danger" role="status">
              <strong>High Network Congestion:</strong> Ledger capacity usage is currently{" "}
              {formatPercent(health.congestion.ledgerCapacityUsage)}
              {health.congestion.alertThreshold !== undefined &&
                ` (alert threshold: ${Math.round(health.congestion.alertThreshold * 100)}%)`}
              . Transactions may experience surge pricing or delayed inclusion.
            </div>
          )}

          {(isStale || error) && (
            <div className="banner banner--warn" role="status">
              {error
                ? "Unable to reach the NetPulse backend. Retrying…"
                : `Data may be stale — backend hasn't refreshed from Horizon in a while.`}
            </div>
          )}

          {/*
            The heading outline ran h1 -> h3, skipping a level, because the two
            grids had no heading of their own. These name the sections for
            anyone navigating by heading without changing the visual design,
            which has no room for them.
          */}
          <section className="stat-grid" aria-labelledby="current-status-heading">
            <h2 id="current-status-heading" className="visually-hidden">
              Current network status
            </h2>
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
            {/*
              The band moves from `sublabel` to `band`, which renders it as a
              chip carrying a severity glyph. Previously the only cue that this
              tile meant anything worse than "fine" was the colour of its value.
            */}
            <StatTile
              label="Network congestion"
              value={formatPercent(health?.congestion.ledgerCapacityUsage ?? null)}
              band={health?.congestion.band ?? "unknown"}
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
          <section className="chart-grid" aria-labelledby="live-charts-heading">
            <h2 id="live-charts-heading" className="visually-hidden">
              Live network charts
            </h2>
            <LedgerCloseTimeChart ledgers={ledgers} error={error} />
            <OperationCountChart ledgers={ledgers} error={error} />
            <TransactionSuccessChart ledgers={ledgers} error={error} />
            <FeePercentileChart fees={health?.fees ?? null} error={error} />
            <FeeSpreadTrendChart snapshots={feeSnapshots} error={error} />
            <SorobanActivityChart soroban={soroban} error={error} />
          </section>

          <HistoryView
            points={historyPoints}
            range={range}
            error={historyError}
            rangeOptions={RANGE_OPTIONS}
            onRangeChange={setRange}
          />
        </ErrorBoundary>
      </main>

      {/*
        Outside <main>, so it is a page-level contentinfo landmark rather than
        content nested inside the main region.
      */}
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
