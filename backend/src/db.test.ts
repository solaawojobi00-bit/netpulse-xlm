import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NetPulseDatabase, db as dbFacade, floorToUtcMidnight } from "./db.js";
import type { FeeSnapshot, LedgerSample } from "./types.js";

describe("NetPulseDatabase Unit Tests", () => {
  let db: NetPulseDatabase;

  beforeEach(() => {
    db = new NetPulseDatabase(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  const createLedgerSample = (
    sequence: number,
    closedAt: string,
    overrides?: Partial<LedgerSample>,
  ): LedgerSample => ({
    sequence,
    closedAt,
    closeTimeSeconds: 5.0,
    successfulTransactionCount: 10,
    failedTransactionCount: 1,
    operationCount: 20,
    txSetOperationCount: 20,
    baseFeeInStroops: 100,
    maxTxSetSize: 1000,
    ...overrides,
  });

  const createFeeSnapshot = (
    fetchedAt: string,
    overrides?: Partial<FeeSnapshot>,
  ): FeeSnapshot => ({
    fetchedAt,
    lastLedgerBaseFee: 100,
    ledgerCapacityUsage: 0.25,
    feeChargedP10: 100,
    feeChargedP50: 120,
    feeChargedP90: 200,
    feeChargedP99: 500,
    ...overrides,
  });

  describe("insertLedgers", () => {
    it("persists rows and replaces duplicate (network, sequence)", () => {
      const now = new Date().toISOString();
      const sample1 = createLedgerSample(1001, now, { operationCount: 15 });
      db.insertLedgers("mainnet", [sample1]);

      let history = db.getHistory("mainnet");
      expect(history.points.length).toBe(1);
      expect(history.points[0].operations).toBe(15);

      // Re-insert same sequence with updated operation count
      const sample1Updated = createLedgerSample(1001, now, { operationCount: 40 });
      db.insertLedgers("mainnet", [sample1Updated]);

      history = db.getHistory("mainnet");
      expect(history.points.length).toBe(1);
      expect(history.points[0].operations).toBe(40);

      // Direct count verification on composite PK
      const count = (db as any).db
        .prepare("SELECT COUNT(*) as c FROM ledgers WHERE network = ? AND sequence = ?")
        .get("mainnet", 1001).c;
      expect(count).toBe(1);
    });
  });

  describe("insertFeeSnapshot", () => {
    it("appends rows without deduplication", () => {
      const now = new Date().toISOString();
      const snapshot = createFeeSnapshot(now, { feeChargedP50: 150 });

      db.insertFeeSnapshot("mainnet", snapshot);
      db.insertFeeSnapshot("mainnet", snapshot);

      const count = (db as any).db
        .prepare("SELECT COUNT(*) as c FROM fee_snapshots WHERE network = ?")
        .get("mainnet").c;
      expect(count).toBe(2);
    });
  });

  describe("network isolation", () => {
    it("ensures testnet rows are not returned in mainnet history query", () => {
      const now = new Date().toISOString();
      db.insertLedgers("testnet", [createLedgerSample(500, now, { operationCount: 50 })]);
      db.insertFeeSnapshot("testnet", createFeeSnapshot(now, { feeChargedP50: 300 }));

      const mainnetHistory = db.getHistory("mainnet");
      expect(mainnetHistory.points).toEqual([]);

      const testnetHistory = db.getHistory("testnet");
      expect(testnetHistory.points.length).toBe(1);
      expect(testnetHistory.points[0].operations).toBe(50);
      expect(testnetHistory.points[0].p50Fee).toBe(300);
    });
  });

  describe("pruneOlderThan", () => {
    /*
     * These run on a frozen clock. The cutoff is derived from Date.now(), and
     * the whole point of the flooring is that the retained set does not depend
     * on when the prune fires — which cannot be asserted while the clock moves
     * underneath the assertions.
     */
    const DAY_MS = 24 * 60 * 60 * 1000;

    /** 2026-09-04T14:00:00Z — mid-afternoon, the case that used to split a day. */
    const NOW = Date.UTC(2026, 8, 4, 14, 0, 0);

    /** An instant `days` before NOW's UTC midnight, offset within that day. */
    const dayAt = (daysAgo: number, hours = 12): string =>
      new Date(Date.UTC(2026, 8, 4) - daysAgo * DAY_MS + hours * 60 * 60 * 1000).toISOString();

    const seed = (times: string[]) => {
      db.insertLedgers(
        "mainnet",
        times.map((t, i) => createLedgerSample(i + 1, t)),
      );
      for (const t of times) db.insertFeeSnapshot("mainnet", createFeeSnapshot(t));
    };

    const remainingLedgerTimes = (): string[] =>
      ((db as any).db
        .prepare("SELECT closed_at FROM ledgers WHERE network = 'mainnet' ORDER BY closed_at_unix")
        .all() as Array<{ closed_at: string }>).map((r) => r.closed_at);

    const remainingFeeCount = (): number =>
      (db as any).db
        .prepare("SELECT COUNT(*) as c FROM fee_snapshots WHERE network = 'mainnet'")
        .get().c;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("deletes rows older than cutoff from both tables while preserving rows in window", () => {
      const oldTime = dayAt(3); // three days back (pruned)
      const recentTime = dayAt(0); // today (kept)

      seed([oldTime, recentTime]);

      db.pruneOlderThan(DAY_MS);

      expect(remainingLedgerTimes()).toEqual([recentTime]);
      expect(remainingFeeCount()).toBe(1);
    });

    it("keeps or deletes a whole UTC day, never part of one", () => {
      /*
       * The case from the issue: a 14:00Z prune with a 7-day retention would
       * previously cut at Aug 28 14:00Z, deleting that morning and keeping
       * that afternoon. Both of these sit on the boundary day.
       */
      const boundaryMorning = dayAt(7, 2);
      const boundaryEvening = dayAt(7, 22);

      seed([boundaryMorning, boundaryEvening]);

      db.pruneOlderThan(7 * DAY_MS);

      expect(remainingLedgerTimes()).toEqual([boundaryMorning, boundaryEvening]);
      expect(remainingFeeCount()).toBe(2);
    });

    it("retains the last instant of the oldest kept day and drops the first of the day before", () => {
      // Cutoff for a 7-day retention taken at NOW is Aug 28 00:00:00.000Z.
      const cutoff = Date.UTC(2026, 7, 28);
      const lastKept = new Date(cutoff - 1 + DAY_MS).toISOString(); // Aug 28 23:59:59.999Z
      const firstDropped = new Date(cutoff - DAY_MS).toISOString(); // Aug 27 00:00:00.000Z
      const exactlyCutoff = new Date(cutoff).toISOString(); // Aug 28 00:00:00.000Z

      seed([firstDropped, exactlyCutoff, lastKept]);

      db.pruneOlderThan(7 * DAY_MS);

      // The comparison is `< cutoff`, so the cutoff instant itself is kept.
      expect(remainingLedgerTimes()).toEqual([exactlyCutoff, lastKept]);
      expect(remainingFeeCount()).toBe(2);
    });

    it("never retains less than the retention window", () => {
      // A row exactly RETENTION_DAYS old must survive; flooring may keep more,
      // never less.
      const exactlyRetentionOld = new Date(NOW - 7 * DAY_MS).toISOString();

      seed([exactlyRetentionOld]);

      db.pruneOlderThan(7 * DAY_MS);

      expect(remainingLedgerTimes()).toEqual([exactlyRetentionOld]);
    });

    it("retains the same set regardless of the wall-clock time of the run", () => {
      const times = [dayAt(9), dayAt(8), dayAt(7), dayAt(6), dayAt(0)];

      /** Prunes a fresh database at a given time of the same UTC day. */
      const retainedWhenRunAt = (hour: number, minute: number): string[] => {
        const scratch = new NetPulseDatabase(":memory:");
        try {
          scratch.insertLedgers(
            "mainnet",
            times.map((t, i) => createLedgerSample(i + 1, t)),
          );
          vi.setSystemTime(Date.UTC(2026, 8, 4, hour, minute, 0));
          scratch.pruneOlderThan(7 * DAY_MS);
          return ((scratch as any).db
            .prepare("SELECT closed_at FROM ledgers ORDER BY closed_at_unix")
            .all() as Array<{ closed_at: string }>).map((r) => r.closed_at);
        } finally {
          scratch.close();
        }
      };

      const justAfterMidnight = retainedWhenRunAt(0, 0);
      const midAfternoon = retainedWhenRunAt(14, 0);
      const lastMinute = retainedWhenRunAt(23, 59);

      expect(midAfternoon).toEqual(justAfterMidnight);
      expect(lastMinute).toEqual(justAfterMidnight);

      // And it is the set we expect, not three identically wrong answers.
      expect(justAfterMidnight).toEqual([dayAt(7), dayAt(6), dayAt(0)]);
    });
  });

  describe("rollupAndPrune", () => {
    const DAY_MS = 24 * 60 * 60 * 1000;

    /** 2026-09-11T14:00:00Z. Far enough in that a 7-day window has whole days. */
    const NOW = Date.UTC(2026, 8, 11, 14, 0, 0);

    /** An instant on the UTC day `daysAgo` before today, at `hours` into it. */
    const at = (daysAgo: number, hours = 12, minutes = 0): string =>
      new Date(
        Date.UTC(2026, 8, 11) -
          daysAgo * DAY_MS +
          hours * 60 * 60 * 1000 +
          minutes * 60 * 1000,
      ).toISOString();

    /** The YYYY-MM-DD label for the UTC day `daysAgo` before today. */
    const dateOf = (daysAgo: number): string =>
      new Date(Date.UTC(2026, 8, 11) - daysAgo * DAY_MS).toISOString().slice(0, 10);

    interface RollupRow {
      network: string;
      date: string;
      avg_close_time_seconds: number | null;
      avg_congestion_usage: number | null;
      max_congestion_usage: number | null;
      total_operations: number;
      total_successful_tx: number;
      total_failed_tx: number;
      avg_fee_p50: number | null;
      avg_fee_p90: number | null;
    }

    const rollups = (network = "mainnet"): RollupRow[] =>
      (db as any).db
        .prepare("SELECT * FROM daily_rollups WHERE network = ? ORDER BY date")
        .all(network) as RollupRow[];

    const rollupFor = (daysAgo: number, network = "mainnet"): RollupRow | undefined =>
      rollups(network).find((r) => r.date === dateOf(daysAgo));

    const rawLedgerCount = (): number =>
      (db as any).db.prepare("SELECT COUNT(*) as c FROM ledgers").get().c;

    const rawFeeCount = (): number =>
      (db as any).db.prepare("SELECT COUNT(*) as c FROM fee_snapshots").get().c;

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("aggregates a complete day correctly across both tables", () => {
      db.insertLedgers("mainnet", [
        createLedgerSample(1, at(1, 2), {
          closeTimeSeconds: 4,
          operationCount: 10,
          successfulTransactionCount: 3,
          failedTransactionCount: 1,
        }),
        createLedgerSample(2, at(1, 14), {
          closeTimeSeconds: 6,
          operationCount: 20,
          successfulTransactionCount: 5,
          failedTransactionCount: 2,
        }),
      ]);
      db.insertFeeSnapshot(
        "mainnet",
        createFeeSnapshot(at(1, 3), {
          ledgerCapacityUsage: 0.2,
          feeChargedP50: 100,
          feeChargedP90: 200,
        }),
      );
      db.insertFeeSnapshot(
        "mainnet",
        createFeeSnapshot(at(1, 15), {
          ledgerCapacityUsage: 0.6,
          feeChargedP50: 140,
          feeChargedP90: 300,
        }),
      );

      db.rollupAndPrune();

      const row = rollupFor(1);
      expect(row).toBeDefined();
      expect(row!.avg_close_time_seconds).toBe(5); // avg(4, 6)
      expect(row!.avg_congestion_usage).toBeCloseTo(0.4, 10); // avg(0.2, 0.6)
      expect(row!.max_congestion_usage).toBe(0.6); // max, not the average
      expect(row!.total_operations).toBe(30);
      expect(row!.total_successful_tx).toBe(8);
      expect(row!.total_failed_tx).toBe(3);
      expect(row!.avg_fee_p50).toBe(120); // avg(100, 140)
      expect(row!.avg_fee_p90).toBe(250); // avg(200, 300)
    });

    it("is idempotent — a second run produces identical rows", () => {
      db.insertLedgers("mainnet", [
        createLedgerSample(1, at(2), { operationCount: 10 }),
        createLedgerSample(2, at(1), { operationCount: 20 }),
      ]);
      db.insertFeeSnapshot("mainnet", createFeeSnapshot(at(1)));

      db.rollupAndPrune();
      const first = rollups();

      db.rollupAndPrune();
      const second = rollups();

      expect(second).toEqual(first);
    });

    it("REPLACEs rather than duplicating when a still-present day gains ledgers", () => {
      db.insertLedgers("mainnet", [
        createLedgerSample(1, at(1, 2), { operationCount: 10 }),
      ]);

      db.rollupAndPrune();
      expect(rollupFor(1)!.total_operations).toBe(10);

      // A late-arriving ledger for the same day, still inside retention.
      db.insertLedgers("mainnet", [
        createLedgerSample(2, at(1, 20), { operationCount: 25 }),
      ]);
      db.rollupAndPrune();

      const matching = rollups().filter((r) => r.date === dateOf(1));
      expect(matching).toHaveLength(1);
      expect(matching[0].total_operations).toBe(35);
    });

    it("leaves an already-pruned day's rollup untouched on later runs", () => {
      // Day 9 is outside a 7-day retention window, so it is rolled up and
      // deleted on the first run and must not be revisited afterwards.
      db.insertLedgers("mainnet", [
        createLedgerSample(1, at(9), { operationCount: 42 }),
      ]);

      db.rollupAndPrune();
      const afterFirst = rollupFor(9);
      expect(afterFirst!.total_operations).toBe(42);
      expect(rawLedgerCount()).toBe(0);

      db.rollupAndPrune();
      db.rollupAndPrune();

      expect(rollupFor(9)).toEqual(afterFirst);
    });

    it("never rolls up the in-progress UTC day", () => {
      db.insertLedgers("mainnet", [
        createLedgerSample(1, at(0, 1), { operationCount: 10 }),
        createLedgerSample(2, at(0, 13), { operationCount: 20 }),
      ]);
      db.insertFeeSnapshot("mainnet", createFeeSnapshot(at(0, 2)));

      db.rollupAndPrune();

      expect(rollupFor(0)).toBeUndefined();
      expect(rollups()).toHaveLength(0);
      // ...and today's raw rows are still there to be rolled up tomorrow.
      expect(rawLedgerCount()).toBe(2);
    });

    it("rolls up every complete day in the window, not only the one aging out", () => {
      /*
       * Rolling up only the boundary day would leave a seven-day hole at the
       * right edge of a 30d or 90d chart.
       */
      for (let daysAgo = 1; daysAgo <= 6; daysAgo++) {
        db.insertLedgers("mainnet", [
          createLedgerSample(daysAgo, at(daysAgo), { operationCount: daysAgo }),
        ]);
      }

      db.rollupAndPrune();

      expect(rollups()).toHaveLength(6);
      for (let daysAgo = 1; daysAgo <= 6; daysAgo++) {
        expect(rollupFor(daysAgo)!.total_operations).toBe(daysAgo);
      }
      // All six are inside retention, so none of the raw rows are gone.
      expect(rawLedgerCount()).toBe(6);
    });

    it("keeps mainnet and testnet separate for the same date", () => {
      db.insertLedgers("mainnet", [
        createLedgerSample(1, at(1), { operationCount: 10 }),
      ]);
      db.insertLedgers("testnet", [
        createLedgerSample(1, at(1), { operationCount: 99 }),
      ]);

      db.rollupAndPrune();

      expect(rollupFor(1, "mainnet")!.total_operations).toBe(10);
      expect(rollupFor(1, "testnet")!.total_operations).toBe(99);
    });

    it("writes null fee columns for a day with ledgers but no fee snapshots", () => {
      db.insertLedgers("mainnet", [
        createLedgerSample(1, at(1), {
          operationCount: 15,
          successfulTransactionCount: 4,
          failedTransactionCount: 1,
        }),
      ]);

      db.rollupAndPrune();

      const row = rollupFor(1)!;
      expect(row.avg_congestion_usage).toBeNull();
      expect(row.max_congestion_usage).toBeNull();
      expect(row.avg_fee_p50).toBeNull();
      expect(row.avg_fee_p90).toBeNull();
      // The ledger side is intact — one missing source does not discard both.
      expect(row.total_operations).toBe(15);
      expect(row.total_successful_tx).toBe(4);
      expect(row.total_failed_tx).toBe(1);
    });

    it("writes zero counts and a null close time for a day with fee snapshots but no ledgers", () => {
      db.insertFeeSnapshot(
        "mainnet",
        createFeeSnapshot(at(1), { ledgerCapacityUsage: 0.3, feeChargedP50: 111 }),
      );

      db.rollupAndPrune();

      const row = rollupFor(1)!;
      expect(row.avg_close_time_seconds).toBeNull();
      expect(row.total_operations).toBe(0);
      expect(row.total_successful_tx).toBe(0);
      expect(row.total_failed_tx).toBe(0);
      expect(row.avg_congestion_usage).toBeCloseTo(0.3, 10);
      expect(row.avg_fee_p50).toBe(111);
    });

    it("rolls a day up before deleting it", () => {
      // Day 9 is outside retention. Its raw rows go; its summary must not.
      db.insertLedgers("mainnet", [
        createLedgerSample(1, at(9), { operationCount: 77 }),
      ]);
      db.insertFeeSnapshot("mainnet", createFeeSnapshot(at(9)));

      db.rollupAndPrune();

      expect(rawLedgerCount()).toBe(0);
      expect(rawFeeCount()).toBe(0);
      expect(rollupFor(9)!.total_operations).toBe(77);
    });

    it("persists neither the rollup nor the deletion when the transaction throws", () => {
      db.insertLedgers("mainnet", [
        createLedgerSample(1, at(9), { operationCount: 77 }),
      ]);

      const failure = new Error("disk error mid-transaction");
      const spy = vi
        .spyOn(db as any, "deleteRawBefore")
        .mockImplementation(() => {
          throw failure;
        });

      expect(() => db.rollupAndPrune()).toThrow(failure);

      spy.mockRestore();

      /*
       * The rollup INSERT ran before the throw. If the two were not in one
       * transaction it would have been committed, and the next run would then
       * roll the surviving raw rows up a second time.
       */
      expect(rollups()).toHaveLength(0);
      expect(rawLedgerCount()).toBe(1);
    });

    it("does not double-count after a failed run is retried", () => {
      db.insertLedgers("mainnet", [
        createLedgerSample(1, at(9), { operationCount: 77 }),
      ]);

      const spy = vi
        .spyOn(db as any, "deleteRawBefore")
        .mockImplementation(() => {
          throw new Error("disk error mid-transaction");
        });
      expect(() => db.rollupAndPrune()).toThrow();
      spy.mockRestore();

      db.rollupAndPrune();

      expect(rollupFor(9)!.total_operations).toBe(77);
      expect(rawLedgerCount()).toBe(0);
    });
  });

  describe("db facade", () => {
    it("does not expose pruneOlderThan", () => {
      /*
       * Deleting raw rows without summarising them first is a one-way door.
       * The primitive stays on the class for tests; the only entry point
       * reachable from production code is the safe one.
       */
      expect((dbFacade as Record<string, unknown>).pruneOlderThan).toBeUndefined();
      expect(typeof dbFacade.rollupAndPrune).toBe("function");
    });
  });

  describe("floorToUtcMidnight", () => {
    it("returns the UTC midnight that begins the day", () => {
      expect(floorToUtcMidnight(Date.UTC(2026, 8, 4, 14, 32, 7, 500))).toBe(
        Date.UTC(2026, 8, 4),
      );
    });

    it("is idempotent on a midnight", () => {
      const midnight = Date.UTC(2026, 8, 4);
      expect(floorToUtcMidnight(midnight)).toBe(midnight);
    });

    it("keeps the last millisecond of a day in that day", () => {
      expect(floorToUtcMidnight(Date.UTC(2026, 8, 4, 23, 59, 59, 999))).toBe(
        Date.UTC(2026, 8, 4),
      );
    });

    it("crosses month and year boundaries correctly", () => {
      expect(floorToUtcMidnight(Date.UTC(2026, 0, 1, 0, 0, 0, 1))).toBe(Date.UTC(2026, 0, 1));
      expect(floorToUtcMidnight(Date.UTC(2025, 11, 31, 23, 59, 59, 999))).toBe(
        Date.UTC(2025, 11, 31),
      );
    });
  });

  describe("getHistory bucketing and aggregation", () => {
    it("collapses two ledgers in the same 5-minute bucket summing ops/txs and averaging closeTime", () => {
      const bucketResolutionMs = 5 * 60 * 1000;
      const now = Date.now();
      const baseBucketUnix = Math.floor(now / bucketResolutionMs) * bucketResolutionMs;

      const t1 = new Date(baseBucketUnix + 10 * 1000).toISOString();
      const t2 = new Date(baseBucketUnix + 60 * 1000).toISOString();

      db.insertLedgers("mainnet", [
        createLedgerSample(10, t1, {
          operationCount: 15,
          successfulTransactionCount: 3,
          failedTransactionCount: 1,
          closeTimeSeconds: 5.0,
        }),
        createLedgerSample(11, t2, {
          operationCount: 25,
          successfulTransactionCount: 4,
          failedTransactionCount: 2,
          closeTimeSeconds: 6.0,
        }),
      ]);

      const history = db.getHistory("mainnet", 24);
      expect(history.points).toHaveLength(1);

      const point = history.points[0];
      expect(point.timestamp).toBe(new Date(baseBucketUnix).toISOString());
      expect(point.operations).toBe(40); // 15 + 25
      expect(point.transactions).toBe(10); // (3+1) + (4+2)
      expect(point.closeTimeSeconds).toBe(5.5); // avg(5, 6)
    });

    it("produces separate points for different 5-minute buckets ordered oldest-first", () => {
      const bucketResolutionMs = 5 * 60 * 1000;
      const now = Date.now();
      const currentBucketUnix = Math.floor(now / bucketResolutionMs) * bucketResolutionMs;
      const previousBucketUnix = currentBucketUnix - bucketResolutionMs;

      const tOld = new Date(previousBucketUnix + 30 * 1000).toISOString();
      const tNew = new Date(currentBucketUnix + 30 * 1000).toISOString();

      db.insertLedgers("mainnet", [
        createLedgerSample(20, tNew, { operationCount: 30 }),
        createLedgerSample(19, tOld, { operationCount: 10 }),
      ]);

      const history = db.getHistory("mainnet", 24);
      expect(history.points).toHaveLength(2);
      expect(history.points[0].timestamp).toBe(new Date(previousBucketUnix).toISOString());
      expect(history.points[0].operations).toBe(10);
      expect(history.points[1].timestamp).toBe(new Date(currentBucketUnix).toISOString());
      expect(history.points[1].operations).toBe(30);
    });

    it("handles ledger-only and fee-only buckets in outer-join", () => {
      const bucketResolutionMs = 5 * 60 * 1000;
      const now = Date.now();
      const bucket1Unix = Math.floor(now / bucketResolutionMs) * bucketResolutionMs - bucketResolutionMs;
      const bucket2Unix = bucket1Unix + bucketResolutionMs;

      const tBucket1 = new Date(bucket1Unix + 15 * 1000).toISOString();
      const tBucket2 = new Date(bucket2Unix + 15 * 1000).toISOString();

      // Bucket 1: Ledger only
      db.insertLedgers("mainnet", [createLedgerSample(30, tBucket1, { operationCount: 20 })]);

      // Bucket 2: Fee only
      db.insertFeeSnapshot(
        "mainnet",
        createFeeSnapshot(tBucket2, {
          ledgerCapacityUsage: 0.45,
          feeChargedP50: 120,
          feeChargedP90: 250,
        }),
      );

      const history = db.getHistory("mainnet", 24);
      expect(history.points).toHaveLength(2);

      // Bucket 1 (ledger only): fee fields are null
      expect(history.points[0].timestamp).toBe(new Date(bucket1Unix).toISOString());
      expect(history.points[0].operations).toBe(20);
      expect(history.points[0].congestionUsage).toBeNull();
      expect(history.points[0].p50Fee).toBeNull();
      expect(history.points[0].p90Fee).toBeNull();

      // Bucket 2 (fee only): operations and transactions are 0, closeTimeSeconds is null
      expect(history.points[1].timestamp).toBe(new Date(bucket2Unix).toISOString());
      expect(history.points[1].operations).toBe(0);
      expect(history.points[1].transactions).toBe(0);
      expect(history.points[1].closeTimeSeconds).toBeNull();
      expect(history.points[1].congestionUsage).toBe(0.45);
      expect(history.points[1].p50Fee).toBe(120);
      expect(history.points[1].p90Fee).toBe(250);
    });

    it("excludes rows older than durationHours", () => {
      const now = Date.now();
      const insideWindow = new Date(now - 30 * 60 * 1000).toISOString(); // 30 mins ago
      const outsideWindow = new Date(now - 150 * 60 * 1000).toISOString(); // 2.5 hours ago

      db.insertLedgers("mainnet", [
        createLedgerSample(40, insideWindow, { operationCount: 10 }),
        createLedgerSample(41, outsideWindow, { operationCount: 99 }),
      ]);

      const history = db.getHistory("mainnet", 1); // 1 hour window
      expect(history.points).toHaveLength(1);
      expect(history.points[0].operations).toBe(10);
    });

    it("rounds closeTimeSeconds to 2dp, congestionUsage to 4dp, and fees to whole numbers", () => {
      const bucketResolutionMs = 5 * 60 * 1000;
      const now = Date.now();
      const bucketUnix = Math.floor(now / bucketResolutionMs) * bucketResolutionMs;
      const t = new Date(bucketUnix + 10 * 1000).toISOString();

      db.insertLedgers("mainnet", [
        createLedgerSample(50, t, { closeTimeSeconds: 5.2895 }),
      ]);

      db.insertFeeSnapshot(
        "mainnet",
        createFeeSnapshot(t, {
          ledgerCapacityUsage: 0.123456,
          feeChargedP50: 125.6,
          feeChargedP90: 249.4,
        }),
      );

      const history = db.getHistory("mainnet", 24);
      expect(history.points).toHaveLength(1);

      const point = history.points[0];
      expect(point.closeTimeSeconds).toBe(5.29);
      expect(point.congestionUsage).toBe(0.1235);
      expect(point.p50Fee).toBe(126);
      expect(point.p90Fee).toBe(249);
    });
  });
});
