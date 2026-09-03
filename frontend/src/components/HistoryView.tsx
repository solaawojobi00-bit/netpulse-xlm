import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HistoryPoint } from "../api";
import { ChartCard, resolveChartStatus } from "./ChartCard";
import { axisStroke, axisTick, tooltipProps } from "./chartTheme";

interface Props {
  /** null until the first history fetch resolves. */
  points: HistoryPoint[] | null;
  range?: string;
  /** History comes from its own REST call, so it fails independently of the
   *  live WebSocket data and carries its own error. */
  error?: string | null;
}

export function HistoryView({ points, range = "24h", error }: Props) {
  const status = resolveChartStatus(points, error);

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
      <section className="history-section">
        <div className="history-section__header">
          <h2>{range} Historical Trends</h2>
          <span className="history-badge">Persistent Storage · 5m Aggregation</span>
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
    <section className="history-section">
      <div className="history-section__header">
        <div>
          <h2>{range} Historical Trends</h2>
          <p className="history-section__subtitle">
            Coarser historical trend view aggregated from persistent SQLite storage
          </p>
        </div>
        <span className="history-badge">5m resolution · 7-day retention</span>
      </div>

      <div className="chart-grid">
        <ChartCard
          title={`${range} Ledger close time (avg seconds)`}
          status={status}
          emptyMessage={emptyMessage}
          errorMessage={errorMessage}
        >
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
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
        >
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={chartData}>
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
