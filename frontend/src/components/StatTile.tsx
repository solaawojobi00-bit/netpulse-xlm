interface StatTileProps {
  label: string;
  value: string | null;
  sublabel?: string | null;
  tone?: "neutral" | "good" | "warn" | "bad";
  loading?: boolean;
  /**
   * A severity word to render as a chip — the congestion band, currently the
   * only thing that carries a tone. Kept separate from `sublabel` because a
   * band is a classification and needs the glyph, whereas a sublabel is just
   * secondary text.
   */
  band?: string | null;
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
  loading = false,
  band,
}: StatTileProps) {
  return (
    <div className={`stat-tile ${toneClass[tone]} ${loading ? "stat-tile--loading" : ""}`}>
      <div className="stat-tile__label">{label}</div>
      {loading ? (
        /*
         * `aria-label` on a bare <div> is ignored by screen readers — a
         * generic element with no role cannot take an accessible name, so the
         * previous `aria-label="Loading..."` announced nothing at all. The
         * status role both makes the name count and marks the region as one
         * that will update.
         */
        <div
          className="stat-tile__skeleton"
          role="status"
          aria-label={`${label}: loading`}
        />
      ) : (
        <div className="stat-tile__value">{value ?? "—"}</div>
      )}
      {loading ? (
        <div className="stat-tile__skeleton stat-tile__skeleton--sub" aria-hidden="true" />
      ) : (
        <>
          {band && (
            <div className="stat-tile__band">
              <span className="stat-tile__band-glyph" aria-hidden="true">
                {toneGlyph[tone]}
              </span>
              {band}
            </div>
          )}
          {sublabel && <div className="stat-tile__sublabel">{sublabel}</div>}
        </>
      )}
    </div>
  );
}
