import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { LedgerSample } from "../api";

interface Props {
  ledgers: LedgerSample[];
}

export function TransactionSuccessChart({ ledgers }: Props) {
  const data = ledgers.map((l) => {
    const successful = l.successfulTransactionCount ?? 0;
    const failed = l.failedTransactionCount ?? 0;
    const total = successful + failed;
    const failureRate = total > 0 ? Number(((failed / total) * 100).toFixed(1)) : 0;

    return {
      sequence: l.sequence,
      successful,
      failed,
      failureRate: `${failureRate}%`,
    };
  });

  return (
    <div className="chart-card">
      <h3>Transaction success & failure</h3>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
          <XAxis dataKey="sequence" tick={{ fontSize: 11 }} />
          <YAxis tick={{ fontSize: 11 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "4px" }} />
          <Bar dataKey="successful" stackId="txs" fill="var(--good-color)" name="Successful" />
          <Bar dataKey="failed" stackId="txs" fill="var(--bad-color)" name="Failed" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
