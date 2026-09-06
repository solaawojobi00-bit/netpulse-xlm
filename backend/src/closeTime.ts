/**
 * The definition of a valid ledger close time, and the one way to compute one.
 *
 * This lives apart from `horizon.ts` deliberately. That module is the network
 * boundary, and tests replace it wholesale to keep Horizon out of the suite —
 * so a pure domain predicate placed there disappears under any such mock. It
 * is also imported by aggregation code (`metrics.ts`, and the daily rollups in
 * #91) that has no business depending on the Horizon client for a function
 * that touches no network.
 */

/**
 * Whether a close time is a usable measurement.
 *
 * A close time is the elapsed gap to the immediately preceding ledger, so a
 * real one is finite and strictly positive. A zero or negative value is not a
 * very fast ledger — it is a delta taken against the wrong neighbour, an
 * out-of-order record, or an unparseable timestamp. Treating one as data lets
 * a single bad sample dominate any average over the window: a window holding
 * 30 stale ledgers once reported an average close time of about -8.4 months
 * (#84).
 *
 * This is the single definition of validity. Anything aggregating
 * `closeTimeSeconds` must filter by it, or express the same `finite AND > 0`
 * rule where a predicate cannot reach — SQL, for the daily rollups in #91.
 */
export function isValidCloseTimeSeconds(
  value: number | null | undefined,
): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * `isValidCloseTimeSeconds` as a SQL predicate, for aggregates that a
 * TypeScript function cannot reach.
 *
 * The `< 9e999` half is not redundant, and this is the trap it exists to
 * avoid: `9e999` overflows to `+Infinity` in SQLite, and `+Infinity > 0` is
 * true, so a bare `> 0` check **passes an infinite value through** and turns
 * the whole aggregate into `Infinity` — measured, not assumed. A `NaN` needs no
 * guard: SQLite stores it as `NULL`, which every aggregate here already skips.
 *
 * Kept beside the predicate it mirrors so the two cannot drift into disagreeing
 * about what counts as a usable sample.
 */
export function validCloseTimeSql(column: string): string {
  return `${column} > 0 AND ${column} < 9e999`;
}

/**
 * Seconds between two ledger close timestamps, or `null` when that cannot be
 * measured — no predecessor, an unparseable timestamp, or a result that fails
 * `isValidCloseTimeSeconds`.
 *
 * Returning `null` rather than a negative number matters: `null` already means
 * "not measured" everywhere downstream, and charts render it as a gap. A
 * negative number is rendered, averaged, and persisted as though it were real.
 *
 * `previousClosedAt` must be the close time of the ledger that immediately
 * precedes this one **by sequence**, not merely the newest one a caller
 * happens to hold.
 */
export function closeTimeSecondsBetween(
  previousClosedAt: string | null | undefined,
  closedAt: string,
): number | null {
  if (!previousClosedAt) return null;

  const delta =
    (new Date(closedAt).getTime() - new Date(previousClosedAt).getTime()) / 1000;

  return isValidCloseTimeSeconds(delta) ? delta : null;
}
