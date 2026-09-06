import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import { validCloseTimeSql } from "./closeTime.js";
import type { FeeSnapshot, LedgerSample } from "./types.js";

/*
 * The rollup's close-time aggregate must agree with the health average about
 * what counts as a usable sample, so the rule is spelled once, in closeTime.ts,
 * and interpolated here rather than restated as a literal.
 */
const VALID_CLOSE_TIME = validCloseTimeSql("close_time_seconds");

const DEFAULT_DB_PATH =
  process.env.NODE_ENV === "test"
    ? ":memory:"
    : process.env.DATABASE_PATH ?? "./data/netpulse.db";

const DAY_MS = 24 * 60 * 60 * 1000;

const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * DAY_MS;
const BUCKET_RESOLUTION_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Floors a Unix timestamp to the UTC midnight that begins its day.
 *
 * Plain arithmetic is exact here rather than approximate: Unix time counts no
 * leap seconds, so every UTC day is exactly `DAY_MS` long, and the epoch itself
 * begins at a UTC midnight. That also makes it independent of the host
 * timezone, which `Date`'s local-time accessors would not be.
 *
 * Exported for testing, and because the rollup work in #87 needs to agree with
 * the prune about where a day starts.
 */
export function floorToUtcMidnight(timestampMs: number): number {
  return Math.floor(timestampMs / DAY_MS) * DAY_MS;
}

export interface HistoryPoint {
  timestamp: string;
  closeTimeSeconds: number | null;
  congestionUsage: number | null;
  operations: number;
  transactions: number;
  p50Fee: number | null;
  p90Fee: number | null;
}

export interface HistoryResponse {
  network: string;
  range: string;
  points: HistoryPoint[];
}

export class NetPulseDatabase {
  private db: Database.Database;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    if (dbPath !== ":memory:") {
      const dir = path.dirname(dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
    }
    this.db = new Database(dbPath);
    if (dbPath !== ":memory:") {
      this.db.pragma("journal_mode = WAL");
    }
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ledgers (
        network TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        closed_at TEXT NOT NULL,
        closed_at_unix INTEGER NOT NULL,
        close_time_seconds REAL,
        successful_tx_count INTEGER NOT NULL,
        failed_tx_count INTEGER NOT NULL,
        operation_count INTEGER NOT NULL,
        base_fee_in_stroops INTEGER NOT NULL,
        PRIMARY KEY (network, sequence)
      );

      CREATE INDEX IF NOT EXISTS idx_ledgers_time ON ledgers (network, closed_at_unix);

      CREATE TABLE IF NOT EXISTS fee_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        network TEXT NOT NULL,
        fetched_at TEXT NOT NULL,
        fetched_at_unix INTEGER NOT NULL,
        last_ledger_base_fee REAL NOT NULL,
        ledger_capacity_usage REAL NOT NULL,
        fee_charged_p10 REAL NOT NULL,
        fee_charged_p50 REAL NOT NULL,
        fee_charged_p90 REAL NOT NULL,
        fee_charged_p99 REAL NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_fees_time ON fee_snapshots (network, fetched_at_unix);

      /*
       * Daily-grain history, kept indefinitely. Raw ledgers and fee snapshots
       * are deleted at the retention boundary, so without this a day older
       * than the window is gone for good; ~365 rows per year per network is a
       * cheap price for keeping its shape.
       *
       * Fee and congestion columns are nullable because a day can have ledger
       * rows and no fee snapshots, or the reverse — the same outer-join case
       * getHistory already handles at bucket grain. The count columns are NOT
       * NULL: a day that reached this table had rows, so zero means zero.
       *
       * No extra index. The primary key's implicit index already serves
       * "WHERE network = ? AND date >= ?" as a leftmost-prefix range scan.
       */
      CREATE TABLE IF NOT EXISTS daily_rollups (
        network                  TEXT NOT NULL,
        date                     TEXT NOT NULL,
        avg_close_time_seconds   REAL,
        close_time_sample_count  INTEGER NOT NULL DEFAULT 0,
        avg_congestion_usage     REAL,
        max_congestion_usage     REAL,
        total_operations         INTEGER NOT NULL DEFAULT 0,
        total_successful_tx      INTEGER NOT NULL DEFAULT 0,
        total_failed_tx          INTEGER NOT NULL DEFAULT 0,
        avg_fee_p50              REAL,
        avg_fee_p90              REAL,
        PRIMARY KEY (network, date)
      );
    `);

    /*
     * `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that already
     * exists, so a database created before close_time_sample_count was
     * introduced would keep the old shape and fail on insert. This is not a
     * migration framework and should not grow into one — it is the one-line
     * guard that lets a schema addition reach a database that predates it.
     */
    this.ensureColumn(
      "daily_rollups",
      "close_time_sample_count",
      "INTEGER NOT NULL DEFAULT 0",
    );
  }

