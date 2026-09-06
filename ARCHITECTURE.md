# Architecture: NetPulse

## Data Source: Which Horizon, and Why Mainnet Is the Default

**Public mainnet Horizon (`https://horizon.stellar.org`)**, read-only, no
API key required. Since Phase 2 the backend also polls **testnet**
(`https://horizon-testnet.stellar.org`), selectable from the dashboard
header — but mainnet remains the default, for the reasons below.

Testnet was deliberately not the default:

- Testnet is periodically reset/wiped by SDF, which would make "network
  health" readings meaningless or misleading around reset events.
- Testnet traffic is dominated by bot/test load rather than organic
  economic activity, so fee-bidding behavior and congestion patterns don't
  reflect real network conditions — the exact thing this dashboard exists
  to show.
- The target users (Stellar/Soroban developers, ecosystem tooling
  maintainers) care about *real* network conditions when deciding things
  like "should I bump my fee right now," which only mainnet data answers
  meaningfully.

Testnet was added anyway because it is genuinely useful for the *other*
thing developers do — sanity-checking a contract deployment or a fee
strategy against the network they are actually testing on. Both networks
are polled independently and kept in separate rolling stores, so switching
networks in the UI never mixes their data.

Both endpoints are overridable via `HORIZON_URL` and `HORIZON_TESTNET_URL`.
Public Horizon exposes everything the dashboard needs as unauthenticated
GET requests, so there is no credential or account to provision.
Futurenet remains unsupported.

## Horizon SSE Streaming & WebSocket Push Architecture

As of Phase 2, NetPulse utilizes a hybrid streaming architecture combining Horizon SSE streaming, periodic fee snapshot polling, and WebSocket push fan-out to clients:

