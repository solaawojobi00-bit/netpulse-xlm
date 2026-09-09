/**
 * Formats a `YYYY-MM-DD` UTC day for the trends X axis.
 *
 * The explicit `T00:00:00Z` and `timeZone: "UTC"` are both load-bearing.
 * `new Date("2026-09-01")` is parsed as UTC midnight but *rendered* in local
 * time, so west of Greenwich every label would slip to the previous day — a
 * chart quietly mislabelled by one day, which is far worse than an obviously
 * broken one. Exported so that behaviour is testable: Recharts renders nothing
 * at jsdom's zero width, so an axis label cannot be asserted through the DOM.
 *
 * It lives here rather than in TrendsView.tsx because a module that exports
 * both a component and a plain function drops that file out of Fast Refresh —
 * `react-refresh/only-export-components`, the last lint warning standing when
 * #150 raised `set-state-in-effect` to error.
 */
export function formatTrendDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString([], {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}
