import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { OperationBreakdownResponse } from "../api";
import { formatOperationType, formatWindow } from "../format";
import { ChartCard, resolveChartStatus } from "./ChartCard";
import { axisStroke, axisTick, barTooltipCursor, chartA11y, tooltipProps } from "./chartTheme";

interface Props {
  breakdown: OperationBreakdownResponse | null;
  error?: string | null;
}

/*
 * Horizontal bars, not a pie.
 *
 * The distribution is very uneven — payments and offers dominate while several
 * types sit near zero — and a pie of seven wedges where four are slivers is
 * unreadable. Bars sorted by size compare lengths against a shared baseline,
 * which is the comparison being asked for, and the horizontal layout gives the
 * type names room to be words rather than truncated identifiers.
 *
 * Every bar is the same colour. The categories are nominal — there is no sense
 * in which `payment` is "more" than `change_trust` — so shading them by value
 * would double-encode length as hue and spend the one free channel on
 * information the bar length already carries. Identity lives on the axis.
 *
 * The one exception is the grouped tail, which is muted because it is a
 * different kind of row: not an operation type but a bucket of them. That is
 * signalled by its axis label too, so the distinction is never colour alone.
 */
const CHART_HEIGHT = 260;

export function OperationTypeChart({ breakdown, error }: Props) {
  const rows = breakdown?.breakdown ?? null;
  const status = resolveChartStatus(rows, error);

  const data = (rows ?? []).map((row) => ({
    label: row.isOther ? "Other types" : formatOperationType(row.type),
    count: row.count,
    percent: Math.round(row.share * 1000) / 10,
    isOther: row.isOther,
  }));

  const total = breakdown?.totalOperations ?? 0;
  const window = formatWindow(breakdown?.windowSeconds ?? null);

  /*
   * Says what the number is, because "1,412 payments" invites being read as a
   * per-ledger or all-time figure. It is neither: it is a count over a rolling
   * sample of recent polls.
   */
  const subtitle = (
    <p className="chart-card__note">
      {total.toLocaleString()} operations sampled over {window}
      {breakdown && breakdown.distinctTypes > data.length
        ? ` · ${breakdown.distinctTypes} types seen`
        : ""}
    </p>
  );

  const summary =
    data.length > 0
      ? `${total.toLocaleString()} operations sampled over ${window}. ` +
        data.map((d) => `${d.label} ${d.count} (${d.percent}%)`).join(", ") +
        "."
      : null;

  return (
    <ChartCard
      className="operation-type-card"
      title="Operation types"
      status={status}
      height={CHART_HEIGHT}
      subtitle={subtitle}
      summary={summary}
      emptyMessage="No operations in the recent sample window."
      errorMessage="Could not load the operation breakdown."
    >
      <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 12, bottom: 0, left: 0 }}
          // Thin marks with room around them; a stack of 30px slabs reads loud
          // and leaves the labels feeling cramped against them.
          barCategoryGap="30%"
          {...chartA11y}
        >
          {/* Vertical only: horizontal rules behind horizontal bars would
              trace the bars themselves rather than help read their length. */}
          <CartesianGrid stroke="var(--grid-color)" horizontal={false} />
          <XAxis type="number" tick={axisTick} stroke={axisStroke} allowDecimals={false} />
          <YAxis
            type="category"
            dataKey="label"
            tick={axisTick}
            stroke={axisStroke}
            width={132}
            interval={0}
          />
          <Tooltip
            {...tooltipProps}
            cursor={barTooltipCursor}
            formatter={(value, _name, entry) => {
              const percent = (entry as { payload?: { percent?: number } })?.payload?.percent;
              return [
                `${Number(value).toLocaleString()}${percent === undefined ? "" : ` (${percent}%)`}`,
                "Operations",
              ];
            }}
          />
          <Bar dataKey="count" radius={[0, 4, 4, 0]} isAnimationActive={false}>
            {data.map((row) => (
              <Cell
                key={row.label}
                fill={row.isOther ? "var(--text-muted)" : "var(--accent-color)"}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}
