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
import { ChartCard, resolveChartStatus } from "./ChartCard";
import { axisStroke, axisTick, barTooltipCursor, tooltipProps } from "./chartTheme";

interface Props {
  fees: HealthResponse["fees"] | null;
  error?: string | null;
}

export function FeePercentileChart({ fees, error }: Props) {
  const data = fees
    ? [
        { percentile: "p10", stroops: fees.p10 },
        { percentile: "p50", stroops: fees.p50 },
        { percentile: "p90", stroops: fees.p90 },
        { percentile: "p99", stroops: fees.p99 },
      ]
    : null;

  /*
   * This chart's shape is fixed at four bars, so "empty" cannot be detected by
   * length — a health response with every percentile null still yields four
   * rows. Filtering to the populated ones makes the distinction real.
   */
  const populated = data?.filter((d) => d.stroops !== null) ?? null;

  return (
    <ChartCard
      title="Fee charged percentiles (stroops)"
      status={resolveChartStatus(populated, error)}
      emptyMessage="No fee percentiles reported yet."
      errorMessage="Could not load fee data."
    >
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data ?? []}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
          <XAxis dataKey="percentile" tick={axisTick} stroke={axisStroke} />
          <YAxis tick={axisTick} stroke={axisStroke} width={45} />
          <Tooltip {...tooltipProps} cursor={barTooltipCursor} />
          <Bar dataKey="stroops" fill="var(--accent-color-2)" />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
