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
  /*
   * Both fetched results carry the identity they were fetched for, and are
   * read back only while that identity still matches what the controls say.
   *
   * This replaces clearing the state from inside the effect. Clearing worked
   * only after the effect ran, so the render in between — the one that already
   * had the new `range` but still the old points — painted the old series
   * under the new label, which is the exact thing the clearing existed to
   * prevent, one frame wide. Comparing the tag instead makes it structural: a
   * result for a range you are no longer viewing is unreachable, so there is
   * no window in which it can be shown, and no reset render pass either (#150).
   *
   * `null` (no tagged result yet) is what tells HistoryView "still loading"
   * apart from "loaded and empty" — the same distinction the previous
   * `HistoryPoint[] | null` carried.
   *
   * Trends are tagged separately from history for the same reason they always
   * had their own points and error: one failing source must not blank another.
   */
  const [historyResult, setHistoryResult] = useState<{
    network: Network;
    range: HistoryRange;
    points: HistoryPoint[] | null;
    error: string | null;
  } | null>(null);
  const [trendResult, setTrendResult] = useState<{
    network: Network;
    range: TrendRange;
    points: TrendPoint[] | null;
    error: string | null;
  } | null>(null);

  const activeHistory =
    historyResult?.network === network && historyResult.range === range
      ? historyResult
      : null;
  const historyPoints = activeHistory?.points ?? null;
  const historyError = activeHistory?.error ?? null;

  const activeTrends =
    trendResult?.network === network && trendResult.range === trendRange
      ? trendResult
      : null;
  const trendPoints = activeTrends?.points ?? null;
  const trendsError = activeTrends?.error ?? null;

  useEffect(() => {
    let cancelled = false;

    function loadHistory() {
      fetchHistory(network, range)
        .then((res) => {
          if (cancelled) return;
          setHistoryResult({ network, range, points: res.points, error: null });
        })
        .catch((err: unknown) => {
          // Previously swallowed, which made a failing history fetch
          // indistinguishable from a quiet one.
          if (cancelled) return;
          // A failed *refresh* keeps the last good series and shows the error
          // beside it, rather than blanking a chart that was fine a moment
          // ago. `prev` is only reused when it belongs to this same
          // network/range, so this cannot resurrect another view's data.
          setHistoryResult((prev) => ({
            network,
            range,
            points:
              prev?.network === network && prev.range === range
                ? prev.points
                : null,
            error: err instanceof Error ? err.message : String(err),
          }));
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

    function loadTrends() {
      fetchTrends(network, trendRange)
        .then((res) => {
          if (cancelled) return;
          setTrendResult({
            network,
            range: trendRange,
            points: res.points,
            error: null,
          });
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          setTrendResult((prev) => ({
            network,
            range: trendRange,
            points:
              prev?.network === network && prev.range === trendRange
                ? prev.points
                : null,
            error: err instanceof Error ? err.message : String(err),
          }));
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
          /*
            Keyed on the two values SyncStatus anchors its clock to, so a new
            reading remounts it and its initialisers re-anchor. It used to
            re-base itself from an effect, which ran a commit later than the
            render that already had the new props (#150). Remounting is free
            here — the component is one span with no animation, transition or
            focusable child, so there is nothing to interrupt.
          */
          <SyncStatus
            key={`${health.lastUpdated ?? ""}|${health.secondsSinceLastUpdate ?? ""}`}
            lastUpdated={health.lastUpdated}
            secondsSinceLastUpdate={health.secondsSinceLastUpdate}
            status={health.status}
          />
        )}
      </footer>
    </div>
  );
}
