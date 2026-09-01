import Database from "better-sqlite3";
import fs from "fs";
import path from "path";
import type { FeeSnapshot, LedgerSample } from "./types.js";

const DEFAULT_DB_PATH =
  process.env.NODE_ENV === "test"
    ? ":memory:"
    : process.env.DATABASE_PATH ?? "./data/netpulse.db";

const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
const BUCKET_RESOLUTION_MS = 5 * 60 * 1000; // 5 minutes

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
    this.db.pragma("journal_mode = WAL");
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
    `);
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

  pruneOlderThan(retentionMs: number = RETENTION_MS): void {
    const cutoff = Date.now() - retentionMs;
    this.db.prepare("DELETE FROM ledgers WHERE closed_at_unix < ?").run(cutoff);
    this.db.prepare("DELETE FROM fee_snapshots WHERE fetched_at_unix < ?").run(cutoff);
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

export const db = new NetPulseDatabase();
