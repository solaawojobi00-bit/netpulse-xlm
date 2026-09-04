# NetPulse API Reference

The NetPulse backend exposes seven HTTP routes and one WebSocket channel. It is
a read-only view over Stellar network telemetry that the backend collects from
Horizon, aggregates in memory, and persists to SQLite.

Everything below was verified against a running server rather than read off the
type definitions. Where the implementation does something surprising, this
document says so instead of describing what it ought to do.

- [Conventions](#conventions)
- [Errors](#errors)
- [`GET /healthz`](#get-healthz)
- [`GET /api/health`](#get-apihealth)
- [`GET /api/ledgers/recent`](#get-apiledgersrecent)
- [`GET /api/fees/recent`](#get-apifeesrecent)
- [`GET /api/history`](#get-apihistory)
- [`GET /api/soroban`](#get-apisoroban)
- [`GET /api/operations/breakdown`](#get-apioperationsbreakdown)
- [`/ws` WebSocket channel](#ws-websocket-channel)
- [Nullability reference](#nullability-reference)
- [Known data-quality issues](#known-data-quality-issues)

## Conventions

**Base URL.** `http://localhost:4000` by default; the port comes from `PORT`.
There is no path prefix or version segment.

**No authentication.** No route requires a credential, and none accepts one.

**Method.** Every route is `GET`. `HEAD` also works — Express answers it for
any `GET` route, returning the same status and headers with no body. Every
other method (`POST`, `PUT`, `PATCH`, `DELETE`) falls through to the 404
handler described under [Errors](#errors), including on a path that exists:
`POST /api/health` is a `404`, not a `405`.

**Content type.** Every route returns `application/json; charset=utf-8`, except
`GET /api/history?format=csv` and error pages.

**CORS.** Governed by `CORS_ORIGIN` (comma-separated, default
`http://localhost:5173`; `*` disables checking). The same allowlist governs the
WebSocket upgrade. No response headers are added to the CORS exposed-headers
list, which matters for [history exports](#get-apihistory).

### The `network` query parameter

Six of the seven routes accept `?network=`. Parsing is a strict equality check:

```ts
req.query.network === "testnet" ? "testnet" : "mainnet"
```

Only the exact lowercase string `testnet` selects testnet. **Everything else
silently becomes mainnet** — there is no validation error and no 400, ever:

| Request | Resolved network |
| --- | --- |
| `?network=testnet` | `testnet` |
| `?network=mainnet` | `mainnet` |
| *omitted* | `mainnet` |
| `?network=TESTNET` | `mainnet` (case-sensitive) |
| `?network=pubnet` | `mainnet` (not an accepted alias) |
| `?network=testnet&network=testnet` | `mainnet` (repeated key parses to an array, which is not `"testnet"`) |

That last row is the one that catches people: a client that appends the
parameter twice gets mainnet data with no indication anything was wrong. Routes
that echo a `network` field in their body are the reliable way to confirm which
network you actually got.

The two networks have entirely separate in-memory stores and separate rows in
SQLite. Data never crosses between them.

## Errors

**There is no JSON error envelope.** No route deliberately returns a non-2xx
status: every handler reads from an in-memory store or SQLite and returns 200,
including when there is no data and when the upstream Horizon connection is
completely down. A client will therefore see errors only from Express itself:

| Situation | Status | Body |
| --- | --- | --- |
| Unknown path | `404` | **HTML** (`<pre>Cannot GET /api/nope</pre>`) |
| Known path, unsupported method | `404` (not `405`) | **HTML** (`<pre>Cannot POST /api/health</pre>`) |
| Unhandled exception in a handler | `500` | **HTML**, including a stack trace unless `NODE_ENV=production` |

Both carry `Content-Type: text/html; charset=utf-8`. **Code that calls
`JSON.parse` on a response without checking the status or content type will
throw on these.** Check `response.ok` first.

Note especially that upstream failure is *not* an error here. If Horizon is
unreachable, `GET /api/health` still returns **HTTP 200** with
`"status": "stale"`, and the collection routes still return 200 with empty
arrays. The internal last-error message is never exposed on any route, so a
total Horizon outage is indistinguishable from a backend that has merely just
started. See [`GET /api/health`](#get-apihealth).

## `GET /healthz`

Process liveness. Returns unconditionally, touches no store, reads no database,
and never contacts Horizon.

**Query parameters:** none (`network` is ignored).

**Response** — always exactly this, always 200:

```json
{ "status": "ok" }
```

**Use this for container liveness and orchestrator probes.** It is unrelated to
`/api/health` despite the similar name: this one answers "is the process
alive", that one answers "is the network data current". A liveness probe
pointed at `/api/health` would still pass during a Horizon outage — that route
also returns 200 — but it would be reporting on something you did not mean to
check.

## `GET /api/health`

Current network conditions, plus the freshness of the data behind them. This is
the dashboard's primary polling endpoint and the richest single response.

**Query parameters:** `network`.

**Always HTTP 200.**

### Response

```json
{
  "status": "ok",
  "lastUpdated": "2026-09-04T11:20:17.501Z",
  "secondsSinceLastUpdate": 0.067,
  "horizonUrl": "https://horizon.stellar.org",
  "ledgerCloseTime": { "currentSeconds": 6, "averageSeconds": 5.8 },
  "fees": { "baseFeeStroops": 100, "p10": 100, "p50": 9486, "p90": 9486, "p99": 13936 },
  "congestion": { "ledgerCapacityUsage": 0.82, "band": "high", "alertThreshold": 0.8 },
  "throughput": {
    "operationsPerSecond": 114.43518518518519,
    "transactionsPerSecond": 51.9537037037037
  },
  "recentLedgerCount": 50
}
```

| Field | Type | Description |
| --- | --- | --- |
| `status` | `"ok" \| "stale"` | Whether a successful upstream update landed recently enough. See below. |
| `lastUpdated` | `string \| null` | ISO 8601 timestamp of the last successful upstream update. `null` if none has ever succeeded. |
| `secondsSinceLastUpdate` | `number \| null` | Fractional seconds since `lastUpdated`. `null` under the same condition. |
| `horizonUrl` | `string` | The Horizon base URL this network is configured to poll. Echoes `HORIZON_URL` / `HORIZON_TESTNET_URL` verbatim, so it will show a misconfigured value too. Typed optional, but always present in practice. |
| `ledgerCloseTime.currentSeconds` | `number \| null` | Close time of the newest ledger in the window. |
| `ledgerCloseTime.averageSeconds` | `number \| null` | Mean close time across the window. **Currently unreliable — see [Known data-quality issues](#known-data-quality-issues).** |
| `fees.baseFeeStroops` | `number \| null` | Base fee of the last ledger, in stroops, from the newest fee snapshot. |
| `fees.p10` `p50` `p90` `p99` | `number \| null` | Fee-charged percentiles, in stroops, from the newest fee snapshot. |
| `congestion.ledgerCapacityUsage` | `number \| null` | Ledger capacity usage, 0-1, from the newest fee snapshot. |
| `congestion.band` | `"low" \| "moderate" \| "high" \| "unknown"` | Banding of the above. See below. |
| `congestion.alertThreshold` | `number` | The usage fraction at which `band` becomes `high`. From `CONGESTION_ALERT_THRESHOLD`, default `0.8`. Typed optional, always present in practice. |
| `throughput.operationsPerSecond` | `number \| null` | Operations per second over the last 20 ledgers. |
| `throughput.transactionsPerSecond` | `number \| null` | Transactions per second over the last 20 ledgers. **Counts successful transactions only** — see the note below. |
| `recentLedgerCount` | `number` | Ledgers currently in the in-memory window, 0-50. Never null. |

### What makes a response `stale`

The threshold is `3 * POLL_INTERVAL_MS`, so **18 seconds** with the default 6s
poll interval. It is read once when the module loads, so changing
`POLL_INTERVAL_MS` requires a restart.

`status` is `"stale"` when either:

- no successful update has *ever* landed (`lastUpdated` is `null`), or
- more than the threshold has elapsed since the last one — strictly greater,
  so exactly 18.0s is still `"ok"`.

The relationship to `secondsSinceLastUpdate` is exact:

```
status === "stale"  ⟺  secondsSinceLastUpdate === null || secondsSinceLastUpdate > 18
```

**Staleness is not detectable from the HTTP status code.** A stale response is
HTTP 200, the same as a fresh one. Poll this field; do not rely on transport
errors to tell you the data has stopped moving.

`"stale"` covers both "just started, nothing fetched yet" and "Horizon has been
down for an hour". Nothing in the response distinguishes them, because the
internal error message is never serialised.

With Horizon unreachable, the whole response degrades to nulls rather than
failing:

```json
{
  "status": "stale",
  "lastUpdated": null,
  "secondsSinceLastUpdate": null,
  "horizonUrl": "https://horizon.stellar.org",
  "ledgerCloseTime": { "currentSeconds": null, "averageSeconds": null },
  "fees": { "baseFeeStroops": null, "p10": null, "p50": null, "p90": null, "p99": null },
  "congestion": { "ledgerCapacityUsage": null, "band": "unknown", "alertThreshold": 0.8 },
  "throughput": { "operationsPerSecond": null, "transactionsPerSecond": null },
  "recentLedgerCount": 0
}
```

### Congestion bands

Given `usage` = `ledgerCapacityUsage` and `t` = `alertThreshold`:

| Condition | `band` |
| --- | --- |
| `usage === null` | `"unknown"` |
| `usage < 0.5` | `"low"` |
| `0.5 <= usage < t` | `"moderate"` |
| `usage >= t` | `"high"` |

The `0.5` boundary is fixed; only the high threshold is configurable. Because
`band` is derived, do not treat `"unknown"` as an error state — it means only
that no fee snapshot has been collected yet.

### Throughput counts transactions differently from history

`throughput.transactionsPerSecond` sums `successfulTransactionCount` only.
`GET /api/history`'s `transactions` field sums **successful + failed**. The two
are genuinely inconsistent, and on a busy network the gap is large — the sample
above shows 171 successful against 88 failed in a single ledger. Do not compare
the two figures or expect one to be a rescaling of the other.

Both are computed over the last 20 ledgers, using the span between the oldest
and newest `closedAt` in that slice as the denominator. Both are `null` when
the window holds fewer than two ledgers, or when the span is zero.

## `GET /api/ledgers/recent`

The in-memory rolling window of recent ledgers, oldest first.

**Query parameters:** `network`.

**Response** — note the `ledgers` wrapper:

```json
{
  "ledgers": [
    {
      "sequence": 64268945,
      "closedAt": "2026-09-04T11:19:02Z",
      "closeTimeSeconds": 6,
      "successfulTransactionCount": 171,
      "failedTransactionCount": 88,
      "operationCount": 455,
      "txSetOperationCount": 669,
      "baseFeeInStroops": 100,
      "maxTxSetSize": 1000
    }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `sequence` | `number` | Stellar ledger sequence number. Ascending across the array. |
| `closedAt` | `string` | Horizon's `closed_at`, ISO 8601. Second precision, no milliseconds. |
| `closeTimeSeconds` | `number \| null` | Seconds between this ledger and the preceding one. `null` for the oldest ledger in the window, which has no predecessor to measure against. **May currently be negative — see [Known data-quality issues](#known-data-quality-issues).** |
| `successfulTransactionCount` | `number` | Transactions that succeeded. |
| `failedTransactionCount` | `number` | Transactions included but failed. |
| `operationCount` | `number` | Operations in successful transactions. |
| `txSetOperationCount` | `number` | Operations across the whole proposed transaction set, so normally larger than `operationCount`. |
| `baseFeeInStroops` | `number` | Base fee for this ledger. |
| `maxTxSetSize` | `number` | Ledger capacity in operations, the denominator behind capacity usage. |

**Capped at 50 ledgers**, kept in memory only. This route never reads SQLite,
so a restart empties it — use `GET /api/history` for anything longer-range.
Returns `{"ledgers": []}` before the first successful fetch.

Entries are de-duplicated by `sequence`, so the array is strictly ascending.

## `GET /api/fees/recent`

The rolling window of fee statistics snapshots, oldest first.

**Query parameters:** `network`.

**Response** — note this wrapper is `snapshots`, not `fees`, and not
`snapshot`:

```json
{
  "snapshots": [
    {
      "fetchedAt": "2026-09-04T12:05:02.764Z",
      "lastLedgerBaseFee": 100,
      "ledgerCapacityUsage": 0.85,
      "feeChargedP10": 100,
      "feeChargedP50": 100,
      "feeChargedP90": 9486,
      "feeChargedP99": 82982
    }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `fetchedAt` | `string` | When NetPulse fetched this snapshot, ISO 8601 with milliseconds. This is a local collection timestamp, not a Horizon field. |
| `lastLedgerBaseFee` | `number` | Base fee of the most recent ledger, in stroops. |
| `ledgerCapacityUsage` | `number` | Capacity usage, 0-1. |
| `feeChargedP10` `P50` `P90` `P99` | `number` | Fee-charged percentiles, in stroops. |

No field here is nullable — a snapshot exists only if the fetch and schema
validation both succeeded. The array itself may be empty.

**Capped at 10 snapshots**, in memory only. At the default 6s interval that is
roughly the last minute. Percentiles are wide in practice: the example above has
a p50 of 100 and a p99 of 82,982.

### Response wrapping is inconsistent across routes

Worth stating plainly, because it is easy to get wrong:

| Route | Top-level shape |
| --- | --- |
| `GET /api/ledgers/recent` | `{ "ledgers": [...] }` |
| `GET /api/fees/recent` | `{ "snapshots": [...] }` |
| `GET /api/history` | `{ "network", "range", "points": [...] }` |
| `GET /api/health` | bare object |
| `GET /api/soroban` | bare object |
| `GET /api/operations/breakdown` | bare object |
| `/ws` snapshot frame | the same fee array appears as **`fees`** |

The fee array is called `snapshots` over REST and `fees` over the WebSocket.
Same data, different key.

## `GET /api/history`

Time-bucketed history from SQLite. This is the only route backed by persistent
storage, and the only one whose data survives a restart.

**Query parameters:** `network`, `range`, `format`.

### The `range` parameter

Only `6h` and `12h` are recognised. **Every other value, including the string
`24h` itself, falls through to 24 hours:**

```ts
req.query.range === "12h" ? 12 : req.query.range === "6h" ? 6 : 24
```

| Request | Window | Echoed `range` |
| --- | --- | --- |
| `?range=6h` | 6 hours | `"6h"` |
| `?range=12h` | 12 hours | `"12h"` |
| `?range=24h` | 24 hours | `"24h"` |
| *omitted* | 24 hours | `"24h"` |
| `?range=7d` | 24 hours | `"24h"` |
| `?range=GARBAGE` | 24 hours | `"24h"` |

The response echoes the **normalised** range, so `?range=7d` comes back as
`"range": "24h"`. An out-of-range request is therefore silently downgraded
rather than rejected, and the echoed field is how you detect it. 24 hours is
the maximum queryable window regardless of what is stored.

### Response

```json
{
  "network": "mainnet",
  "range": "24h",
  "points": [
    {
      "timestamp": "2026-09-04T12:00:00.000Z",
      "closeTimeSeconds": null,
      "congestionUsage": 0.9516,
      "operations": 0,
      "transactions": 0,
      "p50Fee": 141,
      "p90Fee": 11013
    }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `network` | `string` | The resolved network. |
| `range` | `string` | The normalised range, one of `"6h"`, `"12h"`, `"24h"`. |
| `points[].timestamp` | `string` | Start of the 5-minute bucket, ISO 8601, aligned to a 5-minute boundary. |
| `points[].closeTimeSeconds` | `number \| null` | Mean ledger close time in the bucket, 2 decimal places. |
| `points[].congestionUsage` | `number \| null` | Mean capacity usage in the bucket, 4 decimal places. |
| `points[].operations` | `number` | Total operations in the bucket. `0` when no ledger rows fell in it. |
| `points[].transactions` | `number` | Total **successful + failed** transactions. `0` when no ledger rows fell in it. |
| `points[].p50Fee` | `number \| null` | Mean p50 fee in the bucket, rounded to an integer. |
| `points[].p90Fee` | `number \| null` | Mean p90 fee, rounded to an integer. |

### Reading the points array correctly

Four behaviours will produce wrong charts if you assume otherwise.

**1. `null` means "no data *or* a zero aggregate".** The nullable fields are
assigned with a truthiness check, not a null check:

```ts
closeTimeSeconds: l?.avg_close_time ? Number(l.avg_close_time.toFixed(2)) : null
```

An aggregate that computes to exactly `0` is therefore emitted as `null`,
indistinguishable from a bucket with no rows. Treat `null` as "no usable
value", not strictly as "no data". This affects `closeTimeSeconds`,
`congestionUsage`, `p50Fee` and `p90Fee`. Tracked as a known issue below.

**2. Gaps are omitted, not zero-filled.** A point exists only for buckets that
have at least one ledger row or one fee row. Consecutive points are **not**
guaranteed to be 5 minutes apart — if the backend was down for an hour, the
array simply jumps. Plot against the real `timestamp` values and treat a jump
larger than 5 minutes as downtime rather than as a flat line.

**3. Ledger and fee data are bucketed independently, then unioned.** A bucket
can hold fee data but no ledger data, or vice versa. In that case the missing
side's *nullable* fields are `null` while its *counter* fields default to `0`.
The example point above is exactly this case: real fee percentiles alongside
`operations: 0` and `transactions: 0`, which does not mean the network
processed nothing. Check `closeTimeSeconds !== null` to distinguish a genuinely
idle bucket from a fee-only one.

**4. The oldest bucket is usually partial.** The window starts at
`Date.now() - range`, which is not snapped to a bucket boundary, but the
bucket's `timestamp` is the full boundary. The first point therefore covers
less wall-clock time than the others and its totals are correspondingly lower.
Drop it before computing rates.

### Retention

Rows older than **7 days** are deleted, but pruning runs **once, at process
start**, not on a schedule. A long-lived process accumulates rows past the
retention window until its next restart.

This is storage retention, not queryable range: the read API caps at 24 hours,
so the older days are not reachable through the API in any case.

History only goes back as far as this backend has actually been running. There
is no backfill from Horizon.

### Export formats

`format` turns the same resource into a download. `network` and `range` apply
unchanged.

| Request | Status | `Content-Type` | `Content-Disposition` |
| --- | --- | --- | --- |
| `?format=csv` | 200 | `text/csv; charset=utf-8` | `attachment; filename="netpulse-history-<network>-<range>.csv"` |
| `?format=json` | 200 | `application/json; charset=utf-8` | `attachment; filename="netpulse-history-<network>-<range>.json"` |
| *omitted* | 200 | `application/json; charset=utf-8` | *absent* |
| any other value | 200 | `application/json; charset=utf-8` | *absent* |

An unrecognised `format` is **not** an error; it returns the ordinary inline
JSON. `format=json` returns a body byte-identical to the inline response and
differs only by the header.

```bash
curl -OJ "http://localhost:4000/api/history?network=testnet&range=6h&format=csv"
```

**CSV details.** One row per bucket, with a header row. `network` and `range`
are denormalised onto every row so a saved file stands alone. Rows are
terminated with CRLF **including the final row**, per RFC 4180. Nulls are
written as empty fields, not the text `null`:

```
network,range,timestamp,closeTimeSeconds,congestionUsage,operations,transactions,p50Fee,p90Fee
mainnet,24h,2026-09-04T11:15:00.000Z,5.68,0.803,12359,6322,8558,9260
mainnet,24h,2026-09-04T11:20:00.000Z,,0.7984,0,0,4577,10728
```

The second row shows an empty `closeTimeSeconds` — a fee-only bucket.

**Cross-origin browser clients cannot read the filename.**
`Content-Disposition` is not in the CORS exposed-headers list, so
`fetch()` from another origin cannot see it. Either construct the filename
yourself — the pattern is `netpulse-history-<network>-<range>.<ext>` and both
parts are in the JSON body — or trigger the download by navigation rather than
by `fetch`.

## `GET /api/soroban`

Soroban contract invocation activity, derived by filtering recent operations
for `invoke_host_function`.

**Query parameters:** `network`.

```json
{
  "network": "mainnet",
  "invocationsPerSecond": 17.66,
  "recentInvocationsTotal": 1254,
  "successfulInvocationsTotal": 1254,
  "failedInvocationsTotal": 0,
  "samples": [
    {
      "timestamp": "2026-09-04T11:20:16.837Z",
      "invocationsCount": 100,
      "successfulCount": 100,
      "failedCount": 0
    }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `network` | `string` | The resolved network. |
| `invocationsPerSecond` | `number \| null` | Rate across the sample window, 2 decimal places. `null` with no samples; exactly `0` with a single sample; otherwise total divided by the span between the first and last sample timestamp. |
| `recentInvocationsTotal` | `number` | Sum of `invocationsCount` across samples. |
| `successfulInvocationsTotal` | `number` | Sum of `successfulCount`. |
| `failedInvocationsTotal` | `number` | Sum of `failedCount`. |
| `samples[].timestamp` | `string` | When the poll ran, ISO 8601 with milliseconds. |
| `samples[].invocationsCount` | `number` | Invocations seen in that poll. |
| `samples[].successfulCount` | `number` | Of those, in transactions that succeeded. |
| `samples[].failedCount` | `number` | `invocationsCount - successfulCount`. |

**These are sample totals, not network totals.** Each poll reads the 100 most
recent operations, and at most 20 samples are kept. `recentInvocationsTotal` is
therefore "invocations observed in up to 20 recent samples of 100 operations
each", capped at 2000 by construction. It is not a count of all invocations on
the network, and overlapping or skipped operations between polls are neither
detected nor de-duplicated. Treat the figures as a rolling sample.

Note in the example that `invocationsCount` is 100 for every full poll — the
entire 100-operation page was `invoke_host_function`. When Soroban traffic
saturates the page like this, the sample tells you the page was full, not how
much activity actually occurred.

## `GET /api/operations/breakdown`

The mix of operation types across the same polls that feed `/api/soroban`.

**Query parameters:** `network`.

```json
{
  "network": "mainnet",
  "sampleCount": 13,
  "windowSeconds": 71,
  "totalOperations": 1300,
  "distinctTypes": 4,
  "breakdown": [
    { "type": "invoke_host_function", "count": 1254, "share": 0.9646, "isOther": false },
    { "type": "manage_sell_offer",    "count": 22,   "share": 0.0169, "isOther": false },
    { "type": "manage_buy_offer",     "count": 15,   "share": 0.0115, "isOther": false },
    { "type": "payment",              "count": 9,    "share": 0.0069, "isOther": false }
  ]
}
```

| Field | Type | Description |
| --- | --- | --- |
| `network` | `string` | The resolved network. |
| `sampleCount` | `number` | Polls covered, 0-20. |
| `windowSeconds` | `number \| null` | Whole seconds between the first and last sample. `null` with fewer than two samples, when there is no span. |
| `totalOperations` | `number` | Operations across all samples, including any folded into `other`. |
| `distinctTypes` | `number` | Distinct type keys seen *before* the long tail was grouped, so it can exceed `breakdown.length`. |
| `breakdown[].type` | `string` | Horizon's raw type string, or the grouping bucket. |
| `breakdown[].count` | `number` | Operations of this type. |
| `breakdown[].share` | `number` | Fraction of `totalOperations`, 0-1, 4 decimal places. `0` when `totalOperations` is 0. |
| `breakdown[].isOther` | `boolean` | `true` for the single grouped-tail row. |

**Read `isOther`, never `type === "other"`.** The bucket is named `other`, but
so could a future Horizon operation type be. `isOther` cannot collide.

At most **6 named types** are returned, with the remainder grouped into one
`other` row placed last. The `other` row is omitted entirely when its count
would be zero, so `breakdown` may contain no `isOther` row at all — as in the
example, which had only 4 distinct types.

Sorted by `count` descending, ties broken by type name; the `other` row is
always last regardless of its count.

`share` values are rounded independently and **will not always sum to exactly
1**. Do not use them to compute a remainder; use `count` against
`totalOperations`.

Like `/api/soroban`, this is a rolling sample of recent polls rather than a
network-wide total. `sampleCount` and `windowSeconds` are provided so a UI can
say so.

## `/ws` WebSocket channel

`ws://localhost:4000/ws`. Pushes a full snapshot whenever the server's store
updates, so a client can render live without polling.

### Handshake

`/ws` is the only upgradable path, and the origin allowlist is shared with
CORS (`CORS_ORIGIN`).

| Upgrade request | Result |
| --- | --- |
| `/ws`, no `Origin` header | **101**, accepted |
| `/ws`, `Origin` on the allowlist | **101**, accepted |
| `/ws`, `Origin` not on the allowlist | **403**, socket destroyed |
| any other path | **404**, socket destroyed |

A missing `Origin` is deliberately allowed: browsers always send one on a
WebSocket handshake, so the cross-site attack this guards against cannot happen
without it, while non-browser clients (curl, monitoring scripts, health checks)
send none and would otherwise be blocked for no security gain. Refusals happen
at the upgrade stage and return a real HTTP status rather than accepting the
socket and closing it afterwards.

### The `snapshot` frame

Immediately on connect — **before the client sends anything** — the server
pushes a snapshot for **mainnet**:

```jsonc
{
  "type": "snapshot",
  "network": "mainnet",
  "health": { /* exactly the GET /api/health body */ },
  "ledgers": [ /* exactly the GET /api/ledgers/recent `ledgers` array */ ],
  "fees": [ /* the GET /api/fees/recent `snapshots` array, renamed */ ],
  "soroban": { /* exactly the GET /api/soroban body */ },
  "operationBreakdown": { /* exactly the GET /api/operations/breakdown body */ }
}
```

`type` is always `"snapshot"`; it is the only frame type the server sends.
A client wanting testnet must still send a message — and will receive at least
one mainnet frame first, which it should discard by checking `network`.

The nested objects are byte-identical to their REST equivalents, **except that
the fee array is keyed `fees` here and `snapshots` over REST.**

### Client messages

Two message types are accepted, and they are exact synonyms:

```json
{ "type": "subscribe",  "network": "testnet" }
{ "type": "setNetwork", "network": "testnet" }
```

Either sets the socket's network and immediately pushes a snapshot for it.
`network` uses the same strict equality as the REST parameter, so
`"TESTNET"` selects **mainnet**.

**One network per socket.** Setting a network replaces the previous one; there
is no multi-subscribe. Open two sockets to watch both.

**Malformed and unknown messages are silently ignored** — no error frame, no
close, no log visible to the client. Invalid JSON is swallowed, and a message
with an unrecognised `type` is a no-op. The socket stays open. There is no
acknowledgement of any kind, so a client cannot distinguish "my subscribe was
applied" from "my subscribe was dropped" except by inspecting the `network`
field of subsequent frames.

### Push cadence, and why you must debounce

A snapshot is pushed to every subscribed client on **every store update**.
There are three independent triggers:

- each fee-stats poll (default every 6s, per network)
- each operations poll (default every 6s, per network)
- **each ledger received on the Horizon SSE stream**

The third has no fixed rate. Under normal conditions ledgers arrive every ~5-6
seconds, giving a handful of frames per 6-second window rather than one. But
the stream can also deliver ledgers in rapid succession — while catching up
after a reconnect, for instance — and each one produces another full snapshot.
In a live measurement the channel emitted **21 frames on connect and over 200
frames in 9 seconds** while the stream was catching up.

There is no rate limiting, coalescing, or backpressure. Every frame carries the
complete state, including the full 50-ledger array, so the frames are large as
well as frequent. **Debounce or throttle rendering on the client and treat each
frame as a complete replacement for prior state, not a delta.**

Note that the measurement above was taken while the ledger stream was
misbehaving (see [Known data-quality issues](#known-data-quality-issues)), so
treat it as evidence that bursts are possible rather than as a normal-operation
figure.

### Keepalive and close

**There is no ping/keepalive.** The server never sends WebSocket pings and does
not time out idle clients. Consequences:

- A dead peer stays in the server's client map until the TCP connection is
  actually torn down.
- Intermediaries that close idle WebSocket connections will drop the socket
  silently. **Clients are responsible for their own reconnection.** Since the
  server pushes constantly under normal load, a client can reasonably treat a
  long silence as a dead connection.

The only close code the server originates is **`1001`** with the reason
`"Server shutting down"`, sent to every client during graceful shutdown before
the HTTP server closes. Treat `1001` as "come back shortly", and back off
rather than reconnecting immediately.

## Nullability reference

Every nullable field, and what actually makes it null.

| Route | Field | Null when |
| --- | --- | --- |
| `/api/health` | `lastUpdated`, `secondsSinceLastUpdate` | No successful upstream update has ever landed. |
| `/api/health` | `ledgerCloseTime.currentSeconds` | The newest ledger has no measurable close time — typically the only ledger in the window. |
| `/api/health` | `ledgerCloseTime.averageSeconds` | No ledger in the window has a non-null close time. |
| `/api/health` | `fees.*` | No fee snapshot has been collected yet. |
| `/api/health` | `congestion.ledgerCapacityUsage` | As above. (`band` becomes `"unknown"`; it is never null.) |
| `/api/health` | `throughput.*` | Fewer than two ledgers in the window, or a zero-length span between the oldest and newest. |
| `/api/ledgers/recent` | `closeTimeSeconds` | The ledger is the oldest in its batch, so has no predecessor to measure against. |
| `/api/fees/recent` | — | No nullable fields. The array itself may be empty. |
| `/api/history` | `closeTimeSeconds`, `congestionUsage`, `p50Fee`, `p90Fee` | No rows of that kind in the bucket, **or** the aggregate computed to exactly zero. The two are indistinguishable. |
| `/api/soroban` | `invocationsPerSecond` | No samples at all. With exactly one sample it is `0`, not null. |
| `/api/operations/breakdown` | `windowSeconds` | Fewer than two samples, so there is no span. |

Fields that are **never** null, and are safe to use unguarded:
`status`, `horizonUrl`, `congestion.band`, `congestion.alertThreshold`,
`recentLedgerCount`, `network`, `range`, `points[].operations`,
`points[].transactions`, every field of a `FeeSnapshot`, every `LedgerSample`
field except `closeTimeSeconds`, `sampleCount`, `totalOperations`,
`distinctTypes`, and every field of a `breakdown` row.

Empty collections are always `[]`, never `null` and never absent.

## Known data-quality issues

Open defects that affect what these endpoints return. Documented rather than
smoothed over, so consumers are not surprised.

**Negative `closeTimeSeconds` and a meaningless `averageSeconds`
([#84](https://github.com/solaawojobi00-bit/netpulse-xlm/issues/84)).**
`ledgerCloseTime.averageSeconds` can be wildly wrong — an observed value was
`-22174961.51`, while `currentSeconds` was a correct `6`. The rolling window
can hold ledgers from widely separated times, and a stale ledger's
`closeTimeSeconds` is measured against the newest ledger in the store rather
than its actual predecessor, producing large negative values that dominate the
mean. Until this is fixed:

- Do not display `averageSeconds` without sanity-checking it.
- Filter `closeTimeSeconds <= 0` out of any chart or aggregate.

**Zero aggregates are reported as `null` in `/api/history`.** The truthiness
check described [above](#reading-the-points-array-correctly) means a genuine
zero is indistinguishable from missing data in `closeTimeSeconds`,
`congestionUsage`, `p50Fee` and `p90Fee`.

**`transactionsPerSecond` and `history.transactions` count different things.**
Successful-only versus successful-plus-failed. See
[the note above](#throughput-counts-transactions-differently-from-history).
