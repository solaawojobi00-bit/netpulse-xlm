/**
 * Formatting threshold for large fee values in stroops.
 * Values at or above 1,000,000 stroops are formatted with compact units (e.g. "20.0M stroops")
 * to preserve readability and prevent stat tile layout overflow during surge pricing.
 */
export const COMPACT_STROOP_THRESHOLD = 1_000_000;

export function formatSeconds(value: number | null, digits = 1): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${value.toFixed(digits)}s`;
}

export function formatStroops(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";

  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B stroops`;
  }
  if (value >= COMPACT_STROOP_THRESHOLD) {
    return `${(value / 1_000_000).toFixed(1)}M stroops`;
  }
  return `${Math.round(value).toLocaleString("en-US")} stroops`;
}

export function formatPercent(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

export function formatRate(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "—";
  if (value >= 1000) {
    return value.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  }
  return value.toFixed(1);
}

export function formatHorizonEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.host;
    const network = host.includes("testnet") ? "Testnet" : "Mainnet";
    return `${network} · ${host}`;
  } catch {
    return url;
  }
}
