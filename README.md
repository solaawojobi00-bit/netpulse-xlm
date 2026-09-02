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
available settings and their defaults (including `LOG_LEVEL`, defaulting to `info`).
The backend writes its history database to `DATABASE_PATH` (default `./data/netpulse.db`),
creating the directory on first run.

## Graceful Shutdown

`SIGTERM` and `SIGINT` both start the same shutdown sequence, so the backend
drains cleanly under Docker, systemd, or any container platform that signals
before killing:

1. Stop accepting new HTTP connections.
2. Close WebSocket clients with a `1001` ("going away") close frame.
3. Drop idle keep-alive sockets and wait for in-flight requests to finish.
4. Clear the Horizon poll interval and abort the SSE stream loops.
5. Close the SQLite connection **last**, once nothing can still write to it.

The database is closed last on purpose: the SSE callbacks write ledgers as
they arrive, so closing earlier risks a write against a closed handle. WAL-mode
SQLite closed uncleanly on every restart is the failure this is most meant to
avoid.

A second signal arriving mid-shutdown is ignored rather than starting cleanup
again. If cleanup exceeds `SHUTDOWN_TIMEOUT_MS` (default 8000) the process
logs the failure and exits non-zero, so a stuck connection cannot block exit
indefinitely. Keep that value below your platform's SIGTERM-to-SIGKILL grace
period (10s by default for both Docker and systemd).

## Allowed Origins

`CORS_ORIGIN` controls which origins may call the REST API **and** open the
`/ws` WebSocket. It defaults to `http://localhost:5173`, so the Vite dev
server connects with no extra configuration.

The browser same-origin policy does not apply to WebSocket handshakes, so
this check — not CORS — is what stops an arbitrary page from opening `/ws`
and consuming the snapshot stream. A handshake from an origin that is not
listed is refused at the upgrade stage with `403 Forbidden` and logged.

**When deploying the frontend to a different origin than the backend**, set
`CORS_ORIGIN` to that origin, or the browser's WebSocket connection will be
rejected:

```bash
# single origin
CORS_ORIGIN=https://netpulse.example

# several origins (apex plus www, or staging alongside production)
CORS_ORIGIN=https://netpulse.example,https://www.netpulse.example

# any origin — public read-only deployments only
CORS_ORIGIN=*
```

Requests that send **no** `Origin` header — curl, monitoring scripts,
container health checks — are allowed. A browser always sends `Origin` on a
WebSocket handshake, so the cross-site connection this guards against cannot
occur without one, while anything outside a browser can set the header to
whatever it likes. Blocking origin-less clients would therefore break
legitimate tooling without stopping an attacker.

## Health and Liveness Probes

- `GET /healthz`: Process liveness endpoint that returns `{"status": "ok"}` with HTTP 200 whenever the backend process is running and accepting HTTP requests. It performs no I/O, does not access the database, and does not depend on upstream Horizon connectivity. **Use `/healthz` for container orchestrator liveness checks.**
- `GET /api/health`: Network metrics endpoint returning current network conditions (ledger close times, fee statistics, congestion banding). Because this reflects upstream Horizon reachability and may report `status: "stale"` during external Horizon outages, it should **not** be used as a container liveness probe.
