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

interface Props {
  soroban: SorobanMetricsResponse | null;
}

export function SorobanActivityChart({ soroban }: Props) {
  const samples = soroban?.samples ?? [];
  const chartData = samples.map((s, idx) => {
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
    <div className="chart-card soroban-card">
      <div className="soroban-card__header">
        <div>
          <h3>Soroban Contract Invocations</h3>
          <p className="soroban-card__subtitle">
            Smart contract activity (<code>invoke_host_function</code>) separated from classic Stellar ops
          </p>
        </div>
        <div className="soroban-card__stats">
          <span className="soroban-stat">
            <strong>{invocationsPerSec}</strong> inv/s
          </span>
          <span className="soroban-stat soroban-stat--muted">
            {recentTotal} total in window
          </span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
          <XAxis dataKey="name" tick={{ fontSize: 10 }} minTickGap={25} />
          <YAxis tick={{ fontSize: 10 }} width={35} allowDecimals={false} />
          <Tooltip />
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

      {recentTotal === 0 && (
        <p className="soroban-card__empty-note">
          No Soroban smart contract invocations in the recent sample window. Classic Stellar operations are tracked above.
        </p>
      )}
    </div>
  );
}
