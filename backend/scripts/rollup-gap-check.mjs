#!/usr/bin/env node
// Read-only diagnostic: how much ledger data is missing, and how much of that
// loss is already permanent.
//
// WHY THIS EXISTS
//
// `rollupCompleteDays()` in src/db.ts aggregates with SUM(operation_count),
// SUM(successful_tx_count) and SUM(failed_tx_count). Those are additive, so a
// ledger that was never ingested is a straight undercount rather than a
// rounding error. `rollupAndPrune()` runs at process start and every six hours;
// past RETENTION_DAYS the raw rows behind a day are deleted, and from that
// moment the rollup row is frozen. The undercount becomes permanent and cannot
// be recomputed from anything local.
//
// This script answers two questions about a given database:
//
//   1. Are ledger sequences contiguous, and if not, how large are the gaps?
//      Size is the useful signal. Clusters of 1-2 missing ledgers look like the
//      warm-up-to-stream cursor handoff (#109). Runs of hundreds look like
//      downtime that nothing backfilled, since production polls no ledgers
//      after the warm-up.
//
//   2. Which daily_rollups rows no longer have raw rows behind them? Those are
//      the days whose undercount is already beyond local repair.
//
// It only measures. It writes nothing, repairs nothing, and finding gaps is not
// an error — see EXIT CODES.
//
// USAGE
//
//   node backend/scripts/rollup-gap-check.mjs [db-path] [--json]
//
// The path is taken from the first argument, else $DATABASE_PATH, else
// ./data/netpulse.db — the same resolution src/db.ts uses, minus its
// NODE_ENV=test special case, which would point a diagnostic at :memory:.
//
//   # against a local database
//   node backend/scripts/rollup-gap-check.mjs
//
//   # against a deployment, from the host running the backend
//   node backend/scripts/rollup-gap-check.mjs /var/lib/netpulse/netpulse.db
//
//   # machine-readable, for pasting into an issue or piping to jq
//   node backend/scripts/rollup-gap-check.mjs --json
//
// RUNNING THIS AGAINST A LIVE PRODUCTION DATABASE
//
// Safe, and safe by construction rather than by convention. Three things make
// it so, and they are worth knowing because the obvious alternatives are not
// safe:
//
//   * The connection is opened READ-ONLY (SQLITE_OPEN_READONLY). It cannot
//     write, so it cannot corrupt the file and cannot block `rollupAndPrune`.
//     A diagnostic that opened the database read-write would be a second
//     writer on the file you are investigating for data loss.
//
//   * src/db.ts sets `journal_mode = WAL`. In WAL mode readers get a
//     consistent snapshot and do not block the writer, so this needs no
//     downtime, no maintenance window, and no stopping the backend.
//
//   * `rollupAndPrune()` performs the rollup and the delete in ONE
//     transaction. A read landing in the middle of a prune therefore sees
//     either the whole pre-state or the whole post-state, never a day that is
//     half rolled up and half deleted.
//
// If you would rather analyse a copy, copy all three files together --
// `netpulse.db`, `netpulse.db-wal` and `netpulse.db-shm`. Copying only the
// first gives you a snapshot missing every commit still sitting in the WAL,
// which reads as data loss that is not real.
//
// EXIT CODES
//
//   0  the report ran, whatever it found. Gaps and frozen days are findings,
//      not failures: this is a report, not a CI gate.
//   1  the database could not be read, or has no `ledgers` table at all.
//   2  bad invocation.

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const DEFAULT_DB_PATH = "./data/netpulse.db";

/*
 * Gap sizes are bucketed rather than reported raw in the summary because the
 * bucket is the diagnosis. The boundary is not arbitrary: the warm-up fetches
 * LEDGERS_PER_POLL (20) ledgers, so a gap wider than that is one nothing could
 * have backfilled, while 1-2 is the handful that close during a connection
 * handshake.
 */
const WARM_UP_LEDGERS = 20;

