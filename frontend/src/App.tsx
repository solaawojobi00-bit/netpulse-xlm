import { useEffect, useState } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { FeePercentileChart } from "./components/FeePercentileChart";
import { FeeSpreadTrendChart } from "./components/FeeSpreadTrendChart";
import { HistoryView } from "./components/HistoryView";
import { LedgerCloseTimeChart } from "./components/LedgerCloseTimeChart";
import { OperationCountChart } from "./components/OperationCountChart";
import { OperationTypeChart } from "./components/OperationTypeChart";
import { SorobanActivityChart } from "./components/SorobanActivityChart";
import { resolveValueStatus } from "./components/resolveStatus";
import { SegmentedControl } from "./components/SegmentedControl";
import { StatTile } from "./components/StatTile";
import { SyncStatus } from "./components/SyncStatus";
import { ThemeToggle } from "./components/ThemeToggle";
import { TransactionSuccessChart } from "./components/TransactionSuccessChart";
import { TrendsView } from "./components/TrendsView";
import {
  fetchHistory,
  fetchTrends,
  HISTORY_RANGES,
  TREND_RANGES,
  type HistoryPoint,
  type HistoryRange,
  type Network,
  type TrendPoint,
  type TrendRange,
} from "./api";
import {
  formatHorizonEndpoint,
  formatPercent,
  formatRate,
  formatSeconds,
  formatStroops,
} from "./format";
import { useQueryParam } from "./useQueryParam";
import { useSlowStart } from "./useSlowStart";
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

const TREND_RANGE_OPTIONS = TREND_RANGES.map((value) => ({
  value,
  label: value,
}));

/*
 * History polls at 30s because its buckets are 5 minutes wide, so a fresh
 * bucket really can appear that often. Trend rows are one per completed UTC
 * day, so polling them at the same rate would issue roughly 2,900 requests a
 * day per client to observe at most one change. Five minutes is still far more
 * often than the data can move, and keeps a tab left open overnight from
 * needing a reload to notice yesterday's rollup.
 */
const TRENDS_POLL_MS = 300000;

