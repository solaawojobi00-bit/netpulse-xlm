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