- **Single Backend Ingestion Stream:** The backend maintains a single long-lived Server-Sent Events (`Accept: text/event-stream`) connection to Horizon's `/ledgers` endpoint.
  - Reconnect-with-exponential-backoff is handled automatically on disconnections, advancing a cursor as records arrive so the stream resumes roughly where it left off.
  - **Only paging tokens are ever used as cursors** ([#84](https://github.com/solaawojobi00-bit/netpulse-xlm/issues/84)). The initial cursor is `"now"`, and the loop advances it from each record's `paging_token`. Seeding a raw ledger `sequence` — a different kind of identifier, which Horizon reinterprets — is what caused a freshly started backend to ingest ledgers from months earlier alongside current ones. A record arriving without a token leaves the cursor on the last good one rather than falling back to a sequence.
  - Resumption is still not guaranteed gap-free. A fresh start streams from `"now"`, so ledgers closing between the warm-up fetch and the stream opening are not delivered — a few seconds at process start. Ledger rows are keyed on `(network, sequence)` with `INSERT OR REPLACE`, so redelivery after a reconnect is idempotent in SQLite.
  - Close time is measured against the ledger that precedes a record **by sequence**, not the newest ledger in the store. With no such predecessor in the window the close time is reported as `null` rather than as a delta against an unrelated ledger — which is what produced close times of around -36,000,000 seconds.
  - Because Horizon does not offer SSE streaming on `/fee_stats`, the backend continues to poll `/fee_stats` on a configurable interval.
- **WebSocket Broadcast Fan-out:** Instead of multiple browser tabs opening individual SSE connections to public Horizon, the backend terminates the Horizon stream and broadcasts updates over a single WebSocket channel (`/ws`) to all connected frontend clients.
- **Dual-Mode Frontend & Fallback:** The frontend uses the `useSubscription` hook to receive real-time pushes over WebSocket, with seamless automatic fallback to HTTP polling if WebSocket connectivity is blocked or unavailable. The fallback path polls all five live endpoints — `/api/health`, `/api/ledgers/recent`, `/api/fees/recent`, `/api/soroban` and `/api/operations/breakdown` — in one `Promise.all`, mirroring what a single WebSocket snapshot frame carries. `/api/history` is fetched separately on its own interval in both modes.
- **Backward-Compatible REST APIs:** All REST endpoints remain active and continue to serve up-to-date in-memory metrics for external scripts, health probes, and test harnesses.

## Stack

**Backend: Node.js + TypeScript + Express**
- Single long-running process ingests from Horizon (SSE stream for
  ledgers, interval polling for `/fee_stats` and `/operations`),
  normalizes responses into the dashboard's own small data shape, and
  keeps a rolling in-memory window per network (last 50 ledgers, 10
  fee_stats snapshots, 20 Soroban samples, 20 operation-type samples — a
  few KB).
- Exposes a small REST API consumed by the frontend, plus a WebSocket
  channel for push updates. REST (not GraphQL/tRPC) because the API
  surface is tiny and fixed-shape — no query flexibility is needed.
- TypeScript for shared type safety between the ingestion logic and the
  API response shapes.

**Frontend: React + TypeScript + Vite**
- React because it's the most broadly known UI framework across the
  Stellar/Soroban JS ecosystem (Soroban's own JS/TS SDK tooling assumes
  familiarity with this stack), which lowers the bar for contributors
  picking up "add a new chart" issues.
- Vite for fast local dev (instant HMR) and a trivial static production
  build.
- Charting via a lightweight React chart library (Recharts) rather than a
  raw D3 integration — keeps "add a new chart" issues approachable without
  requiring D3 knowledge.

**Persistence: SQLite (better-sqlite3), added in Phase 2**

v1 ran with no database at all — the rolling in-memory window was the only
state, and a restart simply re-filled it from live Horizon data. That was
the right call for a live-snapshot tool, but it capped the dashboard at
"the last few minutes," which made trend questions unanswerable.

Phase 2 added a SQLite file (`DATABASE_PATH`, default `./data/netpulse.db`)
alongside the in-memory window rather than replacing it:

- The in-memory rolling window still serves every live view. It stays the
  hot path — no query hits disk to render the dashboard's live charts.
- SQLite additionally records ledgers and fee snapshots, pruned to a
  retention window of 7-8 whole UTC days, and serves the longer-range history
  view via 5-minute bucket aggregation in SQL.
- The prune cutoff is floored to UTC midnight, so a day in the store is
  either complete or absent, never a fragment. An unfloored cutoff lands at
  whatever time the prune runs and slices the boundary day in half, which
  makes the size of the oldest day depend on when the timer fired and makes
  any day-grain aggregate over it unsafe. The cost is that retention is
  7-8 days rather than exactly 7 — never less than `RETENTION_DAYS`,
  sometimes up to a day more.
- Ledgers are keyed on `(network, sequence)` with `INSERT OR REPLACE`, so
  a stream reconnect that re-delivers a ledger is idempotent rather than
  double-counting.
- WAL journal mode, so the read path for history never blocks ingestion.

**Two retention tiers.** Raw ledgers and fee snapshots are kept for 7-8 whole
UTC days as above. Before a day is deleted it is summarised into a
`daily_rollups` table that is **kept indefinitely** — roughly 365 rows per year
per network — so daily-grain history survives the raw data it was computed
from.

- The rollup and the delete run in **one transaction** (`rollupAndPrune`), and
  the rollup happens first. Two separate units would let a crash between them
  leave either a rolled-up day whose raw rows survive, which the next run would
  count twice, or deleted rows with no rollup, which is a permanent gap.
- It runs at process start and every six hours thereafter. Startup alone is not
  enough: a process that stays up for weeks would otherwise honour the
  retention window exactly once and let the file grow until the next redeploy.
  Six hours is far more often than a day boundary actually moves, and
  deliberately not tied to the ~6s Horizon poll interval — a day-scan does not
  belong there. A failure is logged and swallowed, because a database that
  cannot be pruned can still serve reads and accept writes; the transaction
  means nothing is half-applied and the next run simply repeats the work.
- Each run summarises **every complete UTC day still present in raw**, not only
  the day aging out. Rolling up just the boundary day would leave a seven-day
  hole at the right edge of a 30d or 90d chart. Recomputing days 1-7 is a
  grouped index scan a few times a day, and `INSERT OR REPLACE` on
  `(network, date)` makes it self-correcting for ledgers that arrive late.
- The day list comes from the raw rows themselves, excluding the in-progress
  UTC day. This is what makes the rollup idempotent, and it depends on the
  whole-day cutoff above: a day still present in raw is always complete, so
  recomputing it is exact, and a day already pruned has no raw rows and is
  never revisited. There is no state in which a partial day is rolled up.
- `pruneOlderThan` remains as the raw-delete primitive but is deliberately not
  exposed on the `db` facade — deleting a day without summarising it first is a
  one-way door, so the only entry point reachable from production code is the
  safe one.
- Invalid close times are **excluded** from `avg_close_time_seconds` rather
  than averaged in, using the same `finite AND > 0` rule as the live health
  average — spelled once in `closeTime.ts`, as a predicate for TypeScript and
  as a SQL fragment for this aggregate, so the two cannot drift. This is the
  one place where a bad sample would be irreversible: a poisoned live average
  ages out of the rolling window within minutes, but a rollup row is permanent
  and the raw rows behind it are deleted at the boundary.
  `close_time_sample_count` records how many samples survived the filter, so a
  row computed from a heavily filtered day is identifiable rather than
  silently confident.

**Still no auth and no user-specific data** — deliberately, per the PRD
out-of-scope list. The database holds public network measurements only;
losing it costs history, not correctness.

## Data Flow (End to End)

Run once per network (mainnet and testnet independently):

```
Public Horizon (horizon.stellar.org / horizon-testnet.stellar.org)
        │  SSE  /ledgers?cursor=…&order=asc  (streamed: close time, throughput, op counts)
        │  GET  /fee_stats                   (polled: base fee, percentiles, capacity usage)
        │  GET  /operations?order=desc       (polled: Soroban invoke_host_function activity)
        ▼
Backend ingestion (persistent SSE stream + ~6s interval for the polled endpoints)
        │  - normalizes into internal types (LedgerSample, FeeSnapshot, SorobanSample)
        │  - appends to a capped in-memory rolling window, per network
        │  - writes ledgers + fee snapshots to SQLite (7-8 whole UTC days),
        │    rolled up into daily_rollups (kept indefinitely) before deletion
        │  - reconnects with exponential backoff (1s → 30s cap), resuming
        │    from its last paging token — see the SSE section above;
        │    a fresh start streams from "now", so resumption is not
        │    gap-free at process start
        │  - tracks last-successful-update timestamp for staleness detection
        │  - notifies subscribers on every store update
        ├──────────────────────────────┐
        ▼                              ▼
Express REST API                      WebSocket /ws
  GET /healthz  (liveness only)         - one channel, fanned out to all clients
  GET /api/health                       - pushes a snapshot on every store update
  GET /api/ledgers/recent               - client picks its network via a
  GET /api/fees/recent                    subscribe / setNetwork message
  GET /api/soroban
  GET /api/operations/breakdown
  GET /api/history  (SQLite-backed, 5-min buckets, 7-8 day window)
  GET /api/trends   (SQLite-backed, daily rollups, 30d/90d/1y)
  -> full reference: docs/API.md
        │                              │
        └──────────────┬───────────────┘
                       ▼
Frontend (React — useSubscription)
        │  - WebSocket push is the primary path
        │  - falls back to REST polling if WebSocket is blocked/unavailable
        │  - history is fetched separately over REST on its own interval
        ▼
Dashboard UI
        - Stat tiles (close time, base fee, congestion %, throughput, Soroban)
        - Ledger close time trend chart
        - Operation count / throughput trend chart
        - Transaction success/failure ratio chart
        - Fee percentile chart + fee spread trend chart
        - Soroban invocation activity chart
        - Operation type breakdown chart
        - 24h history view (from SQLite), with CSV/JSON export
        - Congestion banner above the configured threshold
        - Staleness banner if the backend hasn't gotten fresh Horizon data
        - Per-chart loading / empty / error states
        - Light and dark theme, toggled in the header
        - Network and history range reflected in the URL, so a view is
          shareable and survives a reload
```

The backend sits between the frontend and Horizon (rather than the
frontend calling Horizon directly) so that: (1) many open dashboard tabs
share one upstream connection instead of each hammering Horizon
independently — this is what makes SSE viable at all, since the browser
fan-out happens over the backend's own WebSocket channel rather than N
Horizon streams, (2) derived-metric logic (rolling averages, congestion
banding) lives in one place instead of being duplicated/re-derived
client-side, and (3) it gave a clean seam for exactly the changes Phase 2
made — WebSocket push and a real datastore both landed behind this
boundary without the frontend's data shapes changing.

## Project Structure

```
netpulse-xlm/
├── .github/
│   ├── scripts/
│   │   └── audit-deps.mjs   npm audit wrapper: real advisories fail,
│   │                        registry outages warn
│   ├── workflows/
│   │   ├── ci.yml           backend + frontend + secret scan
│   │   └── codeql.yml       static analysis
│   └── pull_request_template.md
├── docs/
│   └── API.md               REST + WebSocket reference for consumers
├── backend/
│   ├── src/
│   │   ├── index.ts       Express app entry point + route definitions
│   │   ├── horizon.ts     Horizon fetch functions + SSE stream client
│   │   ├── poller.ts      SSE ingestion, interval polling, rolling stores
│   │   ├── ws.ts          WebSocket server + snapshot fan-out
│   │   ├── db.ts          SQLite persistence, rollup-then-prune retention,
│   │   │                  history buckets, daily trend rows
│   │   ├── metrics.ts     derives dashboard metrics from raw samples
│   │   ├── alerts.ts      congestion threshold alerts + webhook delivery
│   │   ├── csv.ts         generic CSV writer + history/trends export
│   │   ├── closeTime.ts   what counts as a valid ledger close time
│   │   ├── origins.ts     CORS/WebSocket origin allowlist parsing
│   │   ├── shutdown.ts    graceful shutdown runner
│   │   ├── logger.ts      structured logging
│   │   ├── types.ts       shared types
│   │   └── *.test.ts      Vitest suites (metrics, API integration,
│   │                      alerts, docs drift guard)
│   ├── .env.example
│   ├── package.json
│   ├── vitest.config.ts
│   └── tsconfig.json
└── frontend/
    ├── scripts/
    │   ├── contrast-audit.mjs     WCAG AA palette check (runs in CI)
    │   └── a11y-browser-check.mjs manual browser a11y pass
    ├── src/
    │   ├── main.tsx
    │   ├── App.tsx
    │   ├── api.ts             typed fetch wrappers + response types
    │   ├── useSubscription.ts WebSocket subscription + REST fallback
    │   ├── usePolling.ts      interval polling hook (fallback path)
    │   ├── useQueryParam.ts   URL-backed state (network, history range)
    │   ├── useTheme.ts        light/dark theme preference
    │   ├── format.ts          number/duration formatting helpers
    │   ├── components/        stat tiles, charts, history view,
    │   │                      error boundary, theme toggle
    │   └── styles.css
    ├── index.html
    ├── vite.config.ts         dev proxy for /api and /ws
    ├── package.json
    └── tsconfig.json
```
