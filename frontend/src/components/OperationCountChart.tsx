import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { LedgerSample } from "../api";

interface Props {
  ledgers: LedgerSample[];
}

export function OperationCountChart({ ledgers }: Props) {
  const data = ledgers.map((l) => ({
    sequence: l.sequence,
    operationCount: l.operationCount,
  }));

  return (
    <div className="chart-card">
      <h3>Operation count per ledger</h3>
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
          <XAxis dataKey="sequence" tick={{ fontSize: 10 }} minTickGap={25} />
          <YAxis tick={{ fontSize: 10 }} width={35} />
          <Tooltip />
          <Bar dataKey="operationCount" fill="var(--accent-color)" />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
