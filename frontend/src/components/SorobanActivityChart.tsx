import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { SorobanMetricsResponse } from "../api";
import { ChartCard, resolveChartStatus } from "./ChartCard";
import { axisStroke, axisTick, tooltipProps } from "./chartTheme";

interface Props {
  soroban: SorobanMetricsResponse | null;
  error?: string | null;
}

export function SorobanActivityChart({ soroban, error }: Props) {
  // null means the metrics have not arrived; an empty samples array means they
  // arrived and there was no contract activity. Only the second is "quiet".
  const samples = soroban ? soroban.samples : null;
  const chartData = (samples ?? []).map((s) => {
    const d = new Date(s.timestamp);
    return {
      name: d.toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
      invocations: s.invocationsCount,
      successful: s.successfulCount,
      failed: s.failedCount,
    };
  });

  const invocationsPerSec = soroban?.invocationsPerSecond ?? 0;
  const recentTotal = soroban?.recentInvocationsTotal ?? 0;

  return (
    <ChartCard
      className="soroban-card"
      title="Soroban Contract Invocations"
      status={resolveChartStatus(samples, error)}
      emptyMessage="No Soroban smart contract invocations in the recent sample window. Classic Stellar operations are tracked above."
      errorMessage="Could not load Soroban metrics."
      subtitle={
        <p className="soroban-card__subtitle">
          Smart contract activity (<code>invoke_host_function</code>) separated from classic Stellar ops
        </p>
      }
      headerExtra={
        <div className="soroban-card__stats">
          <span className="soroban-stat">
            <strong>{invocationsPerSec}</strong> inv/s
          </span>
          <span className="soroban-stat soroban-stat--muted">
            {recentTotal} total in window
          </span>
        </div>
      }
    >
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
          <XAxis dataKey="name" tick={axisTick} stroke={axisStroke} minTickGap={25} />
          <YAxis
            tick={axisTick}
            stroke={axisStroke}
            width={35}
            allowDecimals={false}
          />
          <Tooltip {...tooltipProps} />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            type="monotone"
            dataKey="successful"
            name="Successful Invocations"
            stroke="var(--good-color)"
            strokeWidth={2}
            dot={false}
          />
          <Line
            type="monotone"
            dataKey="failed"
            name="Failed Invocations"
            stroke="var(--bad-color)"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
