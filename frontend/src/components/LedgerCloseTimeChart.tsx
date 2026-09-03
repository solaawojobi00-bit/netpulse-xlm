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
import { ChartCard, resolveChartStatus } from "./ChartCard";
import { axisStroke, axisTick, tooltipProps } from "./chartTheme";

interface Props {
  ledgers: LedgerSample[] | null;
  error?: string | null;
}

export function LedgerCloseTimeChart({ ledgers, error }: Props) {
  const data = (ledgers ?? [])
    .filter((l) => l.closeTimeSeconds !== null)
    .map((l) => ({
      sequence: l.sequence,
      closeTimeSeconds: l.closeTimeSeconds,
    }));

  // Resolved from the filtered series: ledgers can arrive with no close times
  // yet, which is an empty chart rather than a loading one.
  const status = resolveChartStatus(ledgers === null ? null : data, error);

  return (
    <ChartCard
      title="Ledger close time"
      status={status}
      emptyMessage="No ledger close times in this window."
      errorMessage="Could not load ledger data."
    >
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
    </ChartCard>
  );
}
