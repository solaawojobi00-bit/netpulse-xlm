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
import type { FeeSnapshot } from "../api";
import { ChartCard, resolveChartStatus } from "./ChartCard";
import { axisStroke, axisTick, tooltipProps } from "./chartTheme";

interface Props {
  snapshots: FeeSnapshot[] | null;
  error?: string | null;
}

export function FeeSpreadTrendChart({ snapshots, error }: Props) {
  const data = (snapshots ?? []).map((s, index) => {
    const time = new Date(s.fetchedAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const spread = Math.max(0, s.feeChargedP90 - s.feeChargedP50);

    return {
      time: time || `#${index + 1}`,
      spread,
      p50: s.feeChargedP50,
      p90: s.feeChargedP90,
    };
  });

  return (
    <ChartCard
      title="Fee surge spread trend (p90 − p50 stroops)"
      status={resolveChartStatus(snapshots, error)}
      emptyMessage="No fee snapshots in this window."
      errorMessage="Could not load fee data."
    >
      <ResponsiveContainer width="100%" height={200}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--grid-color)" />
          <XAxis dataKey="time" tick={axisTick} stroke={axisStroke} minTickGap={25} />
          <YAxis tick={axisTick} stroke={axisStroke} width={45} />
          <Tooltip {...tooltipProps} />
          <Legend wrapperStyle={{ fontSize: "11px", paddingTop: "4px" }} />
          <Line
            type="monotone"
            dataKey="spread"
            name="Surge spread (p90 − p50)"
            stroke="var(--warn-color)"
            strokeWidth={2}
            dot={{ r: 2 }}
          />
          <Line
            type="monotone"
            dataKey="p90"
            name="p90 fee"
            stroke="var(--accent-color)"
            strokeWidth={1.5}
            strokeDasharray="3 3"
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
