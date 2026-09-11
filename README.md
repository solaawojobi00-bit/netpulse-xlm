# NetPulse

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![Code of Conduct](https://img.shields.io/badge/Code%20of%20Conduct-Contributor%20Covenant%202.1-5e35b1.svg)](./CODE_OF_CONDUCT.md)

A live network health dashboard for the Stellar network, built for Stellar
and Soroban developers who want a quick read on network conditions
(ledger close time, base fees, congestion, throughput) while building and
testing.

Pulls real, live data from Stellar's public Horizon API — mainnet by
default, with testnet selectable from the header. No mocked data.

See [PRD.md](./PRD.md) for scope and metrics, and
[ARCHITECTURE.md](./ARCHITECTURE.md) for how data is fetched and how the
dashboard stays live.

Building against NetPulse? [docs/API.md](./docs/API.md) is the reference for
all eight REST routes and the `/ws` WebSocket channel — response shapes, field
descriptions, which fields are nullable and why, and the behaviours that are
easy to get wrong.

## Status

Phase 2. The Phase 1 MVP shipped and has since gained live Horizon SSE
streaming with WebSocket push to the browser, mainnet/testnet selection,
persistent history with a 24h trend view and CSV/JSON export, Soroban
contract activity metrics, an operation-type breakdown, and additional fee
and transaction charts.

Also since Phase 1: congestion alerting over a webhook, graceful shutdown,
a light/dark theme, an accessibility pass across the charts and palette,
per-chart loading and error states, a long-range trends panel over daily
rollups (30d/90d/1y), and network, history range and trend range reflected
in the URL so a view is shareable.

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

## Congestion Alerting

Set `ALERT_WEBHOOK_URL` and the backend POSTs when a network's ledger capacity
usage crosses `CONGESTION_ALERT_THRESHOLD`, and again when it recovers. Leave
it unset and nothing changes — alerting is off by default and no other
behaviour depends on it.

`ALERT_WEBHOOK_FORMAT` picks the body shape: `generic` (default), `discord`,
or `slack`. Discord and Slack both reject bodies they do not recognise, so
this has to match whatever the URL points at.

Alerts are **edge-triggered**: one notification when a network crosses into
the alerting state, not one per poll while it stays there. Two independent
guards keep a busy network from flooding a channel:

- **Hysteresis** (`ALERT_HYSTERESIS`, default `0.05`) — the alert clears only
  once usage falls below `threshold - hysteresis`. A reading flickering either
  side of the threshold alerts once, not on every poll.
- **Cooldown** (`ALERT_COOLDOWN_MS`, default 15 minutes) — a floor on the time
  between alerts for one network, covering the case hysteresis cannot: a value
  swinging widely across both lines.

A recovery that closes a delivered alert is never suppressed, so an alert
channel is not left showing a problem that has already passed. State is kept
per network, so a mainnet episode neither triggers nor suppresses a testnet
one. Delivery failures are logged and swallowed — a dead webhook cannot stop
metric collection or take the dashboard down.

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

## Deploying to Render

`render.yaml` at the repository root is a Render Blueprint describing the
backend as a single web service. It sets `rootDir: backend`, builds with
`npm ci --include=dev && npm run build`, starts with `npm start`, and uses the
existing `/healthz` route as its health check.

No application code is Render-specific. The server already reads `PORT` from
the environment and binds the unspecified address, and `/ws` shares that one
port with the REST API, so the service needs no code changes to run there.

### First deploy

1. In the Render dashboard, choose **New → Blueprint** and connect this
   repository. Render reads `render.yaml` and proposes the `netpulse-backend`
   service.
2. When prompted for **`CORS_ORIGIN`**, enter the frontend's origin — for
   example `https://netpulse.vercel.app`. It accepts a comma-separated list,
   and the formats are described under [Allowed Origins](#allowed-origins).
   Getting this wrong does not break the REST API in an obvious way, but the
   browser's WebSocket handshake is refused with `403`, so the dashboard loads
   and then never receives live updates.
3. Deploy. The first build compiles TypeScript and takes a few minutes.
4. Confirm the service is up:

   ```bash
   curl https://<your-service>.onrender.com/healthz
   # {"status":"ok"}
   ```

To change `CORS_ORIGIN` later — when the frontend's domain is settled, say —
edit it under the service's **Environment** tab. Render redeploys on save.

### Instance type

The Blueprint specifies the **Starter** instance type rather than Free. Free
instances spin down after roughly 15 minutes without traffic, and this backend
is a long-running poller: spin-down halts Horizon ingestion and disconnects
every WebSocket client, so the dashboard goes stale rather than merely slow.

### Database persistence

⚠️ SQLite runs on **ephemeral storage**. The database survives restarts within
a deploy, but **each redeploy starts from an empty database**.

Recent data repopulates within a poll interval or two, so the dashboard's live
view recovers quickly. The longer `/api/trends` ranges do not: `30d`, `90d`,
and especially `1y` need history that ephemeral storage never accumulates.

Attaching a Render persistent disk would fix this — set `DATABASE_PATH` to a
path on the mounted volume, which `db.ts` will create — but a disk requires a
paid instance and forces single-instance deploys with no zero-downtime
rollout. That tradeoff is tracked as a separate decision rather than assumed
here.

## Deploying the Dashboard to Vercel

`frontend/vercel.json` configures the dashboard as a static Vite build. The
frontend and backend deploy independently: Vercel serves the built assets, and
the browser talks to the backend directly over both REST and WebSocket.

### Pointing the build at a backend

`frontend/` reads two optional build-time variables, documented in
`frontend/.env.example`:

| Variable | Meaning |
|---|---|
| `VITE_API_URL` | Absolute backend origin, e.g. `https://netpulse-backend-6myk.onrender.com`. Unset means same origin. |
| `VITE_WS_URL` | Optional override for the WebSocket origin. Derived from `VITE_API_URL` by protocol swap when unset, which is correct for every normal deploy. |

⚠️ These are **build-time** values, not runtime ones — Vite substitutes them
into the bundle when it compiles. Editing one in the Vercel dashboard does
nothing until the project is **redeployed**.

Leaving `VITE_API_URL` unset is not an error: the app falls back to same-origin
requests, exactly as it behaves behind the dev proxy. On Vercel that means the
dashboard loads and then fails every request, because nothing serves `/api`
there. The symptom is a dashboard stuck on empty charts with 404s in the
console.

### First deploy

1. In the Vercel dashboard, **Add New → Project** and import this repository.
2. Set **Root Directory** to `frontend`. This is the counterpart to
   `rootDir: backend` in `render.yaml` — there is no root `package.json`, so
   Vercel must be pointed at the package. Vercel then reads
   `frontend/vercel.json`, and the framework preset, build command and output
   directory all come from it.
3. Set **Node.js Version** to 22.x or 24.x, matching the `engines` range in
   `frontend/package.json`.
4. Under **Environment Variables**, add `VITE_API_URL` with the backend's
   origin. Apply it to Production, Preview, and Development so preview deploys
   are not silently same-origin.
5. Deploy, then confirm the deployment — see below.

### Allowing the Vercel origin

The backend rejects WebSocket upgrades from origins it does not recognise, so
its `CORS_ORIGIN` must cover wherever Vercel serves this from. Vercel gives
every preview deploy its own hostname
(`<project>-git-<branch>-<scope>.vercel.app`), and `CORS_ORIGIN` is an
exact-match allowlist with no pattern support — so a fixed list covers
production but silently breaks previews.

`CORS_ORIGIN=*` is the practical setting for this project: the API is a
public, read-only, unauthenticated feed of data that is already public on the
Stellar network, so there is nothing an allowlist protects. See
[Allowed Origins](#allowed-origins) for the formats.

### Confirming the deployment

Charts filling with data is **not** sufficient evidence that the WebSocket
works: `useSubscription` falls back to polling `/api/*` every 5 seconds when the
socket is refused, and the dashboard looks identical either way. There is no
on-screen streaming indicator — the hook tracks `isStreaming` internally but
nothing renders it — so the check has to happen in DevTools.

Open the deployed dashboard, then in **DevTools → Network**:

- Filter to **WS**. There should be one `/ws` request against the *backend's*
  host showing `101 Switching Protocols`, with snapshot frames arriving every
  few seconds under its Messages tab.
- The `/api/*` calls should go to the backend's host, not the Vercel one.

Two failure modes look similar and are worth telling apart:

| Symptom | Cause |
|---|---|
| `/api/*` requests go to the Vercel host and 404 | `VITE_API_URL` was unset at build time, or was set after the last deploy and needs a rebuild |
| `/api/*` succeeds but `/ws` is refused with `403`, and `/api/*` repeats every 5s | `CORS_ORIGIN` on the backend does not cover this Vercel origin; the handshake rejection is also logged backend-side |

## History Export

`GET /api/history` serves aggregated 5-minute buckets, and accepts an optional
`format` for downloading the same data:

| Request | Response |
|---|---|
| `/api/history` | `application/json`, rendered inline (what the dashboard fetches) |
| `/api/history?format=csv` | `text/csv` as a file download |
| `/api/history?format=json` | the same JSON body, as a file download |

`format` is a representation of the existing resource rather than a separate
endpoint, so `network` and `range` apply unchanged:

```bash
curl -OJ "http://localhost:4000/api/history?network=testnet&range=6h&format=csv"
```

Downloads are named `netpulse-history-<network>-<range>.csv` (or `.json`).
Omitting `format`, or passing one that is not recognised, returns the original
inline JSON with no `Content-Disposition`.

CSV has one row per bucket. `network` and `range` are repeated on every row so
an exported file makes sense without the request that produced it, and empty
fields mean no usable value for that bucket:

```
network,range,timestamp,closeTimeSeconds,congestionUsage,operations,transactions,p50Fee,p90Fee
mainnet,24h,2026-09-02T22:10:00.000Z,5.58,0.6683,11371,6702,100,17734
```

See [docs/API.md](./docs/API.md#export-formats) for the exact headers, RFC 4180
quoting and CRLF details, and why a cross-origin browser client cannot read the
download filename. Note that an empty field means "no data **or** a zero
aggregate" — the two are not distinguishable, which
[docs/API.md](./docs/API.md#reading-the-points-array-correctly) explains along
with the other bucket behaviours (gaps are omitted rather than zero-filled, and
the oldest bucket is usually partial).

## Trends Export

`GET /api/trends` serves daily-grain history and accepts the same `format`
parameter, following the same pattern:

| Request | Response |
|---|---|
| `/api/trends` | `application/json`, rendered inline (what the dashboard fetches) |
| `/api/trends?format=csv` | `text/csv` as a file download |
| `/api/trends?format=json` | the same JSON body, as a file download |

`network` and `range` apply unchanged, and ranges here are `30d`, `90d` and
`1y` rather than the hourly ones history accepts:

```bash
curl -OJ "http://localhost:4000/api/trends?network=testnet&range=1y&format=csv"
```

Downloads are named `netpulse-trends-<network>-<range>.csv` (or `.json`), so a
trends export never collides with a history export in the same folder.

CSV has one row per **day**, with `network` and `range` repeated on every row:

```
network,range,date,closeTimeSeconds,congestionUsage,maxCongestionUsage,operations,successfulTransactions,failedTransactions,p50Fee,p90Fee
mainnet,90d,2026-09-04,5.62,0.4213,0.9871,3427194,1044821,20713,137,9042
mainnet,90d,2026-09-05,,,,12,3,0,,
```

Two differences from the history export worth knowing before you load one into
a spreadsheet:

- **Successful and failed transactions are separate columns**, where history has
  a single `transactions` column holding their sum. Add the two to compare.
- **An empty field means no data, not a zero.** Unlike history, a genuine zero
  is written as `0`. The second row above is a day with ledgers but no fee
  snapshots.

Days the backend was not running are **absent** rather than zero-filled, so
consecutive rows are not necessarily consecutive dates. See
[docs/API.md](./docs/API.md#get-apitrends) for the full field reference and
retention behaviour.

## Health and Liveness Probes

- `GET /healthz`: Process liveness endpoint that returns `{"status": "ok"}` with HTTP 200 whenever the backend process is running and accepting HTTP requests. It performs no I/O, does not access the database, and does not depend on upstream Horizon connectivity. **Use `/healthz` for container orchestrator liveness checks.**
- `GET /api/health`: Network metrics endpoint returning current network conditions (ledger close times, fee statistics, congestion banding). Because this reflects upstream Horizon reachability and may report `status: "stale"` during external Horizon outages, it should **not** be used as a container liveness probe.

A stale response is still **HTTP 200**, so staleness cannot be detected from
the status code — see
[docs/API.md](./docs/API.md#what-makes-a-response-stale) for what exactly makes
a response stale, how it relates to `secondsSinceLastUpdate`, and the full
field-by-field reference.

## Diagnostics

### Checking for missing ledger data

`backend/scripts/rollup-gap-check.mjs` reports how much ledger data is absent
from a database and how much of that loss is already permanent.

```bash
# a local database (defaults to $DATABASE_PATH, else ./data/netpulse.db)
node backend/scripts/rollup-gap-check.mjs

# an explicit path, e.g. on a deployment host
node backend/scripts/rollup-gap-check.mjs /var/lib/netpulse/netpulse.db

# machine-readable
node backend/scripts/rollup-gap-check.mjs --json
```

It reports two things: gaps in the `ledgers` sequence per network, with the size
of each gap, and any `daily_rollups` rows whose raw rows have already been
pruned. The second set is the one that matters — daily totals are sums, so a
missing ledger is an undercount, and once the raw rows behind a day are deleted
at the retention boundary that undercount can no longer be recomputed.

Gap **size** is the diagnosis. One or two missing ledgers is the warm-up to
stream cursor handoff; runs longer than the 20-ledger warm-up window are
downtime that nothing backfilled.

**Safe to run against a live production database.** The connection is opened
read-only, so it cannot write to the file or block the backend. The database
runs in WAL mode, which gives readers a consistent snapshot without blocking the
writer, so no downtime or maintenance window is needed. And `rollupAndPrune()`
does its rollup and delete in a single transaction, so a read landing mid-prune
sees either the whole before state or the whole after state, never a half-pruned
day.

If you would rather analyse a copy, copy `netpulse.db`, `netpulse.db-wal` **and**
`netpulse.db-shm` together. Copying only the first gives a snapshot missing every
commit still in the WAL, which reads as data loss that is not real.

Finding gaps is not an error: the script exits 0 whatever it reports, and
non-zero only if the database cannot be read. A database with no `daily_rollups`
table predates that feature, which the script reports plainly — no rollups means
nothing has frozen yet.

## License

MIT — see [LICENSE](./LICENSE).
