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
  - Reconnect-with-exponential-backoff is handled automatically on disconnections, resuming from the latest paging token cursor to prevent gaps or duplicate processing.
  - Because Horizon does not offer SSE streaming on `/fee_stats`, the backend continues to poll `/fee_stats` on a configurable interval.
- **WebSocket Broadcast Fan-out:** Instead of multiple browser tabs opening individual SSE connections to public Horizon, the backend terminates the Horizon stream and broadcasts updates over a single WebSocket channel (`/ws`) to all connected frontend clients.
- **Dual-Mode Frontend & Fallback:** The frontend uses the `useSubscription` hook to receive real-time pushes over WebSocket, with seamless automatic fallback to HTTP polling (`/api/health`, `/api/ledgers/recent`, `/api/fees/recent`) if WebSocket connectivity is blocked or unavailable.
- **Backward-Compatible REST APIs:** All REST endpoints remain active and continue to serve up-to-date in-memory metrics for external scripts, health probes, and test harnesses.

## Stack

**Backend: Node.js + TypeScript + Express**
- Single long-running process ingests from Horizon (SSE stream for
  ledgers, interval polling for `/fee_stats` and `/operations`),
  normalizes responses into the dashboard's own small data shape, and
  keeps a rolling in-memory window per network (last ~50 ledgers, ~10
  fee_stats snapshots, ~20 Soroban samples — a few KB).
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
- SQLite additionally records ledgers and fee snapshots, pruned to a 7-day
  retention window, and serves the longer-range history view via 5-minute
  bucket aggregation in SQL.
- Ledgers are keyed on `(network, sequence)` with `INSERT OR REPLACE`, so
  a stream reconnect that re-delivers a ledger is idempotent rather than
  double-counting.
- WAL journal mode, so the read path for history never blocks ingestion.

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
        │  - writes ledgers + fee snapshots to SQLite (7-day retention)
        │  - reconnects with exponential backoff (1s → 30s cap), resuming
        │    from the last paging-token cursor so no ledger is missed
        │  - tracks last-successful-update timestamp for staleness detection
        │  - notifies subscribers on every store update
        ├──────────────────────────────┐
        ▼                              ▼
Express REST API              WebSocket /ws
  GET /api/health               - one channel, fanned out to all clients
  GET /api/ledgers/recent       - pushes a snapshot on every store update
  GET /api/fees/recent          - client picks its network via a
  GET /api/soroban                subscribe / setNetwork message
  GET /api/history  (SQLite-backed, 5-min buckets)
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
        - 24h history view (from SQLite)
        - Congestion banner above the configured threshold
        - Staleness banner if the backend hasn't gotten fresh Horizon data
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
├── backend/
│   ├── src/
│   │   ├── index.ts       Express app entry point + route definitions
│   │   ├── horizon.ts     Horizon fetch functions + SSE stream client
│   │   ├── poller.ts      SSE ingestion, interval polling, rolling stores
│   │   ├── ws.ts          WebSocket server + snapshot fan-out
│   │   ├── db.ts          SQLite persistence, retention, history buckets
│   │   ├── metrics.ts     derives dashboard metrics from raw samples
│   │   ├── types.ts       shared types
│   │   └── *.test.ts      Vitest suites (metrics, API integration)
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
└── frontend/
    ├── src/
    │   ├── main.tsx
    │   ├── App.tsx
    │   ├── api.ts             typed fetch wrappers + response types
    │   ├── useSubscription.ts WebSocket subscription + REST fallback
    │   ├── usePolling.ts      interval polling hook (fallback path)
    │   ├── format.ts          number/duration formatting helpers
    │   ├── components/        stat tiles + charts + history view
    │   └── styles.css
    ├── index.html
    ├── vite.config.ts         dev proxy for /api and /ws
    ├── package.json
    └── tsconfig.json
```
