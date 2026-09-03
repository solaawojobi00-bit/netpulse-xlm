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
import { ChartCard, resolveChartStatus } from "./ChartCard";
import { describeSeries } from "./chartSummary";
import { axisStroke, axisTick, barTooltipCursor, chartA11y, tooltipProps } from "./chartTheme";

interface Props {
  ledgers: LedgerSample[] | null;
  error?: string | null;
}

export function OperationCountChart({ ledgers, error }: Props) {
  const data = (ledgers ?? []).map((l) => ({
    sequence: l.sequence,
    operationCount: l.operationCount,
  }));

  return (
    <ChartCard
      title="Operation count per ledger"
      status={resolveChartStatus(ledgers, error)}
      emptyMessage="No ledgers in this window."
      errorMessage="Could not load ledger data."
      summary={describeSeries(
        "Operations per ledger",
        data.map((d) => d.operationCount),
      )}
    >
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} {...chartA11y}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
          <XAxis
            dataKey="sequence"
            tick={axisTick}
            stroke={axisStroke}
            minTickGap={25}
          />
          <YAxis tick={axisTick} stroke={axisStroke} width={35} />
          <Tooltip {...tooltipProps} cursor={barTooltipCursor} />
          <Bar dataKey="operationCount" fill="var(--accent-color)" />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
