import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { LedgerSample } from "../api";
import { axisStroke, axisTick, tooltipProps } from "./chartTheme";

interface Props {
  ledgers: LedgerSample[];
}

export function LedgerCloseTimeChart({ ledgers }: Props) {
  const data = ledgers
    .filter((l) => l.closeTimeSeconds !== null)
    .map((l) => ({
      sequence: l.sequence,
      closeTimeSeconds: l.closeTimeSeconds,
    }));

  return (
    <div className="chart-card">
      <h3>Ledger close time</h3>
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
          <XAxis
            dataKey="sequence"
            tick={axisTick}
            stroke={axisStroke}
            minTickGap={25}
          />
          <YAxis
            tick={axisTick}
            stroke={axisStroke}
            width={35}
            label={{
              value: "seconds",
              angle: -90,
              position: "insideLeft",
              fontSize: 10,
              fill: "var(--text-muted)",
            }}
          />
          <Tooltip {...tooltipProps} />
          <Line
            type="monotone"
            dataKey="closeTimeSeconds"
            stroke="var(--accent-color)"
            dot={false}
            strokeWidth={2}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
