# NetPulse

A live network health dashboard for the Stellar network, built for Stellar
and Soroban developers who want a quick read on network conditions
(ledger close time, base fees, congestion, throughput) while building and
testing.

Pulls real, live data from Stellar's public mainnet Horizon API — no mocked
data.

See [PRD.md](./PRD.md) for scope and metrics, and
[ARCHITECTURE.md](./ARCHITECTURE.md) for how data is fetched and how the
dashboard stays live.

## Status

Phase 1 (live MVP dashboard) — see open issues for the Phase 2+ backlog.

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

The frontend dev server proxies API requests to the backend. Open the URL
Vite prints (default `http://localhost:5173`).
