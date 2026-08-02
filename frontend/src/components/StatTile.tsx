interface StatTileProps {
  label: string;
  value: string;
  sublabel?: string;
  tone?: "neutral" | "good" | "warn" | "bad";
}

const toneClass: Record<NonNullable<StatTileProps["tone"]>, string> = {
  neutral: "stat-tile--neutral",
  good: "stat-tile--good",
  warn: "stat-tile--warn",
  bad: "stat-tile--bad",
};

export function StatTile({ label, value, sublabel, tone = "neutral" }: StatTileProps) {
  return (
    <div className={`stat-tile ${toneClass[tone]}`}>
      <div className="stat-tile__label">{label}</div>
      <div className="stat-tile__value">{value}</div>
      {sublabel && <div className="stat-tile__sublabel">{sublabel}</div>}
    </div>
  );
}