  /** Adds a column if the table does not already have it. */
  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (columns.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  insertLedgers(network: string, samples: LedgerSample[]): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO ledgers (
        network, sequence, closed_at, closed_at_unix, close_time_seconds,
        successful_tx_count, failed_tx_count, operation_count, base_fee_in_stroops
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const transaction = this.db.transaction((items: LedgerSample[]) => {
      for (const sample of items) {
        const closedAtUnix = new Date(sample.closedAt).getTime();
        insert.run(
          network,
          sample.sequence,
          sample.closedAt,
          closedAtUnix,
          sample.closeTimeSeconds,
          sample.successfulTransactionCount,
          sample.failedTransactionCount,
          sample.operationCount,
          sample.baseFeeInStroops,
        );
      }
    });

    transaction(samples);
  }

  insertFeeSnapshot(network: string, snapshot: FeeSnapshot): void {
    const insert = this.db.prepare(`
      INSERT INTO fee_snapshots (
        network, fetched_at, fetched_at_unix, last_ledger_base_fee,
        ledger_capacity_usage, fee_charged_p10, fee_charged_p50,
        fee_charged_p90, fee_charged_p99
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const fetchedAtUnix = new Date(snapshot.fetchedAt).getTime();
    insert.run(
      network,
      snapshot.fetchedAt,
      fetchedAtUnix,
      snapshot.lastLedgerBaseFee,
      snapshot.ledgerCapacityUsage,
      snapshot.feeChargedP10,
      snapshot.feeChargedP50,
      snapshot.feeChargedP90,
      snapshot.feeChargedP99,
    );
  }

  /** Deletes raw rows below an already-floored cutoff, from both tables. */
  private deleteRawBefore(cutoff: number): void {
    this.db.prepare("DELETE FROM ledgers WHERE closed_at_unix < ?").run(cutoff);
    this.db.prepare("DELETE FROM fee_snapshots WHERE fetched_at_unix < ?").run(cutoff);
  }

  /**
   * Summarises every complete UTC day present in raw into `daily_rollups`.
   *
   * `beforeUnix` is the start of the in-progress UTC day, which is excluded —
   * a day still accumulating ledgers would be summarised as a fragment and
   * then, once it completed, be indistinguishable from a whole one.
   *
   * The day list is derived from the raw rows themselves rather than from the
   * retention boundary, which is what makes this idempotent. Given #90's
   * whole-day guarantee, a day still present in raw is *always* complete, so
   * recomputing it is exact; a day already pruned has no raw rows, so it never
   * appears here and its existing rollup row is never touched. There is no
   * state in which a partial day is rolled up.
   *
   * Consequently this covers days 1-7, not only the day aging out. Rolling up
   * just the boundary day would leave a seven-day hole at the right edge of a
   * 30d or 90d chart. Recomputing the rest is a grouped index scan a few times
   * a day, and `INSERT OR REPLACE` makes it self-correcting for ledgers that
   * arrive late.
   *
   * `date` is derived from `closed_at_unix` rather than parsed out of the
   * `closed_at` text, so it cannot drift with Horizon's formatting.
   *
   * Invalid close times are excluded from the average rather than averaged in.
   * This is the one place where the #84 data-quality bug would have become
   * irreversible: a poisoned *live* average ages out of a rolling in-memory
   * window within minutes, but a rollup row is written once and kept forever,
   * while the raw rows that would let you recompute it are deleted at the
   * retention boundary. `close_time_sample_count` records how many samples
   * survived the filter, so a row built from a heavily filtered day is
   * identifiable after the fact rather than silently confident.
   */
  private rollupCompleteDays(beforeUnix: number): void {
    this.db
      .prepare(
        `
      INSERT OR REPLACE INTO daily_rollups (
        network, date, avg_close_time_seconds, close_time_sample_count,
        avg_congestion_usage, max_congestion_usage, total_operations,
        total_successful_tx, total_failed_tx, avg_fee_p50, avg_fee_p90
      )
      WITH ledger_days AS (
        SELECT
          network,
          strftime('%Y-%m-%d', closed_at_unix / 1000, 'unixepoch') AS date,
          AVG(CASE WHEN ${VALID_CLOSE_TIME} THEN close_time_seconds END)
            AS avg_close_time_seconds,
          COUNT(CASE WHEN ${VALID_CLOSE_TIME} THEN 1 END)
            AS close_time_sample_count,
          SUM(operation_count) AS total_operations,
          SUM(successful_tx_count) AS total_successful_tx,
          SUM(failed_tx_count) AS total_failed_tx
        FROM ledgers
        WHERE closed_at_unix < ?
        GROUP BY network, date
      ),
      fee_days AS (
        SELECT
          network,
          strftime('%Y-%m-%d', fetched_at_unix / 1000, 'unixepoch') AS date,
          AVG(ledger_capacity_usage) AS avg_congestion_usage,
          MAX(ledger_capacity_usage) AS max_congestion_usage,
          AVG(fee_charged_p50) AS avg_fee_p50,
          AVG(fee_charged_p90) AS avg_fee_p90
        FROM fee_snapshots
        WHERE fetched_at_unix < ?
        GROUP BY network, date
      ),
      days AS (
        SELECT network, date FROM ledger_days
        UNION
        SELECT network, date FROM fee_days
      )
      SELECT
        d.network,
        d.date,
        l.avg_close_time_seconds,
        COALESCE(l.close_time_sample_count, 0),
        f.avg_congestion_usage,
        f.max_congestion_usage,
        COALESCE(l.total_operations, 0),
        COALESCE(l.total_successful_tx, 0),
        COALESCE(l.total_failed_tx, 0),
        f.avg_fee_p50,
        f.avg_fee_p90
      FROM days d
      LEFT JOIN ledger_days l ON l.network = d.network AND l.date = d.date
      LEFT JOIN fee_days f ON f.network = d.network AND f.date = d.date
    `,
      )
      .run(beforeUnix, beforeUnix);
  }

  /**
   * Rolls every complete UTC day into `daily_rollups`, then deletes the raw
   * rows that have aged out — both in one transaction.
   *
   * This is the production entry point. `pruneOlderThan` remains as the raw
   * delete primitive but is deliberately not reachable from the `db` facade,
   * because deleting a day without summarising it first is a one-way door.
   *
   * The single transaction is what makes a crash safe. Rolling up and then
   * deleting as two units would allow a failure between them to leave either
   * a rolled-up day whose raw rows survive — double-counted on the next run —
   * or deleted rows with no rollup, which is a permanent gap.
   */
  rollupAndPrune(retentionMs: number = RETENTION_MS): void {
    const now = Date.now();
    const cutoff = floorToUtcMidnight(now - retentionMs);
    const startOfToday = floorToUtcMidnight(now);

    this.db.transaction(() => {
      this.rollupCompleteDays(startOfToday);
      this.deleteRawBefore(cutoff);
    })();
  }

  /**
   * Deletes raw rows older than the retention window, rounded down so that
   * only whole UTC days are ever removed.
   *
   * `Date.now() - retentionMs` alone lands at whatever wall-clock time the
   * prune happens to run, which slices a UTC day in half: a run at 14:00Z
   * deletes the first fourteen hours of the boundary day and keeps the rest.
   * That leaves the oldest day in the store as a fragment of unpredictable
   * size — the amount kept depends on the minute the timer fired — and makes
   * any day-grain aggregate over it unsafe, because a half-deleted day is
   * indistinguishable from a complete one.
   *
   * Flooring the cutoff to UTC midnight trades an exact rolling seven days for
   * **7-8 whole UTC days**: never fewer than `RETENTION_DAYS`, sometimes up to
   * one more, and every day in the store either complete or absent.
   *
   * Deletes raw rows *without* rolling them up first, so it is not exposed on
   * the `db` facade. Use `rollupAndPrune` in production.
   */
  pruneOlderThan(retentionMs: number = RETENTION_MS): void {
    this.deleteRawBefore(floorToUtcMidnight(Date.now() - retentionMs));
  }

  getHistory(network: string = "mainnet", durationHours: number = 24): HistoryResponse {
    const durationMs = durationHours * 60 * 60 * 1000;
    const sinceUnix = Date.now() - durationMs;

    // Aggregate ledgers into 5-minute buckets
    const ledgerRows = this.db
      .prepare(
        `
      SELECT
        (closed_at_unix / ${BUCKET_RESOLUTION_MS}) * ${BUCKET_RESOLUTION_MS} AS bucket_time,
        AVG(close_time_seconds) AS avg_close_time,
        SUM(operation_count) AS total_ops,
        SUM(successful_tx_count + failed_tx_count) AS total_txs
      FROM ledgers
      WHERE network = ? AND closed_at_unix >= ?
      GROUP BY bucket_time
      ORDER BY bucket_time ASC
    `,
      )
      .all(network, sinceUnix) as Array<{
      bucket_time: number;
      avg_close_time: number | null;
      total_ops: number;
      total_txs: number;
    }>;

    // Aggregate fee snapshots into 5-minute buckets
    const feeRows = this.db
      .prepare(
        `
      SELECT
        (fetched_at_unix / ${BUCKET_RESOLUTION_MS}) * ${BUCKET_RESOLUTION_MS} AS bucket_time,
        AVG(ledger_capacity_usage) AS avg_capacity_usage,
        AVG(fee_charged_p50) AS avg_p50,
        AVG(fee_charged_p90) AS avg_p90
      FROM fee_snapshots
      WHERE network = ? AND fetched_at_unix >= ?
      GROUP BY bucket_time
      ORDER BY bucket_time ASC
    `,
      )
      .all(network, sinceUnix) as Array<{
      bucket_time: number;
      avg_capacity_usage: number | null;
      avg_p50: number | null;
      avg_p90: number | null;
    }>;

    const feeMap = new Map<number, (typeof feeRows)[0]>();
    for (const row of feeRows) {
      feeMap.set(row.bucket_time, row);
    }

    const allBuckets = new Set<number>();
    for (const row of ledgerRows) allBuckets.add(row.bucket_time);
    for (const row of feeRows) allBuckets.add(row.bucket_time);

    const sortedBuckets = [...allBuckets].sort((a, b) => a - b);
    const ledgerMap = new Map<number, (typeof ledgerRows)[0]>();
    for (const row of ledgerRows) {
      ledgerMap.set(row.bucket_time, row);
    }

    const points: HistoryPoint[] = sortedBuckets.map((bucketTime) => {
      const l = ledgerMap.get(bucketTime);
      const f = feeMap.get(bucketTime);

      return {
        timestamp: new Date(bucketTime).toISOString(),
        closeTimeSeconds: l?.avg_close_time ? Number(l.avg_close_time.toFixed(2)) : null,
        congestionUsage: f?.avg_capacity_usage ? Number(f.avg_capacity_usage.toFixed(4)) : null,
        operations: l?.total_ops ?? 0,
        transactions: l?.total_txs ?? 0,
        p50Fee: f?.avg_p50 ? Math.round(f.avg_p50) : null,
        p90Fee: f?.avg_p90 ? Math.round(f.avg_p90) : null,
      };
    });

    return {
      network,
      range: `${durationHours}h`,
      points,
    };
  }

  close(): void {
    this.db.close();
  }
}

let _dbInstance: NetPulseDatabase | null = null;

export function getDb(): NetPulseDatabase {
  if (!_dbInstance) {
    _dbInstance = new NetPulseDatabase();
  }
  return _dbInstance;
}

export const db = {
  insertLedgers: (...args: Parameters<NetPulseDatabase["insertLedgers"]>) =>
    getDb().insertLedgers(...args),
  insertFeeSnapshot: (...args: Parameters<NetPulseDatabase["insertFeeSnapshot"]>) =>
    getDb().insertFeeSnapshot(...args),
  /*
   * `pruneOlderThan` is deliberately absent. It deletes raw rows without
   * summarising them first, which is a one-way door — the only reachable
   * production entry point is the safe one. It remains a method on the class
   * for tests that need the delete primitive on its own.
   */
  rollupAndPrune: (...args: Parameters<NetPulseDatabase["rollupAndPrune"]>) =>
    getDb().rollupAndPrune(...args),
  getHistory: (...args: Parameters<NetPulseDatabase["getHistory"]>) =>
    getDb().getHistory(...args),
  close: () => {
    _dbInstance?.close();
    _dbInstance = null;
  },
};
