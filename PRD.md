# PRD: NetPulse (Stellar Network Health Dashboard)

## Problem

Stellar and Soroban developers have no simple, at-a-glance view of current
network conditions while they build and test. Questions like "is the network
congested right now?", "are base fees elevated?", "is my transaction slow
because of me or because of the network?" currently require either manually
querying Horizon endpoints or digging through block explorers built for
end-user transaction lookups rather than network-level health monitoring.

There is no lightweight, developer-facing dashboard that exists purely to
answer: **"How healthy is the Stellar network right now?"**

## Target Users

- **Stellar/Soroban application developers** who want a quick health check
  during local development, debugging, or before submitting a
  fee-bump/time-sensitive transaction.
- **Stellar Wave contributors** evaluating or extending ecosystem
  infrastructure tooling.
- **Node operators and ecosystem tooling maintainers** who want a simple
  reference implementation of "how to read network health from Horizon"
  they can adapt.

This is developer/ecosystem infrastructure, not an end-user commerce or
wallet product. No accounts, no auth, no user-specific data.

## Core Metrics (v1)

Sourced from Stellar's public Horizon API (mainnet — see ARCHITECTURE.md for
justification). All five are cleanly exposed by existing Horizon endpoints
with no derived/estimated data beyond simple aggregation over a recent
window:

1. **Ledger close time** — time delta between consecutive ledgers'
   `closed_at` timestamps. Displayed as current/rolling-average close time
   (target: ~5s) and a recent trend sparkline. Sudden increases indicate
   validator/network-level issues.

2. **Base fee & fee-bump activity** — from `/fee_stats`: current
   `last_ledger_base_fee`, and the `fee_charged` percentile distribution
   (p10/p50/p90/p99). A widening gap between the base fee and higher
   percentiles indicates fee-bidding activity (i.e., surge pricing) as
   users compete for ledger space.

3. **Network congestion indicator** — `ledger_capacity_usage` from
   `/fee_stats`, i.e. how full recent ledgers are relative to
   `max_tx_set_size`. Displayed as a percentage gauge with simple
   low/moderate/high banding.

4. **Recent ledger throughput** — `successful_transaction_count` and
   `operation_count` per ledger from `/ledgers`, converted to
   operations/second and transactions/second over a rolling window (last
   ~20 ledgers, ~2 minutes).

5. **Operation count trend** — a time-series chart of `operation_count`
   across recent ledgers, so a developer can see whether activity is
   trending up, down, or flat, independent of the instantaneous
   throughput number.

## Out of Scope for v1

- **Historical/long-range analytics** (hourly/daily/weekly aggregates,
  data persisted beyond an in-memory rolling window). v1 is a live
  snapshot tool, not a time-series database product.
- **Per-account or per-transaction lookup/search** — this is not a block
  explorer. No address search, no transaction detail pages.
- **Alerting/notifications** (email, webhook, Discord/Slack pings on
  thresholds). Flagged as a Phase 2+ issue.
- **Authentication, user accounts, saved preferences, multi-tenant
  dashboards.**
- **Testnet or Futurenet support.** Mainnet only for v1 (see
  ARCHITECTURE.md); multi-network toggle is a good later issue.
- **Soroban-specific contract-level metrics** (e.g. per-contract
  invocation counts, Wasm execution cost trends). Valuable follow-up but
  distinct data source/effort from core ledger health.
- **Mobile-optimized layout / PWA install.** Responsive-enough for a
  secondary monitor or browser tab is sufficient for v1; dedicated mobile
  polish is a later issue.
- **WebSocket/SSE push updates.** v1 uses backend polling + frontend
  polling (see ARCHITECTURE.md); moving to push-based updates is
  explicitly deferred to a Phase 2+ issue.

## Success Criteria for Phase 1

- Dashboard is reachable locally, fetches real data from public Horizon
  mainnet (not mocked/fixture data), and all 5 metrics above render and
  update on a visible interval without a page reload.
- Backend survives a Horizon request failure (timeout, 5xx, rate limit)
  without crashing, and the frontend communicates a stale/degraded state
  rather than showing wrong data silently.
- Code and structure are approachable enough that a Wave contributor with
  general JS/TS experience (not necessarily Stellar experience) can pick
  up a "add a new metric" or "add a new chart" issue without needing a
  guided walkthrough.
