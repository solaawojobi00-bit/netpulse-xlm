import fs from "fs";
import path from "path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("./horizon.js", () => ({
  HORIZON_URLS: {
    mainnet: "https://horizon.stellar.org",
    testnet: "https://horizon-testnet.stellar.org",
  },
  fetchRecentLedgers: vi.fn(),
  fetchFeeStats: vi.fn(),
  fetchRecentOperations: vi.fn(),
}));

import { db } from "./db.js";
import { fetchFeeStats, fetchRecentLedgers, fetchRecentOperations } from "./horizon.js";
import { createApp } from "./index.js";
import { pollOnce } from "./poller.js";
import type { FeeSnapshot, LedgerSample } from "./types.js";

/*
 * A drift guard for docs/API.md, not a schema validator.
 *
 * Two documents in this repo have already fallen behind the server: the
 * endpoint list in ARCHITECTURE.md, and the route list in the issue that asked
 * for this reference. Absence of documentation was never the hard part; keeping
 * it true as routes and fields change is. So this test asserts the cheap,
 * durable property that catches that specific failure: every route the server
 * answers, and every response key it actually returns, appears somewhere in
 * docs/API.md.
 *
 * Deliberately blunt. It checks for the presence of names, not their
 * descriptions, types or nesting, because a stricter check would need updating
 * for prose edits and would be abandoned. If this fails, a field or route was
 * added without being documented.
 */

const DOCS_PATH = path.join(import.meta.dirname, "..", "..", "docs", "API.md");

/** Every route the server registers. Keep in step with createApp(). */
const ROUTES = [
  "/healthz",
  "/api/health",
  "/api/ledgers/recent",
  "/api/fees/recent",
  "/api/history",
  "/api/soroban",
  "/api/operations/breakdown",
] as const;

const app = createApp();
let docs: string;

const mockLedger: LedgerSample = {
  sequence: 12345,
  closedAt: new Date().toISOString(),
  closeTimeSeconds: 5.2,
  successfulTransactionCount: 40,
  failedTransactionCount: 2,
  operationCount: 150,
  txSetOperationCount: 150,
  baseFeeInStroops: 100,
  maxTxSetSize: 1000,
};

const mockFee: FeeSnapshot = {
  fetchedAt: new Date().toISOString(),
  lastLedgerBaseFee: 100,
  ledgerCapacityUsage: 0.25,
  feeChargedP10: 100,
  feeChargedP50: 100,
  feeChargedP90: 150,
  feeChargedP99: 500,
};

/**
 * Collects key names from a response body, descending into nested objects and
 * into the first element of each array. Array indices are not keys, so a
 * 50-ledger response contributes one ledger's field names.
 */
function collectKeys(value: unknown, into = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    if (value.length > 0) collectKeys(value[0], into);
    return into;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
  return into;
}

beforeAll(async () => {
  docs = fs.readFileSync(DOCS_PATH, "utf8");

  // Seed both stores so every route returns populated data rather than the
  // empty shapes, which would hide most field names from this check.
  vi.mocked(fetchRecentLedgers).mockResolvedValue([mockLedger]);
  vi.mocked(fetchFeeStats).mockResolvedValue(mockFee);
  vi.mocked(fetchRecentOperations).mockResolvedValue([
    {
      id: "1",
      paging_token: "1",
      transaction_successful: true,
      type: "invoke_host_function",
      created_at: new Date().toISOString(),
    },
    {
      id: "2",
      paging_token: "2",
      transaction_successful: true,
      type: "payment",
      created_at: new Date().toISOString(),
    },
  ]);

  await pollOnce("mainnet");
});

afterAll(() => {
  db.close();
});

describe("docs/API.md", () => {
  it("exists", () => {
    expect(fs.existsSync(DOCS_PATH)).toBe(true);
  });

  it.each(ROUTES)("documents the route %s", (route) => {
    expect(docs).toContain(route);
  });

  it("documents every route the server actually registers", () => {
    /*
     * Guards the list above from going stale in the other direction: if a route
     * is added to createApp() but not to ROUTES, this catches it, because an
     * undocumented route still answers requests.
     */
    const registered: string[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const router = (app as any)._router ?? (app as any).router;
    for (const layer of router?.stack ?? []) {
      if (layer.route?.path && typeof layer.route.path === "string") {
        registered.push(layer.route.path);
      }
    }

    expect(registered.length).toBeGreaterThan(0);
    expect([...registered].sort()).toEqual([...ROUTES].sort());
  });

  describe("documents every response key each route returns", () => {
    it.each(ROUTES)("%s", async (route) => {
      const res = await request(app).get(route);
      expect(res.status).toBe(200);

      const keys = [...collectKeys(res.body)];
      expect(keys.length).toBeGreaterThan(0);

      const undocumented = keys.filter((key) => !docs.includes(key));
      expect(
        undocumented,
        `${route} returned key(s) missing from docs/API.md: ${undocumented.join(", ")}`,
      ).toEqual([]);
    });
  });

  it("documents every key in the /ws snapshot frame", () => {
    /*
     * Built from the same builders ws.ts uses rather than by opening a socket,
     * so this stays a unit test. The frame's own envelope keys are listed
     * explicitly because that is where the REST-to-WebSocket rename lives:
     * the fee array is `snapshots` over REST and `fees` here.
     */
    const envelope = [
      "type",
      "network",
      "health",
      "ledgers",
      "fees",
      "soroban",
      "operationBreakdown",
    ];

    const undocumented = envelope.filter((key) => !docs.includes(key));
    expect(
      undocumented,
      `/ws snapshot key(s) missing from docs/API.md: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("documents the client message types /ws accepts", () => {
    for (const messageType of ["subscribe", "setNetwork"]) {
      expect(docs).toContain(messageType);
    }
  });

  it("documents the query parameters the routes read", () => {
    for (const param of ["network", "range", "format"]) {
      expect(docs).toContain(param);
    }
  });

  it("documents both accepted range values and the fallback", () => {
    for (const range of ["6h", "12h", "24h"]) {
      expect(docs).toContain(range);
    }
  });

  it("documents both health status values", () => {
    for (const status of ['"ok"', '"stale"']) {
      expect(docs).toContain(status);
    }
  });

  it("documents every congestion band the server can emit", () => {
    for (const band of ["low", "moderate", "high", "unknown"]) {
      expect(docs).toContain(band);
    }
  });
});
