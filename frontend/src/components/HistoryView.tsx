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
import { formatPercent } from "../format";
import { axisStroke, axisTick, tooltipProps } from "./chartTheme";

interface Props {
  points: HistoryPoint[];
  range?: string;
}

export function HistoryView({ points, range = "24h" }: Props) {
  if (points.length === 0) {
    return (
      <section className="history-section">
        <div className="history-section__header">
          <h2>{range} Historical Trends</h2>
          <span className="history-badge">Persistent Storage · 5m Aggregation</span>
        </div>
        <div className="chart-card chart-card--empty">
          <p>
            Historical trend data is accumulating in the persistent SQLite store. Check back after several ledgers close.
          </p>
        </div>
      </section>
    );
  }

  const chartData = points.map((p) => {
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
        <div className="chart-card">
          <h3>24h Ledger close time (avg seconds)</h3>
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
        </div>

        <div className="chart-card">
          <h3>24h Network congestion (capacity usage %)</h3>
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
        </div>
      </div>
    </section>
  );
}
