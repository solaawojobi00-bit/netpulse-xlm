/*
 * One rule for "what is this thing's state right now", shared by the chart
 * cards and the stat tiles.
 *
 * It lives in its own module rather than inside ChartCard because the tiles
 * need it too, and a second copy of the precedence would drift from this one
 * the first time either is touched (#71).
 */

export type ChartStatus = "loading" | "error" | "empty" | "ready";

/*
 * Status precedence, and why it is this order:
 *
 *   ready > error > loading > empty
 *
 * `ready` wins even when the source is currently erroring, because the six
 * live charts share one WebSocket subscription. Blanking all of them on a
 * dropped connection would throw away data that is seconds old and replace it
 * with six identical error boxes, while the global banner already says the
 * backend is unreachable. Showing the last known values is both more useful
 * and quieter.
 *
 * So a per-component error appears only when there is nothing to fall back on
 * — a cold start that never succeeded — which is exactly when an empty frame
 * would otherwise be indistinguishable from a quiet network.
 */
function resolve(
  hasContent: boolean,
  isAbsent: boolean,
  error?: string | null,
): ChartStatus {
  if (hasContent) return "ready";
  if (error) return "error";
  if (isAbsent) return "loading";
  return "empty";
}

/**
 * For a series: a populated array is ready, an absent one is still loading,
 * and a present-but-empty one is a genuinely quiet window.
 */
export function resolveChartStatus(
  data: readonly unknown[] | null | undefined,
  error?: string | null,
): ChartStatus {
  return resolve(
    Boolean(data) && (data as readonly unknown[]).length > 0,
    data === null || data === undefined,
    error,
  );
}

/**
 * For a single value — pass the *source* the component reads from, not the
 * individual field it displays.
 *
 * A stat tile showing `health.fees.baseFeeStroops` is ready as soon as
 * `health` arrives, even if that particular field came back null; the tile
 * renders an em dash for it, which is a real answer rather than a missing
 * one. Passing the field instead of the source would report "loading" forever
 * whenever the backend legitimately has no number for it.
 *
 * `empty` is unreachable here: a scalar is either present or it is not.
 */
export function resolveValueStatus(
  source: unknown,
  error?: string | null,
): ChartStatus {
  const absent = source === null || source === undefined;
  return resolve(!absent, absent, error);
}
