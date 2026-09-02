import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NetPulseDatabase } from "./db.js";
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
    it("deletes rows older than cutoff from both tables while preserving rows in window", () => {
      const now = Date.now();
      const retentionMs = 60 * 1000; // 60 seconds cutoff

      const oldTime = new Date(now - 120 * 1000).toISOString(); // 2 minutes old (pruned)
      const recentTime = new Date(now - 30 * 1000).toISOString(); // 30 seconds old (kept)

      db.insertLedgers("mainnet", [
        createLedgerSample(1, oldTime),
        createLedgerSample(2, recentTime),
      ]);

      db.insertFeeSnapshot("mainnet", createFeeSnapshot(oldTime));
      db.insertFeeSnapshot("mainnet", createFeeSnapshot(recentTime));

      db.pruneOlderThan(retentionMs);

      const remainingLedgers = (db as any).db
        .prepare("SELECT sequence FROM ledgers WHERE network = 'mainnet'")
        .all();
      expect(remainingLedgers).toEqual([{ sequence: 2 }]);

      const remainingFees = (db as any).db
        .prepare("SELECT COUNT(*) as c FROM fee_snapshots WHERE network = 'mainnet'")
        .get().c;
      expect(remainingFees).toBe(1);
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
