import { describe, expect, it } from "vitest";
import { COMPACT_STROOP_THRESHOLD, formatHorizonEndpoint, formatOperationType, formatPercent, formatRate, formatSeconds, formatStroops, formatWindow } from "./format";

describe("formatSeconds", () => {
  it("returns dash for null or NaN", () => {
    expect(formatSeconds(null)).toBe("—");
    expect(formatSeconds(Number.NaN)).toBe("—");
  });

  it("formats numbers with default 1 decimal place", () => {
    expect(formatSeconds(5.234)).toBe("5.2s");
    expect(formatSeconds(0)).toBe("0.0s");
  });

  it("respects custom digits parameter", () => {
    expect(formatSeconds(5.236, 2)).toBe("5.24s");
  });
});

describe("formatStroops", () => {
  it("returns dash for null or NaN", () => {
    expect(formatStroops(null)).toBe("—");
    expect(formatStroops(Number.NaN)).toBe("—");
  });

  it("formats regular stroop values with thousands separators", () => {
    expect(formatStroops(100)).toBe("100 stroops");
    expect(formatStroops(50000)).toBe("50,000 stroops");
    expect(formatStroops(999999)).toBe("999,999 stroops");
  });

  it("formats values at or above 1M using compact units", () => {
    expect(COMPACT_STROOP_THRESHOLD).toBe(1000000);
    expect(formatStroops(1000000)).toBe("1.0M stroops");
    expect(formatStroops(20000000)).toBe("20.0M stroops");
    expect(formatStroops(15500000)).toBe("15.5M stroops");
  });

  it("formats values at or above 1B using compact units", () => {
    expect(formatStroops(1000000000)).toBe("1.0B stroops");
    expect(formatStroops(2500000000)).toBe("2.5B stroops");
  });
});

describe("formatPercent", () => {
  it("returns dash for null or NaN", () => {
    expect(formatPercent(null)).toBe("—");
    expect(formatPercent(Number.NaN)).toBe("—");
  });

  it("formats decimals as integer percentages", () => {
    expect(formatPercent(0.25)).toBe("25%");
    expect(formatPercent(0.796)).toBe("80%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(1)).toBe("100%");
  });
});

describe("formatRate", () => {
  it("returns dash for null or NaN", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(Number.NaN)).toBe("—");
  });

  it("formats throughput values to 1 decimal place", () => {
    expect(formatRate(0)).toBe("0.0");
    expect(formatRate(12.34)).toBe("12.3");
    expect(formatRate(85.99)).toBe("86.0");
  });

  it("includes thousands separators for rates >= 1000", () => {
    expect(formatRate(1234.56)).toBe("1,234.6");
    expect(formatRate(10000)).toBe("10,000.0");
  });
});

describe("formatHorizonEndpoint", () => {
  it("formats mainnet endpoint", () => {
    expect(formatHorizonEndpoint("https://horizon.stellar.org")).toBe(
      "Mainnet · horizon.stellar.org",
    );
  });

  it("formats testnet endpoint", () => {
    expect(formatHorizonEndpoint("https://horizon-testnet.stellar.org")).toBe(
      "Testnet · horizon-testnet.stellar.org",
    );
  });

  it("gracefully falls back for invalid URLs", () => {
    expect(formatHorizonEndpoint("not-a-valid-url")).toBe("not-a-valid-url");
  });
});

describe("formatOperationType", () => {
  it("uses the curated label where a mechanical one would read badly", () => {
    expect(formatOperationType("path_payment_strict_send")).toBe("Path payment (strict send)");
    expect(formatOperationType("path_payment_strict_receive")).toBe(
      "Path payment (strict receive)",
    );
    expect(formatOperationType("invoke_host_function")).toBe("Contract invocation");
  });

  it("humanizes a type it has never seen rather than printing the identifier", () => {
    // The table is not exhaustive on purpose: protocol upgrades add types, and
    // a chart that printed `some_future_operation` would be the worse failure.
    expect(formatOperationType("some_future_operation")).toBe("Some future operation");
    expect(formatOperationType("clawback")).toBe("Clawback");
    expect(formatOperationType("liquidity_pool_deposit")).toBe("Liquidity pool deposit");
  });

  it("never returns an empty label", () => {
    expect(formatOperationType("")).toBe("Unknown");
    expect(formatOperationType("   ")).toBe("Unknown");
    expect(formatOperationType("___")).toBe("Unknown");
  });
});

describe("formatWindow", () => {
  it("reports short windows in seconds and longer ones in minutes", () => {
    expect(formatWindow(45)).toBe("the last 45s");
    expect(formatWindow(120)).toBe("the last 2m");
    expect(formatWindow(7200)).toBe("the last 2h");
  });

  it("falls back to a vague phrase rather than claiming a zero-length window", () => {
    // Null arrives whenever there are fewer than two samples to span.
    expect(formatWindow(null)).toBe("the recent sample window");
    expect(formatWindow(0)).toBe("the recent sample window");
    expect(formatWindow(Number.NaN)).toBe("the recent sample window");
  });
});
