import { beforeEach, describe, expect, it } from "vitest";
import {
  OTHER_OPERATION_TYPE,
  buildOperationBreakdownResponse,
  countOperationTypes,
  stores,
} from "./poller.js";
import type { OperationTypeSample } from "./types.js";

/** Builds `n` operations of a given type. */
function ops(type: string, n: number) {
  return Array.from({ length: n }, () => ({ type }));
}

/** Replaces a store's operation samples wholesale. */
function seed(samples: OperationTypeSample[]) {
  const store = stores.mainnet as unknown as { operationTypeSamples: OperationTypeSample[] };
  store.operationTypeSamples = samples;
}

function sample(counts: Record<string, number>, timestamp: string): OperationTypeSample {
  return {
    timestamp,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    counts,
  };
}

beforeEach(() => {
  seed([]);
});

describe("countOperationTypes", () => {
  it("counts each type and totals them", () => {
    const result = countOperationTypes([...ops("payment", 3), ...ops("create_account", 2)]);

    expect(result.counts).toEqual({ payment: 3, create_account: 2 });
    expect(result.total).toBe(5);
  });

  it("counts a type it has never seen rather than dropping it", () => {
    // A protocol upgrade can introduce types this code predates; they must
    // still be counted, not silently discarded.
    const result = countOperationTypes(ops("some_future_operation", 4));

    expect(result.counts.some_future_operation).toBe(4);
    expect(result.total).toBe(4);
  });

  it("counts operations with a missing or non-string type as other", () => {
    const result = countOperationTypes([
      { type: "payment" },
      {},
      { type: null },
      { type: 42 },
      { type: "" },
    ]);

    // They happened, so they count toward the total; they just have no name.
    expect(result.total).toBe(5);
    expect(result.counts.payment).toBe(1);
    expect(result.counts[OTHER_OPERATION_TYPE]).toBe(4);
    // Never a key like "undefined" or "null".
    expect(Object.keys(result.counts).sort()).toEqual([OTHER_OPERATION_TYPE, "payment"]);
  });

  it("bounds the stored key count no matter how many types arrive", () => {
    // 100 distinct types is not something Horizon does; the cap exists so a
    // response that did could not grow the store without limit.
    const many = Array.from({ length: 100 }, (_, i) => ({ type: `type_${i}` }));
    const result = countOperationTypes(many);

    expect(Object.keys(result.counts).length).toBeLessThanOrEqual(30);
    // Folding must not lose operations.
    expect(result.total).toBe(100);
    const summed = Object.values(result.counts).reduce((a, b) => a + b, 0);
    expect(summed).toBe(100);
    expect(result.counts[OTHER_OPERATION_TYPE]).toBeGreaterThan(0);
  });

  it("keeps the largest types when it has to drop some", () => {
    const many = [
      ...ops("dominant", 50),
      ...Array.from({ length: 60 }, (_, i) => ({ type: `rare_${i}` })),
    ];
    const result = countOperationTypes(many);

    expect(result.counts.dominant).toBe(50);
  });

  it("returns an empty breakdown for no operations", () => {
    const result = countOperationTypes([]);

    expect(result.total).toBe(0);
    expect(result.counts).toEqual({});
  });
});