function classify(missing) {
  if (missing <= 2) return "1-2 (cursor handoff, cf. #109)";
  if (missing <= WARM_UP_LEDGERS)
    return `3-${WARM_UP_LEDGERS} (within warm-up)`;
  return `>${WARM_UP_LEDGERS} (beyond warm-up: unbackfilled downtime)`;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const positional = args.filter((a) => !a.startsWith("--"));
  if (positional.length > 1) {
    return { error: "at most one database path may be given" };
  }
  const unknown = args.filter((a) => a.startsWith("--") && a !== "--json");
  if (unknown.length > 0) {
    return { error: `unknown option(s): ${unknown.join(", ")}` };
  }
  return {
    json,
    dbPath: positional[0] ?? process.env.DATABASE_PATH ?? DEFAULT_DB_PATH,
  };
}

function tableExists(db, name) {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name) !== undefined
  );
}

export function collect(db) {
  const hasLedgers = tableExists(db, "ledgers");
  if (!hasLedgers) {
    return { hasLedgers: false };
  }

  /*
   * The summary figure the investigation actually asked for: how many
   * sequences are absent from the range the table spans.
   */
  const perNetwork = db
    .prepare(
      `SELECT network,
              COUNT(*)                                    AS rows_stored,
              MIN(sequence)                               AS min_sequence,
              MAX(sequence)                               AS max_sequence,
              MAX(sequence) - MIN(sequence) + 1 - COUNT(*) AS missing,
              MIN(closed_at)                              AS first_closed_at,
              MAX(closed_at)                              AS last_closed_at
       FROM ledgers
       GROUP BY network
       ORDER BY network`,
    )
    .all();

  /*
   * Individual gaps via LAG rather than by pulling every sequence into JS: a
   * week of mainnet is well over a hundred thousand rows, and this keeps the
   * work in SQLite where the index already orders it.
   */
  const gaps = db
    .prepare(
      `SELECT network, gap_start, gap_end, missing, after_closed_at
       FROM (
         SELECT network,
                LAG(sequence)  OVER w + 1                  AS gap_start,
                sequence - 1                               AS gap_end,
                sequence - LAG(sequence) OVER w - 1        AS missing,
                LAG(closed_at) OVER w                      AS after_closed_at,
                LAG(sequence)  OVER w                      AS prev_sequence
         FROM ledgers
         WINDOW w AS (PARTITION BY network ORDER BY sequence)
       )
       WHERE prev_sequence IS NOT NULL AND missing > 0
       ORDER BY network, gap_start`,
    )
    .all();

  const hasRollups = tableExists(db, "daily_rollups");
  let frozen = null;
  let rollupDayCount = null;
  if (hasRollups) {
    rollupDayCount = db
      .prepare("SELECT COUNT(*) AS n FROM daily_rollups")
      .get().n;
    /*
     * A rollup day with no surviving raw rows. `total_operations` is carried
     * through so the magnitude of the frozen number is visible rather than
     * just the fact that it is frozen.
     */
    frozen = db
      .prepare(
        `SELECT r.network, r.date, r.total_operations, r.total_successful_tx,
                r.total_failed_tx, r.close_time_sample_count
         FROM daily_rollups r
         LEFT JOIN (
           SELECT network,
                  strftime('%Y-%m-%d', closed_at_unix / 1000, 'unixepoch') AS d
           FROM ledgers
           GROUP BY network, d
         ) l ON l.network = r.network AND l.d = r.date
         WHERE l.d IS NULL
         ORDER BY r.network, r.date`,
      )
      .all();
  }

  return {
    hasLedgers: true,
    perNetwork,
    gaps,
    hasRollups,
    rollupDayCount,
    frozen,
  };
}

