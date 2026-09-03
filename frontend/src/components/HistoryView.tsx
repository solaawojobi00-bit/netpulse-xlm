import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HistoryPoint, HistoryRange } from "../api";
import { ChartCard, resolveChartStatus } from "./ChartCard";
import { describeSeries } from "./chartSummary";
import { axisStroke, axisTick, chartA11y, tooltipProps } from "./chartTheme";
import { SegmentedControl } from "./SegmentedControl";

interface Props {
  /** null until the first history fetch resolves. */
  points: HistoryPoint[] | null;
  range?: HistoryRange;
  /** History comes from its own REST call, so it fails independently of the
   *  live WebSocket data and carries its own error. */
  error?: string | null;
  /**
   * Supplying both turns the range into a control. They are optional so the
   * component stays renderable as a read-only view in tests and in any future
   * caller that has no range to offer.
   */
  rangeOptions?: readonly { value: HistoryRange; label: string }[];
  onRangeChange?: (next: HistoryRange) => void;
}

export function HistoryView({
  points,
  range = "24h",
  error,
  rangeOptions,
  onRangeChange,
}: Props) {
  const status = resolveChartStatus(points, error);

  /*
   * The picker sits beside the badge rather than replacing it: the badge says
   * what the data *is* (5-minute buckets, kept a week) and the picker says how
   * much of it to show. Losing the first to make room for the second would
   * drop the context that makes the range meaningful.
   *
   * The same block renders in every state, so the control does not vanish
   * while history is loading or failed — those are exactly the moments someone
   * might want to try a shorter range.
   */
  const headerControls = (
    <div className="history-section__controls">
      {rangeOptions && onRangeChange && (
        <SegmentedControl
          label="History time range"
          options={rangeOptions}
          value={range}
          onChange={onRangeChange}
        />
      )}
      <span className="history-badge">5m resolution · 7-day retention</span>
    </div>
  );

  const chartData = (points ?? []).map((p) => {
    const d = new Date(p.timestamp);
    const timeLabel = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const congestionPercent =
      p.congestionUsage !== null ? Number((p.congestionUsage * 100).toFixed(1)) : null;

    return {
      time: timeLabel,
      closeTimeSeconds: p.closeTimeSeconds,
      congestionPercent,
      congestionRaw: p.congestionUsage,
      operations: p.operations,
      transactions: p.transactions,
    };
  });

  const emptyMessage =
    "Historical trend data is accumulating in the persistent SQLite store. Check back after several ledgers close.";
  const errorMessage =
    "Could not load historical trends. The live charts above are unaffected.";

  /*
   * Both history charts are driven by one fetch, so a single state applies to
   * the whole section. Rendering it in each card would print the same message
   * twice for one failure — the duplication this issue is meant to avoid.
   */
  if (status !== "ready") {
    return (
      <section className="history-section" aria-labelledby="history-heading">
        <div className="history-section__header">
          <h2 id="history-heading">{range} Historical Trends</h2>
          {headerControls}
        </div>
        <ChartCard
          title={`${range} trends`}
          status={status}
          emptyMessage={emptyMessage}
          errorMessage={errorMessage}
        >
          {null}
        </ChartCard>
      </section>
    );
  }

  return (
    <section className="history-section" aria-labelledby="history-heading">
      <div className="history-section__header">
        <div>
          <h2 id="history-heading">{range} Historical Trends</h2>
          <p className="history-section__subtitle">
            Coarser historical trend view aggregated from persistent SQLite storage
          </p>
        </div>
        {headerControls}
      </div>

      <div className="chart-grid">
        <ChartCard
          title={`${range} Ledger close time (avg seconds)`}
          status={status}
          emptyMessage={emptyMessage}
          errorMessage={errorMessage}
          summary={describeSeries(
            "Average ledger close time",
            chartData.map((d) => d.closeTimeSeconds),
            "seconds",
          )}
        >
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} {...chartA11y}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
              <XAxis dataKey="time" tick={axisTick} stroke={axisStroke} minTickGap={30} />
              <YAxis tick={axisTick} stroke={axisStroke} width={35} />
              <Tooltip {...tooltipProps} />
              <Line
                type="monotone"
                dataKey="closeTimeSeconds"
                name="Avg close time (s)"
                stroke="var(--accent-color)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>

        <ChartCard
          title={`${range} Network congestion (capacity usage %)`}
          status={status}
          emptyMessage={emptyMessage}
          errorMessage={errorMessage}
          summary={describeSeries(
            "Average capacity usage",
            chartData.map((d) => d.congestionPercent),
            "percent",
          )}
        >
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} {...chartA11y}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
              <XAxis dataKey="time" tick={axisTick} stroke={axisStroke} minTickGap={30} />
              <YAxis
                tick={axisTick}
                stroke={axisStroke}
                width={35}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                {...tooltipProps}
                formatter={(v: any) => [`${v}%`, "Avg congestion"]}
              />
              <Line
                type="monotone"
                dataKey="congestionPercent"
                name="Avg congestion"
                stroke="var(--warn-color)"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </section>
  );
}
