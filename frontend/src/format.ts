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

/*
 * Horizon's raw operation type strings are snake_case identifiers. Only the
 * ones whose mechanical humanization would read badly are listed; everything
 * else falls through to the generic rule below.
 *
 * The table is deliberately not exhaustive. Stellar adds operation types with
 * protocol upgrades, and a chart that broke — or printed a raw identifier —
 * the first time one appeared would be worse than one that renders
 * "Liquidity pool deposit" without ever having heard of it.
 */
const OPERATION_TYPE_LABELS: Record<string, string> = {
  path_payment_strict_send: "Path payment (strict send)",
  path_payment_strict_receive: "Path payment (strict receive)",
  manage_sell_offer: "Manage sell offer",
  manage_buy_offer: "Manage buy offer",
  create_passive_sell_offer: "Passive sell offer",
  invoke_host_function: "Contract invocation",
  begin_sponsoring_future_reserves: "Begin sponsoring",
  end_sponsoring_future_reserves: "End sponsoring",
};

/**
 * Turns a Horizon operation type into something readable.
 *
 * Unknown types get the generic treatment — underscores to spaces, first
 * letter capitalised — so a type introduced after this code was written still
 * renders as words.
 */
export function formatOperationType(type: string): string {
  const known = OPERATION_TYPE_LABELS[type];
  if (known) return known;

  const words = type.replace(/_/g, " ").trim();
  if (words.length === 0) return "Unknown";
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Says how long a sample window covers, for labelling figures that are a
 * recent sample rather than an all-time total.
 */
export function formatWindow(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) {
    return "the recent sample window";
  }
  if (seconds < 90) return `the last ${Math.round(seconds)}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `the last ${minutes}m`;
  return `the last ${Math.round(minutes / 60)}h`;
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