export function App() {
  /*
   * Network and range live in the query string so the URL is shareable: the
   * link you paste is the view you are looking at. Both are read
   * synchronously on first render, so a URL carrying params paints that view
   * directly rather than showing mainnet/24h and snapping.
   */
  const [network, setNetwork] = useQueryParam<Network>(
    "network",
    NETWORKS,
    "mainnet",
  );
  const [range, setRange] = useQueryParam<HistoryRange>(
    "range",
    HISTORY_RANGES,
    "24h",
  );
  /*
   * A distinct parameter name, not a second reader of `range`: the history and
   * trend selectors offer different values (24h vs 1y) and move independently,
   * so one visitor can share a link to a 6h history beside a 1y trend.
   */
  const [trendRange, setTrendRange] = useQueryParam<TrendRange>(
    "trendRange",
    TREND_RANGES,
    "90d",
  );
  const { theme, toggleTheme } = useTheme();
  const { health, ledgers, feeSnapshots, soroban, operationBreakdown, error } =
    useSubscription(network);
  // null until the first fetch resolves, so HistoryView can tell "still
  // loading" apart from "loaded and empty".
  const [historyPoints, setHistoryPoints] = useState<HistoryPoint[] | null>(
    null,
  );
  const [historyError, setHistoryError] = useState<string | null>(null);
  // Trends carry their own points and error, kept apart from history's for the
  // same reason history is kept apart from the live socket: one failing source
  // must not blank the others.
  const [trendPoints, setTrendPoints] = useState<TrendPoint[] | null>(null);
  const [trendsError, setTrendsError] = useState<string | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    // Same discard-on-change rule as history: showing the old 90d series under
    // a "1y" heading while the new fetch is in flight would be a chart that
    // disagrees with its own label.
    setTrendPoints(null);
    setTrendsError(null);

    function loadTrends() {
      fetchTrends(network, trendRange)
        .then((res) => {
          if (cancelled) return;
          setTrendPoints(res.points);
          setTrendsError(null);
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setTrendsError(err instanceof Error ? err.message : String(err));
        });
    }
    loadTrends();
    const interval = setInterval(loadTrends, TRENDS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [network, trendRange]);

  /*
   * Was `health === null`, which conflated "not here yet" with "will never
   * arrive" and so left all five tiles pulsing indefinitely through an outage.
   * The same helper the chart cards use decides this now, so the tiles and the
   * charts cannot disagree about whether the backend is reachable (#71).
   *
   * `health` is passed as the source rather than any individual field: once it
   * arrives the tiles are ready, and a null field within it renders an em dash,
   * which is an answer rather than a gap.
   */
  const statStatus = resolveValueStatus(health, error);
  const isStale = health?.status === "stale";

  /*
   * A cold start produces no error to show — the backend sleeps when idle and
   * the request that wakes it is held open for about a minute rather than
   * failing — so without this the tiles and charts sit in their loading state
   * indefinitely, looking exactly like a fast load that has not landed yet.
   */
  const isSlowStart = useSlowStart(health !== null, error);

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
              <span className="network-badge">
                {formatHorizonEndpoint(health.horizonUrl)}
              </span>
            )}
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
          </div>
        </div>
        <p className="app__subtitle">
          Live Stellar {network === "testnet" ? "testnet" : "mainnet"} health,
          via public Horizon
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
              <strong>High Network Congestion:</strong> Ledger capacity usage is
              currently {formatPercent(health.congestion.ledgerCapacityUsage)}
              {health.congestion.alertThreshold !== undefined &&
                ` (alert threshold: ${Math.round(health.congestion.alertThreshold * 100)}%)`}
              . Transactions may experience surge pricing or delayed inclusion.
            </div>
          )}

          {/*
            Informational rather than a warning: a cold start is expected
            behaviour on this deployment, not a fault. Styling it like the two
            banners below would tell a visitor something is wrong at the exact
            moment nothing is.

            Mutually exclusive with the warning banner by construction —
            `isSlowStart` requires `error` to be null and no data to have
            arrived, while that banner requires one or the other.
          */}
          {isSlowStart && (
            <div className="banner banner--info" role="status">
              Waking the backend up. It sleeps when nobody is using it and takes
              up to a minute to start — this page will fill in on its own.
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
          <section
            className="stat-grid"
            aria-labelledby="current-status-heading"
          >
            <h2 id="current-status-heading" className="visually-hidden">
              Current network status
            </h2>
            <StatTile
              label="Ledger close time"
              value={formatSeconds(
                health?.ledgerCloseTime.currentSeconds ?? null,
              )}
              sublabel={`avg ${formatSeconds(health?.ledgerCloseTime.averageSeconds ?? null)}`}
              status={statStatus}
            />
            <StatTile
              label="Base fee"
              value={formatStroops(health?.fees.baseFeeStroops ?? null)}
              status={statStatus}
            />
            {/*
              The band moves from `sublabel` to `band`, which renders it as a
              chip carrying a severity glyph. Previously the only cue that this
              tile meant anything worse than "fine" was the colour of its value.
            */}
            <StatTile
              label="Network congestion"
              value={formatPercent(
                health?.congestion.ledgerCapacityUsage ?? null,
              )}
              band={health?.congestion.band ?? "unknown"}
              tone={congestionTone[health?.congestion.band ?? "unknown"]}
              status={statStatus}
            />
            <StatTile
              label="Throughput"
              value={`${formatRate(health?.throughput.operationsPerSecond ?? null)} ops/s`}
              sublabel={`${formatRate(health?.throughput.transactionsPerSecond ?? null)} txs/s`}
              status={statStatus}
            />
            {/*
              Keyed to `soroban`, not `health`. They arrive separately, and
              keying this tile to health meant that if the Soroban metrics
              alone were missing it read "0 inv/s" — a confident zero standing
              in for a number nobody had.
            */}
            <StatTile
              label="Soroban smart contracts"
              value={`${soroban?.invocationsPerSecond ?? 0} inv/s`}
              sublabel={`${soroban?.recentInvocationsTotal ?? 0} recent invocations`}
              status={resolveValueStatus(soroban, error)}
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
            <OperationTypeChart breakdown={operationBreakdown} error={error} />
          </section>

          <HistoryView
            points={historyPoints}
            range={range}
            error={historyError}
            rangeOptions={RANGE_OPTIONS}
            onRangeChange={setRange}
          />

          {/*
            Below history and inside the same boundary: the two panels show the
            same metrics at different grains, and reading them together is the
            point — coarse trend above the fold of memory, fine detail nearer.
          */}
          <TrendsView
            points={trendPoints}
            range={trendRange}
            error={trendsError}
            rangeOptions={TREND_RANGE_OPTIONS}
            onRangeChange={setTrendRange}
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
