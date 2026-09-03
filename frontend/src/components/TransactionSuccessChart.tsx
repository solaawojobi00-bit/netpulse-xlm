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
import { ChartCard, resolveChartStatus } from "./ChartCard";
import { describeSeries, joinSummary } from "./chartSummary";
import { axisStroke, axisTick, barTooltipCursor, chartA11y, tooltipProps } from "./chartTheme";

interface Props {
  ledgers: LedgerSample[] | null;
  error?: string | null;
}

export function TransactionSuccessChart({ ledgers, error }: Props) {
  const data = (ledgers ?? []).map((l) => {
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
    <ChartCard
      title="Transaction success & failure"
      status={resolveChartStatus(ledgers, error)}
      emptyMessage="No transactions in this window."
      errorMessage="Could not load transaction data."
      summary={joinSummary(
        describeSeries(
          "Successful transactions per ledger",
          data.map((d) => d.successful),
        ),
        describeSeries(
          "Failed transactions per ledger",
          data.map((d) => d.failed),
        ),
      )}
    >
      <ResponsiveContainer width="100%" height={200}>
        <BarChart data={data} {...chartA11y}>
          {/*
            Successful and failed were separated by hue alone — green against
            red. Measured through a protanopia simulation those two sit at a
            CIE76 distance of 12 on the light theme, which is not a difference
            anyone can rely on. The hatch gives the failed segments a texture,
            so the two stack segments stay distinct in greyscale, in print, and
            under any colour-vision deficiency.
          */}
          <defs>
            <pattern
              id="tx-failed-hatch"
              patternUnits="userSpaceOnUse"
              width="6"
              height="6"
              patternTransform="rotate(45)"
            >
              <rect width="6" height="6" fill="var(--bad-color)" />
              <line x1="0" y1="0" x2="0" y2="6" stroke="var(--surface-color)" strokeWidth="3" />
            </pattern>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
          <XAxis
            dataKey="sequence"
            tick={axisTick}
            stroke={axisStroke}
            minTickGap={25}
          />
          <YAxis tick={axisTick} stroke={axisStroke} width={35} />
          <Tooltip {...tooltipProps} cursor={barTooltipCursor} />
          <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "4px" }} />
          <Bar dataKey="successful" stackId="txs" fill="var(--good-color)" name="Successful" />
          <Bar
            dataKey="failed"
            stackId="txs"
            fill="url(#tx-failed-hatch)"
            stroke="var(--bad-color)"
            name="Failed"
          />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
