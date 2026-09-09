import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { TrendPoint, TrendRange } from "../api";
import { ChartCard, resolveChartStatus } from "./ChartCard";
import { describeSeries } from "./chartSummary";
import { axisStroke, axisTick, chartA11y, tooltipProps } from "./chartTheme";
import { SegmentedControl } from "./SegmentedControl";
import { formatTrendDate } from "./trendDate";

interface Props {
  /** null until the first trends fetch resolves. */
  points: TrendPoint[] | null;
  range?: TrendRange;
  /** Trends come from their own REST call, so they fail independently of both
   *  the live WebSocket data and the history view, and carry their own error. */
  error?: string | null;
  /**
   * Supplying both turns the range into a control. They are optional so the
   * component stays renderable as a read-only view in tests, mirroring
   * HistoryView.
   */
  rangeOptions?: readonly { value: TrendRange; label: string }[];
  onRangeChange?: (next: TrendRange) => void;
}

export function TrendsView({
  points,
  range = "90d",
  error,
  rangeOptions,
  onRangeChange,
}: Props) {
  const status = resolveChartStatus(points, error);

  /*
   * Same arrangement as HistoryView: the badge says what the data *is* and the
   * picker says how much of it to show, and both render in every state so the
   * control does not vanish while the panel is loading or failed — exactly the
   * moments someone might want a different range.
   *
   * The badge deliberately contrasts with history's "5m resolution · 7-day
   * retention". The two panels sit one above the other showing overlapping
   * dates at different grains, so saying which store each reads from is what
   * stops them looking like the same chart disagreeing with itself.
   */
  const headerControls = (
    <div className="history-section__controls">
      {rangeOptions && onRangeChange && (
        <SegmentedControl
          label="Trend time range"
          options={rangeOptions}
          value={range}
          onChange={onRangeChange}
        />
      )}
      <span className="history-badge">
        Daily resolution · retained indefinitely
      </span>
    </div>
  );

  const chartData = (points ?? []).map((p) => {
    const toPercent = (v: number | null) =>
      v !== null ? Number((v * 100).toFixed(1)) : null;

    return {
      date: formatTrendDate(p.date),
      closeTimeSeconds: p.closeTimeSeconds,
      congestionPercent: toPercent(p.congestionUsage),
      maxCongestionPercent: toPercent(p.maxCongestionUsage),
    };
  });

  /*
   * At daily grain the wait is until tomorrow, so history's "check back after
   * several ledgers close" would be misleading — a reader would refresh in a
   * minute and see the same empty panel.
   */
  const emptyMessage =
    "No daily rollups yet. Each UTC day is summarised once it completes, so the first point appears after this backend has been running through a full day.";
  const errorMessage =
    "Could not load long-range trends. The history and live charts above are unaffected.";

  /*
   * One fetch drives every card here, so a single status applies to the whole
   * section. Rendering it per card would print the same message twice for one
   * failure — the duplication #72 exists to avoid.
   */
  if (status !== "ready") {
    return (
      <section className="history-section" aria-labelledby="trends-heading">
        <div className="history-section__header">
          <h2 id="trends-heading">{range} Long-Range Trends</h2>
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

  /*
   * minTickGap thins the labels rather than rotating or dropping them: at 1y
   * there are 365 candidate ticks in the same width that holds 30, and Recharts
   * will happily overprint them into an unreadable smear.
   */
  const minTickGap = 40;

  return (
    <section className="history-section" aria-labelledby="trends-heading">
      <div className="history-section__header">
        <div>
          <h2 id="trends-heading">{range} Long-Range Trends</h2>
          <p className="history-section__subtitle">
            Daily aggregates from persistent storage, kept beyond the raw
            retention window
          </p>
        </div>
        {headerControls}
      </div>

      <div className="chart-grid">
        <ChartCard
          title={`${range} Daily ledger close time (avg seconds)`}
          status={status}
          emptyMessage={emptyMessage}
          errorMessage={errorMessage}
          summary={describeSeries(
            "Daily average ledger close time",
            chartData.map((d) => d.closeTimeSeconds),
            "seconds",
          )}
        >
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} {...chartA11y}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
              <XAxis
                dataKey="date"
                tick={axisTick}
                stroke={axisStroke}
                minTickGap={minTickGap}
              />
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
          title={`${range} Daily congestion, average and peak (capacity usage %)`}
          status={status}
          emptyMessage={emptyMessage}
          errorMessage={errorMessage}
          summary={describeSeries(
            "Daily peak capacity usage",
            chartData.map((d) => d.maxCongestionPercent),
            "percent",
          )}
        >
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData} {...chartA11y}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
              <XAxis
                dataKey="date"
                tick={axisTick}
                stroke={axisStroke}
                minTickGap={minTickGap}
              />
              <YAxis
                tick={axisTick}
                stroke={axisStroke}
                width={35}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                {...tooltipProps}
                formatter={(v, name) => [`${String(v)}%`, name]}
              />
              {/*
               * Peak alongside average, because a day that averages calm can
               * still have spent an hour saturated — and at daily grain the
               * average alone hides exactly the event someone opens this panel
               * to find.
               */}
              <Line
                type="monotone"
                dataKey="maxCongestionPercent"
                name="Peak congestion"
                stroke="var(--warn-color)"
                strokeWidth={2}
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="congestionPercent"
                name="Avg congestion"
                stroke="var(--accent-color)"
                strokeWidth={2}
                strokeDasharray="4 3"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </ChartCard>
      </div>
    </section>
  );
}
