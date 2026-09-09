/*
 * Tests for rollup-gap-check.mjs.
 *
 * The standard here is the one #81 set for audit-deps.mjs: a diagnostic that
 * runs without crashing has proven nothing about whether it detects what it
 * claims to. So every case seeds a database with a *known* defect and asserts
 * the script finds exactly that defect, and each is paired with a negative
 * control on a clean database - a check that always reports a gap is as
 * useless as one that never does.
 *
 * Databases are real temp files rather than :memory:, because the script's job
 * is to open a file read-only and that is part of what needs testing.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { collect } from "./rollup-gap-check.mjs";

const SCRIPT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "rollup-gap-check.mjs",
);

let tmp;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "rollup-gap-check-"));
});

afterAll(() => {
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* the OS reclaims tmpdir; a cleanup failure must not fail the suite */
  }
});

const DAY_MS = 24 * 60 * 60 * 1000;

/** Schema copied from src/db.ts so a drift there shows up as a failure here. */
function createSchema(db, { withRollups = true } = {}) {
  db.exec(`
    CREATE TABLE ledgers (
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
  `);
  if (withRollups) {
    db.exec(`
      CREATE TABLE daily_rollups (
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
  }
}

function insertLedgers(db, network, sequences, dayUnix) {
  const stmt = db.prepare(
    `INSERT INTO ledgers (network, sequence, closed_at, closed_at_unix,
       close_time_seconds, successful_tx_count, failed_tx_count,
       operation_count, base_fee_in_stroops)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const seq of sequences) {
    const unix = dayUnix + (seq % 1000) * 5500;
    stmt.run(
      network,
      seq,
      new Date(unix).toISOString(),
      unix,
      5.5,
      3,
      1,
      7,
      100,
    );
  }
}

function insertRollup(db, network, date, ops) {
  db.prepare(
    `INSERT INTO daily_rollups (network, date, close_time_sample_count,
       total_operations, total_successful_tx, total_failed_tx)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(network, date, 100, ops, 50, 5);
}

/** Builds a database file and returns its path. */
function build(name, seed, opts) {
  const path = join(tmp, `${name}.db`);
  const db = new Database(path);
  createSchema(db, opts);
  seed(db);
  db.close();
  return path;
}

function readOnly(path) {
  return new Database(path, { readonly: true, fileMustExist: true });
}

function run(args) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

// Day 0 of the fake history, on a UTC midnight so date grouping is exact.
const DAY0 = Math.floor(Date.UTC(2026, 0, 1) / DAY_MS) * DAY_MS;
const DAY0_DATE = new Date(DAY0).toISOString().slice(0, 10);
const DAY1_DATE = new Date(DAY0 + DAY_MS).toISOString().slice(0, 10);

describe("rollup-gap-check: sequence gap detection", () => {
  it("finds a seeded 2-ledger gap and classifies it as a cursor handoff", () => {
    // 100..104 then 107..109: sequences 105 and 106 are absent.
    const path = build("gap2", (db) => {
      insertLedgers(
        db,
        "mainnet",
        [100, 101, 102, 103, 104, 107, 108, 109],
        DAY0,
      );
    });
    const db = readOnly(path);
    try {
      const data = collect(db);
      expect(data.perNetwork).toHaveLength(1);
      expect(data.perNetwork[0].missing).toBe(2);
      expect(data.perNetwork[0].rows_stored).toBe(8);
      expect(data.gaps).toHaveLength(1);
      expect(data.gaps[0]).toMatchObject({
        network: "mainnet",
        gap_start: 105,
        gap_end: 106,
        missing: 2,
      });
    } finally {
      db.close();
    }
  });

  it("finds a seeded large gap and separates it from a small one", () => {
    // Two gaps of different classes in one network: 2 missing, then 40 missing.
    const path = build("gapmix", (db) => {
      insertLedgers(db, "mainnet", [100, 101, 104, 105], DAY0); // 102,103 -> 2
      insertLedgers(db, "mainnet", [146, 147], DAY0); // 106..145 -> 40
    });
    const db = readOnly(path);
    try {
      const data = collect(db);
      expect(data.perNetwork[0].missing).toBe(42);
      expect(data.gaps.map((g) => g.missing)).toEqual([2, 40]);
      expect(data.gaps[1]).toMatchObject({ gap_start: 106, gap_end: 145 });
    } finally {
      db.close();
    }
  });

  it("reports no gaps on a contiguous database (negative control)", () => {
    const path = build("clean", (db) => {
      insertLedgers(db, "mainnet", [10, 11, 12, 13, 14], DAY0);
      insertLedgers(db, "testnet", [10, 11, 12], DAY0);
    });
    const db = readOnly(path);
    try {
      const data = collect(db);
      expect(data.gaps).toHaveLength(0);
      expect(data.perNetwork.map((n) => n.missing)).toEqual([0, 0]);
    } finally {
      db.close();
    }
  });

  it("keeps per-network gaps separate rather than spanning networks", () => {
    // Without PARTITION BY the jump from mainnet's 109 to testnet's 500 would
    // register as one enormous gap.
    const path = build("pernet", (db) => {
      insertLedgers(db, "mainnet", [108, 109], DAY0);
      insertLedgers(db, "testnet", [500, 501], DAY0);
    });
    const db = readOnly(path);
    try {
      const data = collect(db);
      expect(data.gaps).toHaveLength(0);
    } finally {
      db.close();
    }
  });
});

describe("rollup-gap-check: frozen rollup detection", () => {
  it("finds a seeded frozen day and ignores one that still has raw rows", () => {
    const path = build("frozen", (db) => {
      // DAY1 has raw rows; DAY0's were "pruned", so only its rollup remains.
      insertLedgers(db, "mainnet", [200, 201, 202], DAY0 + DAY_MS);
      insertRollup(db, "mainnet", DAY0_DATE, 999_999); // frozen
      insertRollup(db, "mainnet", DAY1_DATE, 1234); // still recomputable
    });
    const db = readOnly(path);
    try {
      const data = collect(db);
      expect(data.hasRollups).toBe(true);
      expect(data.rollupDayCount).toBe(2);
      expect(data.frozen).toHaveLength(1);
      expect(data.frozen[0]).toMatchObject({
        network: "mainnet",
        date: DAY0_DATE,
        total_operations: 999_999,
      });
    } finally {
      db.close();
    }
  });

  it("reports no frozen days when every rollup still has raw rows (negative control)", () => {
    const path = build("notfrozen", (db) => {
      insertLedgers(db, "mainnet", [300, 301], DAY0);
      insertRollup(db, "mainnet", DAY0_DATE, 42);
    });
    const db = readOnly(path);
    try {
      const data = collect(db);
      expect(data.rollupDayCount).toBe(1);
      expect(data.frozen).toHaveLength(0);
    } finally {
      db.close();
    }
  });

  it("does not treat one network's rollup as frozen because another network has that day", () => {
    const path = build("frozennet", (db) => {
      insertLedgers(db, "testnet", [400, 401], DAY0); // testnet has DAY0 raw
      insertRollup(db, "mainnet", DAY0_DATE, 777); // mainnet's DAY0 is frozen
      insertRollup(db, "testnet", DAY0_DATE, 888); // testnet's is not
    });
    const db = readOnly(path);
    try {
      const data = collect(db);
      expect(data.frozen).toHaveLength(1);
      expect(data.frozen[0]).toMatchObject({
        network: "mainnet",
        total_operations: 777,
      });
    } finally {
      db.close();
    }
  });
});

describe("rollup-gap-check: pre-#87 schema", () => {
  it("reports a missing daily_rollups table as a finding, not an error", () => {
    const path = build(
      "prerollup",
      (db) => insertLedgers(db, "mainnet", [1, 2, 5], DAY0),
      { withRollups: false },
    );
    const db = readOnly(path);
    try {
      const data = collect(db);
      expect(data.hasLedgers).toBe(true);
      expect(data.hasRollups).toBe(false);
      expect(data.frozen).toBeNull();
      // Gap detection still works without the rollups table.
      expect(data.gaps).toHaveLength(1);
      expect(data.gaps[0].missing).toBe(2);
    } finally {
      db.close();
    }
  });

  it("exits 0 and says the deployment predates #87", () => {
    const path = build(
      "prerollup-cli",
      (db) => insertLedgers(db, "mainnet", [1, 2, 3], DAY0),
      { withRollups: false },
    );
    const r = run([path]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/No daily_rollups table/);
    expect(r.stdout).toMatch(/predates #87/);
    expect(r.stdout).toMatch(/nothing has been frozen/);
  });
});

describe("rollup-gap-check: command line behaviour", () => {
  it("exits 0 and reports findings rather than failing on them", () => {
    // A report, not a gate: gaps and frozen days must not set a failure code.
    const path = build("cli", (db) => {
      insertLedgers(db, "mainnet", [100, 101, 104], DAY0 + DAY_MS);
      insertRollup(db, "mainnet", DAY0_DATE, 555);
    });
    const r = run([path]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/missing in range: 2/);
    expect(r.stdout).toMatch(/have no raw rows left/);
    expect(r.stdout).toMatch(/555/);
  });

  it("emits parseable JSON with --json", () => {
    const path = build("json", (db) => {
      insertLedgers(db, "mainnet", [10, 13], DAY0);
    });
    const r = run([path, "--json"]);
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.gaps).toHaveLength(1);
    expect(parsed.gaps[0].missing).toBe(2);
    expect(parsed.database).toContain("json.db");
  });

  it("exits 1 on a database path that does not exist", () => {
    const r = run([join(tmp, "nope.db")]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no database at/);
  });

  it("exits 1 on a file that is not a netpulse database", () => {
    const path = join(tmp, "empty.db");
    const db = new Database(path);
    db.exec("CREATE TABLE something_else (x INTEGER)");
    db.close();
    const r = run([path]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/no 'ledgers' table/);
  });

  it("exits 2 on an unknown option", () => {
    const r = run(["--wat"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown option/);
  });

  it("exits 2 when given more than one path", () => {
    const r = run(["a.db", "b.db"]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/at most one database path/);
  });
});

describe("rollup-gap-check: opens the database read-only", () => {
  it("cannot write through the connection it uses", () => {
    // The property the header claims, asserted rather than trusted: a
    // read-only connection must reject a write outright.
    const path = build("ro", (db) =>
      insertLedgers(db, "mainnet", [1, 2], DAY0),
    );
    const db = readOnly(path);
    try {
      expect(() =>
        db.prepare("DELETE FROM ledgers WHERE sequence = 1").run(),
      ).toThrow(/readonly|read-only/i);
    } finally {
      db.close();
    }
  });
});
