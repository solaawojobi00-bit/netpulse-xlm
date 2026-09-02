# NetPulse

A live network health dashboard for the Stellar network, built for Stellar
and Soroban developers who want a quick read on network conditions
(ledger close time, base fees, congestion, throughput) while building and
testing.

Pulls real, live data from Stellar's public Horizon API — mainnet by
default, with testnet selectable from the header. No mocked data.

See [PRD.md](./PRD.md) for scope and metrics, and
[ARCHITECTURE.md](./ARCHITECTURE.md) for how data is fetched and how the
dashboard stays live.

## Status

Phase 2. The Phase 1 MVP shipped and has since gained live Horizon SSE
streaming with WebSocket push to the browser, mainnet/testnet selection,
persistent history with a 24h trend view, Soroban contract activity
metrics, and additional fee and transaction charts.

See the open issues for the current backlog. See [CONTRIBUTING.md](./CONTRIBUTING.md)
for local setup, branch conventions, running checks, and how to claim an issue.

## Running locally

```bash
# backend
cd backend
cp .env.example .env
npm install
npm run dev

# frontend (separate terminal)
cd frontend
npm install
npm run dev
```

The frontend dev server proxies both `/api` requests and the `/ws`
WebSocket to the backend on port 4000. Open the URL Vite prints (default
`http://localhost:5173`).

Configuration lives in `backend/.env` — see `backend/.env.example` for the
available settings and their defaults. The backend writes its history
database to `DATABASE_PATH` (default `./data/netpulse.db`), creating the
directory on first run.
