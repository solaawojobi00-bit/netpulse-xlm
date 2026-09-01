interface StatTileProps {
  label: string;
  value: string;
  sublabel?: string;
  tone?: "neutral" | "good" | "warn" | "bad";
  loading?: boolean;
}

const toneClass: Record<NonNullable<StatTileProps["tone"]>, string> = {
  neutral: "stat-tile--neutral",
  good: "stat-tile--good",
  warn: "stat-tile--warn",
  bad: "stat-tile--bad",
};

export function StatTile({
  label,
  value,
  sublabel,
  tone = "neutral",
  loading = false,
}: StatTileProps) {
  return (
    <div className={`stat-tile ${toneClass[tone]} ${loading ? "stat-tile--loading" : ""}`}>
      <div className="stat-tile__label">{label}</div>
      {loading ? (
        <div className="stat-tile__skeleton" aria-label="Loading..." />
      ) : (
        <div className="stat-tile__value">{value}</div>
      )}
      {loading ? (
        <div className="stat-tile__skeleton stat-tile__skeleton--sub" aria-hidden="true" />
      ) : (
        sublabel && <div className="stat-tile__sublabel">{sublabel}</div>
      )}
    </div>
  );
}
