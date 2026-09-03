import { describe, expect, it } from "vitest";
import { resolveChartStatus, resolveValueStatus } from "./resolveStatus";

/*
 * The two helpers share one precedence rule. These tests exist mainly to pin
 * that they agree — a second, quietly different rule for the stat tiles is the
 * thing #71 set out to avoid.
 */
describe("resolveValueStatus", () => {
  it("is ready as soon as the source object exists", () => {
    expect(resolveValueStatus({ any: "payload" })).toBe("ready");
  });

  it("is loading while the source is absent and nothing has failed", () => {
    expect(resolveValueStatus(null)).toBe("loading");
    expect(resolveValueStatus(undefined)).toBe("loading");
  });

  it("is error when the source is absent and the fetch failed", () => {
    expect(resolveValueStatus(null, "backend unreachable")).toBe("error");
  });

  it("prefers an existing source over an error, like the chart rule", () => {
    // A dropped socket should not blank numbers that are seconds old.
    expect(resolveValueStatus({ ok: true }, "backend unreachable")).toBe("ready");
  });

  it("treats falsy-but-present values as present", () => {
    // 0 and "" are answers, not absences — the trap a truthiness check falls into.
    expect(resolveValueStatus(0)).toBe("ready");
    expect(resolveValueStatus("")).toBe("ready");
    expect(resolveValueStatus(false)).toBe("ready");
  });
});

describe("the two helpers agree on precedence", () => {
  it.each([
    ["absent, no error", null, null, "loading"],
    ["absent, error", null, "boom", "error"],
    ["present, no error", "present", null, "ready"],
    ["present, error", "present", "boom", "ready"],
  ] as const)("%s", (_name, presence, error, expected) => {
    // Same four cases expressed as a series and as a scalar.
    const series = presence === null ? null : [1];
    expect(resolveChartStatus(series, error)).toBe(expected);
    expect(resolveValueStatus(presence, error)).toBe(expected);
  });

  it("differs only in that a series can be empty and a scalar cannot", () => {
    expect(resolveChartStatus([], null)).toBe("empty");
    // No scalar input produces "empty": present is ready, absent is loading.
    for (const input of [null, undefined, 0, "", false, {}, "x"]) {
      expect(resolveValueStatus(input)).not.toBe("empty");
    }
  });
});
