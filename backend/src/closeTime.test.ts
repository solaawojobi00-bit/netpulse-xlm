import { describe, expect, it } from "vitest";
import { closeTimeSecondsBetween, isValidCloseTimeSeconds } from "./closeTime.js";

describe("isValidCloseTimeSeconds", () => {
  it("accepts a positive finite measurement", () => {
    expect(isValidCloseTimeSeconds(5)).toBe(true);
    expect(isValidCloseTimeSeconds(5.2)).toBe(true);
    expect(isValidCloseTimeSeconds(0.001)).toBe(true);
  });

  it("rejects negatives — the #84 symptom", () => {
    expect(isValidCloseTimeSeconds(-1)).toBe(false);
    expect(isValidCloseTimeSeconds(-36192909)).toBe(false);
  });

  it("rejects zero", () => {
    // Two ledgers cannot close at the same instant; a zero delta means the
    // measurement is wrong, not that the network is infinitely fast.
    expect(isValidCloseTimeSeconds(0)).toBe(false);
  });

  it("rejects absent and non-finite values", () => {
    expect(isValidCloseTimeSeconds(null)).toBe(false);
    expect(isValidCloseTimeSeconds(undefined)).toBe(false);
    expect(isValidCloseTimeSeconds(NaN)).toBe(false);
    expect(isValidCloseTimeSeconds(Infinity)).toBe(false);
    expect(isValidCloseTimeSeconds(-Infinity)).toBe(false);
  });
});

describe("closeTimeSecondsBetween", () => {
  it("measures the gap between consecutive closes", () => {
    expect(
      closeTimeSecondsBetween("2026-09-02T12:00:00Z", "2026-09-02T12:00:05Z"),
    ).toBe(5);
  });

  it("returns null when there is no predecessor", () => {
    expect(closeTimeSecondsBetween(null, "2026-09-02T12:00:05Z")).toBeNull();
    expect(closeTimeSecondsBetween(undefined, "2026-09-02T12:00:05Z")).toBeNull();
  });

  it("returns null rather than a negative number when the order is inverted", () => {
    /*
     * The shape of the bug: a stale record measured against a much later
     * ledger. Reported as unmeasured rather than as a large negative reading
     * that charts and averages would treat as real.
     */
    const result = closeTimeSecondsBetween(
      "2026-09-04T11:17:14Z",
      "2025-07-12T13:43:53Z",
    );

    expect(result).toBeNull();
  });

  it("returns null for an unparseable timestamp", () => {
    expect(closeTimeSecondsBetween("not a date", "2026-09-02T12:00:05Z")).toBeNull();
    expect(closeTimeSecondsBetween("2026-09-02T12:00:00Z", "not a date")).toBeNull();
  });

  it("returns null when both timestamps are identical", () => {
    expect(
      closeTimeSecondsBetween("2026-09-02T12:00:00Z", "2026-09-02T12:00:00Z"),
    ).toBeNull();
  });
});