describe("buildOperationBreakdownResponse", () => {
  it("sums counts across samples", () => {
    seed([
      sample({ payment: 3, create_account: 1 }, "2026-09-03T12:00:00.000Z"),
      sample({ payment: 2, change_trust: 4 }, "2026-09-03T12:00:30.000Z"),
    ]);

    const res = buildOperationBreakdownResponse("mainnet");

    expect(res.totalOperations).toBe(10);
    expect(res.sampleCount).toBe(2);
    expect(res.distinctTypes).toBe(3);
    expect(res.breakdown.find((b) => b.type === "payment")?.count).toBe(5);
    expect(res.breakdown.find((b) => b.type === "change_trust")?.count).toBe(4);
  });

  it("sorts by count descending", () => {
    seed([sample({ a_low: 1, b_high: 9, c_mid: 5 }, "2026-09-03T12:00:00.000Z")]);

    const res = buildOperationBreakdownResponse("mainnet");

    expect(res.breakdown.map((b) => b.type)).toEqual(["b_high", "c_mid", "a_low"]);
  });

  it("groups everything past the top six into a single other row", () => {
    seed([
      sample(
        {
          t1: 100, t2: 90, t3: 80, t4: 70, t5: 60, t6: 50,
          tail1: 5, tail2: 3, tail3: 2,
        },
        "2026-09-03T12:00:00.000Z",
      ),
    ]);

    const res = buildOperationBreakdownResponse("mainnet");

    // Six named rows plus exactly one grouped row.
    expect(res.breakdown).toHaveLength(7);
    expect(res.breakdown.filter((b) => b.isOther)).toHaveLength(1);

    const other = res.breakdown.at(-1);
    expect(other?.isOther).toBe(true);
    expect(other?.count).toBe(10);
    // Grouping is the last row, so the chart reads largest-to-smallest then
    // "everything else".
    expect(res.breakdown.slice(0, 6).every((b) => !b.isOther)).toBe(true);
  });

  it("reports every type when there are six or fewer, with no other row", () => {
    seed([sample({ payment: 5, create_account: 3 }, "2026-09-03T12:00:00.000Z")]);

    const res = buildOperationBreakdownResponse("mainnet");

    expect(res.breakdown).toHaveLength(2);
    expect(res.breakdown.some((b) => b.isOther)).toBe(false);
  });

  it("merges an upstream other bucket into the grouped row rather than ranking it", () => {
    // `other` can already exist in a sample when countOperationTypes folded a
    // long tail. It must not compete with real types for a top-six slot.
    seed([
      sample(
        { [OTHER_OPERATION_TYPE]: 500, payment: 10, create_account: 5 },
        "2026-09-03T12:00:00.000Z",
      ),
    ]);

    const res = buildOperationBreakdownResponse("mainnet");

    expect(res.breakdown[0].type).toBe("payment");
    const other = res.breakdown.find((b) => b.isOther);
    expect(other?.count).toBe(500);
    // Despite being the largest count, it is last.
    expect(res.breakdown.at(-1)?.isOther).toBe(true);
  });

  it("computes each row's share of the total", () => {
    seed([sample({ payment: 3, create_account: 1 }, "2026-09-03T12:00:00.000Z")]);

    const res = buildOperationBreakdownResponse("mainnet");

    expect(res.breakdown.find((b) => b.type === "payment")?.share).toBe(0.75);
    expect(res.breakdown.find((b) => b.type === "create_account")?.share).toBe(0.25);
  });

  it("reports the window span once there are two samples", () => {
    seed([
      sample({ payment: 1 }, "2026-09-03T12:00:00.000Z"),
      sample({ payment: 1 }, "2026-09-03T12:01:30.000Z"),
    ]);

    expect(buildOperationBreakdownResponse("mainnet").windowSeconds).toBe(90);
  });

  it("has no window to report from a single sample", () => {
    seed([sample({ payment: 1 }, "2026-09-03T12:00:00.000Z")]);

    // Null rather than 0, so the chart can omit the claim instead of saying
    // the window was zero seconds long.
    expect(buildOperationBreakdownResponse("mainnet").windowSeconds).toBeNull();
  });

  it("reports a genuinely quiet window as empty rather than inventing rows", () => {
    seed([sample({}, "2026-09-03T12:00:00.000Z")]);

    const res = buildOperationBreakdownResponse("mainnet");

    expect(res.breakdown).toEqual([]);
    expect(res.totalOperations).toBe(0);
    expect(res.sampleCount).toBe(1);
  });

  it("returns an empty breakdown before any poll has happened", () => {
    const res = buildOperationBreakdownResponse("mainnet");

    expect(res.breakdown).toEqual([]);
    expect(res.totalOperations).toBe(0);
    expect(res.sampleCount).toBe(0);
    expect(res.windowSeconds).toBeNull();
  });

  it("never divides by zero when totalling an empty window", () => {
    seed([sample({}, "2026-09-03T12:00:00.000Z")]);

    for (const row of buildOperationBreakdownResponse("mainnet").breakdown) {
      expect(Number.isFinite(row.share)).toBe(true);
    }
  });

  it("shares sum to roughly one when there is data", () => {
    seed([sample({ a: 7, b: 11, c: 13, d: 17, e: 19, f: 23, g: 29 }, "2026-09-03T12:00:00.000Z")]);

    const res = buildOperationBreakdownResponse("mainnet");
    const summed = res.breakdown.reduce((acc, b) => acc + b.share, 0);

    expect(summed).toBeCloseTo(1, 3);
    // And the counts still account for every operation, grouping included.
    expect(res.breakdown.reduce((acc, b) => acc + b.count, 0)).toBe(res.totalOperations);
  });
});
