import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { HealthResponse } from "../api";

interface Props {
  fees: HealthResponse["fees"];
}

export function FeePercentileChart({ fees }: Props) {
  const data = [
    { percentile: "p10", stroops: fees.p10 },
    { percentile: "p50", stroops: fees.p50 },
    { percentile: "p90", stroops: fees.p90 },
    { percentile: "p99", stroops: fees.p99 },
  ];

  return (
    <div className="chart-card">
      <h3>Fee charged percentiles (stroops)</h3>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
          <XAxis dataKey="percentile" tick={{ fontSize: 10 }} />
          <YAxis tick={{ fontSize: 10 }} width={45} />
          <Tooltip />
          <Bar dataKey="stroops" fill="var(--accent-color-2)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
