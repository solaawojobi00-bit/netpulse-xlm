/*
 * Recharts renders a bare <svg> full of <path> elements. To a screen reader
 * that is nothing at all — not a wrong description, an absent one. Every chart
 * therefore needs a text equivalent, and eight bespoke sentence builders would
 * drift apart within a release.
 *
 * These helpers produce that equivalent. They deliberately summarise rather
 * than transcribe: a 60-point time series read out point by point is worse
 * than useless, whereas latest / range / direction is the same thing a sighted
 * reader takes from a glance at the line.
 */

/** Trims a float to at most `dp` decimals without leaving a trailing ".0". */
function trim(value: number, dp = 2): string {
  return Number(value.toFixed(dp)).toString();
}

/**
 * Describes a numeric series the way someone would read a line chart aloud:
 * where it sits now, the band it moved through, and which way it is going.
 *
 * Returns null when there is nothing to describe, so callers can fall back to
 * the chart title rather than announcing an empty sentence.
 */
export function describeSeries(
  label: string,
  values: readonly (number | null | undefined)[],
  unit = "",
): string | null {
  const clean = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v),
  );
  if (clean.length === 0) return null;

  const suffix = unit ? ` ${unit}` : "";
  const latest = clean[clean.length - 1];

  if (clean.length === 1) {
    return `${label}: ${trim(latest)}${suffix}.`;
  }

  const min = Math.min(...clean);
  const max = Math.max(...clean);
  const first = clean[0];

  // A flat series should not be described as "steady" only because the
  // endpoints happen to match, so the direction is judged against the spread
  // rather than against zero.
  const span = max - min;
  const delta = latest - first;
  let direction = "steady";
  if (span > 0 && Math.abs(delta) > span * 0.1) {
    direction = delta > 0 ? "rising" : "falling";
  }

  return (
    `${label}: currently ${trim(latest)}${suffix}, ` +
    `${direction} across ${clean.length} points, ` +
    `ranging ${trim(min)} to ${trim(max)}${suffix}.`
  );
}

/** Joins the parts of a multi-series description, dropping the empty ones. */
export function joinSummary(...parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Describes a small fixed set of labelled readings — fee percentiles, the kind
 * of chart where every bar matters and there are few enough to simply list.
 */
export function describeReadings(
  readings: readonly { label: string; value: number | null | undefined }[],
  unit = "",
): string | null {
  const present = readings.filter(
    (r): r is { label: string; value: number } =>
      typeof r.value === "number" && Number.isFinite(r.value),
  );
  if (present.length === 0) return null;

  const suffix = unit ? ` ${unit}` : "";
  return `${present.map((r) => `${r.label} ${trim(r.value)}`).join(", ")}${suffix}.`;
}
