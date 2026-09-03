/*
 * Shared Recharts styling so every chart draws its chrome — axis text, axis
 * lines, tooltip surface — from the same theme tokens as the rest of the app.
 * Recharts' own defaults are fixed greys and a hardcoded white tooltip, which
 * only happen to suit a light background; routing them through custom
 * properties is what lets a data-theme swap re-theme the charts.
 */

/*
 * Recharts puts `tabindex="0"` on every chart <svg>. Inside ChartCard's
 * `role="img"` wrapper that subtree is presentational, so each of those tab
 * stops lands a keyboard user on a node that announces nothing — eight dead
 * stops in a row between the theme toggle and anything actionable.
 *
 * The wrapper's summary is the accessible equivalent of the chart, so the
 * surface itself should not be focusable. Spread this onto every chart root.
 */
export const chartA11y = { tabIndex: -1 } as const;

export const axisTick = { fontSize: 10, fill: "var(--text-muted)" };

export const axisStroke = "var(--border-color)";

export const tooltipProps = {
  contentStyle: {
    background: "var(--surface-color)",
    border: "1px solid var(--border-color)",
    borderRadius: 8,
    color: "var(--text-color)",
    fontSize: 12,
  },
  labelStyle: { color: "var(--text-color)", fontWeight: 600 },
  itemStyle: { color: "var(--text-muted)" },
} as const;

/*
 * Bar charts draw a hover band behind the tooltip; the Recharts default is an
 * opaque light grey that reads as a bright flash on the dark theme.
 */
export const barTooltipCursor = { fill: "var(--border-color)", fillOpacity: 0.5 };