function renderText(dbPath, data) {
  const out = [];
  const line = (s = "") => out.push(s);

  line(`netpulse rollup-gap-check`);
  line(`database: ${dbPath}`);
  line(`read-only: yes`);
  line();

  line(`=== 1. ledger sequence gaps ===`);
  line();
  if (data.perNetwork.length === 0) {
    line(`  ledgers table is present but empty - nothing to report.`);
  } else {
    for (const n of data.perNetwork) {
      line(`  ${n.network}`);
      line(`    rows stored     : ${n.rows_stored}`);
      line(`    sequence range  : ${n.min_sequence} .. ${n.max_sequence}`);
      line(`    missing in range: ${n.missing}`);
      line(`    window          : ${n.first_closed_at} .. ${n.last_closed_at}`);
    }
    line();
    const total = data.gaps.reduce((s, g) => s + g.missing, 0);
    line(`  distinct gaps: ${data.gaps.length}   ledgers missing: ${total}`);
    if (data.gaps.length > 0) {
      const buckets = new Map();
      for (const g of data.gaps) {
        const k = classify(g.missing);
        buckets.set(k, (buckets.get(k) ?? 0) + 1);
      }
      line();
      line(`  by size:`);
      for (const [k, v] of buckets)
        line(`    ${String(v).padStart(5)}  x  ${k}`);
      line();
      line(`  network   gap_start     gap_end   missing  after`);
      for (const g of data.gaps) {
        line(
          `  ${g.network.padEnd(8)} ${String(g.gap_start).padStart(10)}` +
            ` ${String(g.gap_end).padStart(11)} ${String(g.missing).padStart(9)}` +
            `  ${g.after_closed_at ?? ""}`,
        );
      }
    }
  }
  line();

  line(`=== 2. frozen rollup days (raw rows already pruned) ===`);
  line();
  if (!data.hasRollups) {
    // Deliberately a finding, not an error. See the header.
    line(`  No daily_rollups table in this database.`);
    line();
    line(`  This deployment predates #87, so no daily summaries have been`);
    line(`  written and nothing has been frozen. Any gap above is still`);
    line(`  reparable from Horizon: no rollup row depends on it yet.`);
  } else if (data.frozen.length === 0) {
    line(`  ${data.rollupDayCount} rollup day(s), none frozen.`);
    line();
    line(`  Every rollup day still has raw rows behind it, so rollupAndPrune`);
    line(`  recomputes them on its next run. Backfilling a gap now would`);
    line(`  correct the affected days rather than leaving them wrong.`);
  } else {
    line(
      `  ${data.frozen.length} of ${data.rollupDayCount} rollup day(s) have no raw rows left.`,
    );
    line(`  Their totals cannot be recomputed locally.`);
    line();
    line(`  network   date          operations    tx_ok  tx_fail  ct_samples`);
    for (const f of data.frozen) {
      line(
        `  ${f.network.padEnd(8)} ${f.date}  ${String(f.total_operations).padStart(12)}` +
          ` ${String(f.total_successful_tx).padStart(8)} ${String(f.total_failed_tx).padStart(8)}` +
          ` ${String(f.close_time_sample_count).padStart(11)}`,
      );
    }
  }
  line();
  return out.join("\n");
}

function main() {
  const parsed = parseArgs(process.argv);
  if (parsed.error) {
    console.error(`rollup-gap-check: ${parsed.error}`);
    console.error(
      `usage: node backend/scripts/rollup-gap-check.mjs [db-path] [--json]`,
    );
    process.exit(2);
  }

  const { dbPath, json } = parsed;
  const absolute = resolve(process.cwd(), dbPath);

  if (!existsSync(absolute)) {
    console.error(`rollup-gap-check: no database at ${absolute}`);
    process.exit(1);
  }

  let db;
  try {
    // readonly is SQLITE_OPEN_READONLY: this connection cannot write, so it
    // cannot block or corrupt a live writer. fileMustExist stops better-sqlite3
    // from helpfully creating an empty database when the path is wrong.
    db = new Database(absolute, { readonly: true, fileMustExist: true });
  } catch (err) {
    console.error(
      `rollup-gap-check: could not open ${absolute} read-only: ${err.message}`,
    );
    process.exit(1);
  }

  try {
    const data = collect(db);
    if (!data.hasLedgers) {
      console.error(
        `rollup-gap-check: ${absolute} has no 'ledgers' table - not a netpulse database?`,
      );
      process.exit(1);
    }
    if (json) {
      console.log(JSON.stringify({ database: absolute, ...data }, null, 2));
    } else {
      console.log(renderText(absolute, data));
    }
    process.exit(0);
  } finally {
    db.close();
  }
}

// Only run when invoked directly, so the test can import `collect`.
if (
  process.argv[1] &&
  resolve(process.argv[1]).endsWith("rollup-gap-check.mjs")
) {
  main();
}
