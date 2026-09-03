import type { ChartStatus } from "./resolveStatus";

interface StatTileProps {
  label: string;
  value: string | null;
  sublabel?: string | null;
  tone?: "neutral" | "good" | "warn" | "bad";
  /**
   * Where the tile's source stands. Replaces the old `loading` boolean, which
   * could only say "no data yet" and so left the skeleton pulsing forever
   * whenever the backend was unreachable — the animation promising data was
   * about to arrive at exactly the moment it was not (#71).
   *
   * Compute it with `resolveValueStatus` so the tiles and the chart cards
   * agree on precedence rather than each keeping their own rule.
   */
  status?: ChartStatus;
  /**
   * A severity word to render as a chip — the congestion band, currently the
   * only thing that carries a tone. Kept separate from `sublabel` because a
   * band is a classification and needs the glyph, whereas a sublabel is just
   * secondary text.
   */
  band?: string | null;
  /** Shown in place of the value when the source failed. */
  errorMessage?: string;
}

const toneClass: Record<NonNullable<StatTileProps["tone"]>, string> = {
  neutral: "stat-tile--neutral",
  good: "stat-tile--good",
  warn: "stat-tile--warn",
  bad: "stat-tile--bad",
};

/*
 * A shape per severity, so the band does not depend on its colour. These are
 * decorative duplicates of the word beside them and are hidden from assistive
 * technology; they exist for sighted users in greyscale, in bright sunlight,
 * or with a colour-vision deficiency.
 */
const toneGlyph: Record<NonNullable<StatTileProps["tone"]>, string> = {
  neutral: "○",
  good: "●",
  warn: "▲",
  bad: "■",
};

export function StatTile({
  label,
  value,
  sublabel,
  tone = "neutral",
  status = "ready",
  band,
  errorMessage = "Unavailable",
}: StatTileProps) {
  const loading = status === "loading";
  const failed = status === "error";
  // "empty" cannot occur for a scalar source, but rendering the value is the
  // harmless reading if one ever arrives.
  const showValue = !loading && !failed;

  return (
    <div
      className={`stat-tile ${toneClass[tone]} ${loading ? "stat-tile--loading" : ""} ${
        failed ? "stat-tile--error" : ""
      }`
        .replace(/\s+/g, " ")
        .trim()}
    >
      <div className="stat-tile__label">{label}</div>

      {loading && (
        /*
         * `aria-label` on a bare <div> is ignored by screen readers — a
         * generic element with no role cannot take an accessible name, so the
         * original `aria-label="Loading..."` announced nothing at all. The
         * status role both makes the name count and marks the region as one
         * that will update.
         */
        <div
          className="stat-tile__skeleton"
          role="status"
          aria-label={`${label}: loading`}
        />
      )}

      {failed && (
        /*
         * Polite, like the chart cards' error state and for the same reason:
         * one outage puts this on all five tiles at once, and five assertive
         * interruptions for a single cause is worse than none. The global
         * banner does the announcing; this labels which number is missing.
         */
        <div
          className="stat-tile__unavailable"
          role="status"
          aria-label={`${label}: unavailable`}
        >
          {errorMessage}
        </div>
      )}

      {showValue && <div className="stat-tile__value">{value ?? "—"}</div>}

      {/*
        The sub-row holds the same height in every state, so a tile does not
        change size as its band or sublabel appears.
      */}
      <div className="stat-tile__sub">
        {showValue && (
          <>
            {band && (
              <span className="stat-tile__band">
                <span className="stat-tile__band-glyph" aria-hidden="true">
                  {toneGlyph[tone]}
                </span>
                {band}
              </span>
            )}
            {sublabel && <span className="stat-tile__sublabel">{sublabel}</span>}
          </>
        )}
        {/*
          Only while loading. An erroring tile shows nothing here rather than a
          second pulsing bar — the pulse is the very thing that made an outage
          look like an arrival, and putting it back in the sub-row would
          reintroduce the defect one line below the fix.
        */}
        {loading && (
          <span className="stat-tile__skeleton stat-tile__skeleton--sub" aria-hidden="true" />
        )}
      </div>
    </div>
  );
}
