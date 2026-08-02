# Architecture: NetPulse

## Data Source: Which Horizon, and Why Mainnet

**Public mainnet Horizon (`https://horizon.stellar.org`)**, read-only, no
API key required.

Testnet was considered and rejected for v1:

- Testnet is periodically reset/wiped by SDF, which would make "network
  health" readings meaningless or misleading around reset events.
- Testnet traffic is dominated by bot/test load rather than organic
  economic activity, so fee-bidding behavior and congestion patterns don't
  reflect real network conditions — the exact thing this dashboard exists
  to show.
- The target users (Stellar/Soroban developers, Wave contributors) care
  about *real* network conditions when deciding things like "should I bump
  my fee right now," which only mainnet data answers meaningfully.

Public mainnet Horizon exposes everything needed for v1 as unauthenticated
GET requests, so there's no credential or account to provision. A future
issue can add a network selector (mainnet/testnet toggle) for completeness,
but mainnet is the correct default and only mode for v1.

## Polling vs. Horizon SSE Streaming

Horizon supports Server-Sent Events (`Accept: text/event-stream`) on
several collection endpoints (e.g. `/ledgers`, `/transactions`). SSE was
considered and rejected for v1 in favor of interval polling:

- **Fan-out cost.** SSE is a per-connection stream from Horizon. If this
  dashboard is opened by many developers, an SSE architecture means either
  (a) each browser opens its own long-lived stream directly to public
  Horizon — fragile behind corporate networks/proxies and puts unbounded
  load on a shared public resource as usage grows — or (b) the backend
  maintains one SSE connection to Horizon and re-broadcasts to many
  clients, which is real complexity (reconnect/backoff handling, resuming
  from a cursor after a drop, backpressure) for zero user-facing benefit
  at this cadence.
- **The data doesn't need sub-second latency.** Stellar ledgers close
  roughly every ~5 seconds. A human looking at a dashboard gains nothing
  from learning about a new ledger 200ms sooner; a 5-10s poll interval is
  indistinguishable in practice from a push-based feed for this use case.
- **Polling is trivially cacheable and rate-limit-friendly.** A single
  backend poller hitting Horizon on a fixed interval, regardless of how
  many browser tabs are open, is simple to reason about, simple to test,
  and easy on Horizon's public rate limits (one poller, not N SSE
  connections).
- **Simplicity for Wave contributors.** A `setInterval` + fetch is far more
  approachable for a contributor picking up a "add a new metric" issue
  than an SSE reconnect state machine. This matters directly for the
  "sliceable issues" goal of this project.

Given all of that, **moving to SSE/WebSocket push is an explicit,
well-scoped Phase 2+ issue** (see backlog) rather than a v1 requirement —
it's a good example of an isolated, self-contained improvement for a
contributor to pick up without touching the rest of the system.

## Stack

**Backend: Node.js + TypeScript + Express**
- Single long-running process polls Horizon on an interval, normalizes the
  response into the dashboard's own small data shape, and keeps a rolling
  in-memory window (last ~50 ledgers / ~5 fee_stats snapshots — a few KB).
  No database in v1; there is nothing here that needs to survive a
  restart.
- Exposes a small REST API consumed by the frontend. REST (not
  GraphQL/tRPC) because the API surface is tiny and fixed-shape — no query
  flexibility is needed.
- TypeScript for shared type safety between the polling logic and the API
  response shapes.

**Frontend: React + TypeScript + Vite**
- React because it's the most broadly known UI framework across the
  Stellar/Soroban JS ecosystem (Soroban's own JS/TS SDK tooling assumes
  familiarity with this stack), which lowers the bar for Wave contributors
  picking up "add a new chart" issues.
- Vite for fast local dev (instant HMR) and a trivial static production
  build.
- Charting via a lightweight React chart library (Recharts) rather than a
  raw D3 integration — keeps "add a new chart" issues approachable without
  requiring D3 knowledge.

**No database, no auth, no persistence layer** — deliberately, per the PRD
out-of-scope list. Every server restart just re-fills the rolling window
from live Horizon data within one polling interval.

## Data Flow (End to End)

```
Public Horizon (horizon.stellar.org)
        │  GET /ledgers?order=desc&limit=N   (ledger close time, throughput, op counts)
        │  GET /fee_stats                    (base fee, fee percentiles, capacity usage)
        ▼
Backend poller (setInterval, ~6s)
        │  - fetches both endpoints
        │  - normalizes into internal types (LedgerSample, FeeSnapshot)
        │  - appends to a capped in-memory rolling window (ring buffer)
        │  - tracks last-successful-fetch timestamp for staleness detection
        ▼
Express REST API
        │  GET /api/health   → derived metrics (close time avg, throughput,
        │                      congestion %, fee percentiles, staleness flag)
        │  GET /api/ledgers/recent → raw recent ledger samples for charting
        ▼
Frontend (React, polls backend every ~5s)
        │  - fetch() on an interval (visibility-aware: pauses when tab
        │    is hidden, to avoid needless load when nobody's looking)
        │  - updates React state
        ▼
Dashboard UI
        - Stat tiles (close time, base fee, congestion %)
        - Ledger close time trend chart
        - Fee percentile chart
        - Operation count / throughput trend chart
        - Staleness banner if the backend hasn't gotten fresh Horizon data
          within N intervals
```

The backend sits between the frontend and Horizon (rather than the
frontend calling Horizon directly) so that: (1) many open dashboard tabs
share one poller instead of each hammering Horizon independently, (2)
derived-metric logic (rolling averages, congestion banding) lives in one
place instead of being duplicated/re-derived client-side, and (3) it gives
a clean seam for later issues (caching headers, WebSocket push, a real
datastore) without touching the frontend.

## Project Structure

```
netpulse-xlm/
├── backend/
│   ├── src/
│   │   ├── index.ts       Express app entry point
│   │   ├── horizon.ts     Horizon fetch functions
│   │   ├── poller.ts      interval polling + rolling window store
│   │   ├── metrics.ts     derives dashboard metrics from raw samples
│   │   └── types.ts       shared types
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
└── frontend/
    ├── src/
    │   ├── main.tsx
    │   ├── App.tsx
    │   ├── api.ts          typed fetch wrapper + polling hook
    │   ├── components/     stat tiles + charts
    │   └── styles.css
    ├── index.html
    ├── package.json
    └── tsconfig.json
```
