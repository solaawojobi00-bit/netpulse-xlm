import request from "supertest";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./horizon.js", () => ({
  HORIZON_URLS: {
    mainnet: "https://horizon.stellar.org",
    testnet: "https://horizon-testnet.stellar.org",
  },
  fetchRecentLedgers: vi.fn(),
  fetchFeeStats: vi.fn(),
  fetchRecentOperations: vi.fn(),
}));

import { fetchFeeStats, fetchRecentLedgers, fetchRecentOperations } from "./horizon.js";
import { createApp } from "./index.js";
import { pollOnce } from "./poller.js";
import type { FeeSnapshot, LedgerSample } from "./types.js";

const app = createApp();

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

import { db } from "./db.js";

describe("Backend API Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchRecentOperations).mockResolvedValue([]);
  });

  afterAll(() => {
    db.close();
  });

  describe("GET /healthz", () => {
    it("returns 200 with status: 'ok' regardless of poller state", async () => {
      const res = await request(app).get("/healthz");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ status: "ok" });
    });
  });

  describe("GET /api/health", () => {
    it("returns status: 'stale' when no poll has occurred yet", async () => {
      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("stale");
      expect(res.body.lastUpdated).toBeNull();
      expect(res.body.horizonUrl).toBe("https://horizon.stellar.org");
    });

    it("returns status: 'ok' after a successful mocked poll", async () => {
      vi.mocked(fetchRecentLedgers).mockResolvedValue([mockLedger]);
      vi.mocked(fetchFeeStats).mockResolvedValue(mockFee);

      await pollOnce("mainnet");

      const res = await request(app).get("/api/health");
      expect(res.status).toBe(200);
      expect(res.body.status).toBe("ok");
      expect(res.body.lastUpdated).not.toBeNull();
      expect(res.body.ledgerCloseTime.currentSeconds).toBe(5.2);
      expect(res.body.fees.baseFeeStroops).toBe(100);
      expect(res.body.congestion.band).toBe("low");
    });

    it("supports ?network=testnet", async () => {
      const res = await request(app).get("/api/health?network=testnet");
      expect(res.status).toBe(200);
      expect(res.body.horizonUrl).toBe("https://horizon-testnet.stellar.org");
    });
  });

  describe("GET /api/ledgers/recent", () => {
    it("returns the expected { ledgers: [...] } shape", async () => {
      vi.mocked(fetchRecentLedgers).mockResolvedValue([mockLedger]);
      vi.mocked(fetchFeeStats).mockResolvedValue(mockFee);

      await pollOnce("mainnet");

      const res = await request(app).get("/api/ledgers/recent");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("ledgers");
      expect(Array.isArray(res.body.ledgers)).toBe(true);
      expect(res.body.ledgers.length).toBeGreaterThan(0);
      expect(res.body.ledgers[0].sequence).toBe(12345);
    });
  });

  describe("GET /api/fees/recent", () => {
    it("returns the expected { snapshots: [...] } shape", async () => {
      vi.mocked(fetchRecentLedgers).mockResolvedValue([mockLedger]);
      vi.mocked(fetchFeeStats).mockResolvedValue(mockFee);

      await pollOnce("mainnet");

      const res = await request(app).get("/api/fees/recent");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("snapshots");
      expect(Array.isArray(res.body.snapshots)).toBe(true);
      expect(res.body.snapshots.length).toBeGreaterThan(0);
      expect(res.body.snapshots[0].feeChargedP50).toBe(100);
      expect(res.body.snapshots[0].feeChargedP90).toBe(150);
    });
  });

  describe("GET /api/history", () => {
    it("returns aggregated 24h history points", async () => {
      vi.mocked(fetchRecentLedgers).mockResolvedValue([mockLedger]);
      vi.mocked(fetchFeeStats).mockResolvedValue(mockFee);

      await pollOnce("mainnet");

      const res = await request(app).get("/api/history?range=24h");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("network", "mainnet");
      expect(res.body).toHaveProperty("range", "24h");
      expect(res.body).toHaveProperty("points");
      expect(Array.isArray(res.body.points)).toBe(true);
      expect(res.body.points.length).toBeGreaterThan(0);
      expect(res.body.points[0]).toHaveProperty("closeTimeSeconds");
      expect(res.body.points[0]).toHaveProperty("congestionUsage");
    });

    it("serves the unchanged JSON body with no attachment header when no format is given", async () => {
      // The frontend fetches this endpoint without a format; it must not
      // start downloading as a file.
      vi.mocked(fetchRecentLedgers).mockResolvedValue([mockLedger]);
      vi.mocked(fetchFeeStats).mockResolvedValue(mockFee);
      await pollOnce("mainnet");

      const res = await request(app).get("/api/history?range=24h");

      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toBeUndefined();
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });

    it("exports CSV with a header row and one row per bucket", async () => {
      vi.mocked(fetchRecentLedgers).mockResolvedValue([mockLedger]);
      vi.mocked(fetchFeeStats).mockResolvedValue(mockFee);
      await pollOnce("mainnet");

      const res = await request(app).get("/api/history?range=24h&format=csv");

      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/csv/);
      expect(res.headers["content-disposition"]).toBe(
        'attachment; filename="netpulse-history-mainnet-24h.csv"',
      );

      const rows = res.text.trimEnd().split("\r\n");
      expect(rows[0]).toBe(
        "network,range,timestamp,closeTimeSeconds,congestionUsage,operations,transactions,p50Fee,p90Fee",
      );
      expect(rows.length).toBeGreaterThan(1);
      expect(rows[1].startsWith("mainnet,24h,")).toBe(true);
    });

    it("exports JSON as an attachment while keeping the existing body shape", async () => {
      vi.mocked(fetchRecentLedgers).mockResolvedValue([mockLedger]);
      vi.mocked(fetchFeeStats).mockResolvedValue(mockFee);
      await pollOnce("mainnet");

      const res = await request(app).get("/api/history?range=24h&format=json");

      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toBe(
        'attachment; filename="netpulse-history-mainnet-24h.json"',
      );
      expect(res.body).toHaveProperty("network", "mainnet");
      expect(res.body).toHaveProperty("range", "24h");
      expect(Array.isArray(res.body.points)).toBe(true);
    });

    it("still respects the network and range params when exporting", async () => {
      vi.mocked(fetchRecentLedgers).mockResolvedValue([mockLedger]);
      vi.mocked(fetchFeeStats).mockResolvedValue(mockFee);
      await pollOnce("testnet");

      const res = await request(app).get("/api/history?network=testnet&range=6h&format=csv");

      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toBe(
        'attachment; filename="netpulse-history-testnet-6h.csv"',
      );
      const rows = res.text.trimEnd().split("\r\n");
      expect(rows[1].startsWith("testnet,6h,")).toBe(true);
    });

    it("ignores an unrecognised format and serves the default JSON body", async () => {
      vi.mocked(fetchRecentLedgers).mockResolvedValue([mockLedger]);
      vi.mocked(fetchFeeStats).mockResolvedValue(mockFee);
      await pollOnce("mainnet");

      const res = await request(app).get("/api/history?format=xml");

      expect(res.status).toBe(200);
      expect(res.headers["content-disposition"]).toBeUndefined();
      expect(res.body).toHaveProperty("points");
    });
  });

  describe("GET /api/soroban", () => {
    it("returns Soroban metrics with invocation counts and rates", async () => {
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
          transaction_successful: false,
          type: "payment",
          created_at: new Date().toISOString(),
        },
      ]);

      await pollOnce("mainnet");

      const res = await request(app).get("/api/soroban");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("network", "mainnet");
      expect(res.body).toHaveProperty("recentInvocationsTotal", 1);
      expect(res.body).toHaveProperty("successfulInvocationsTotal", 1);
      expect(res.body).toHaveProperty("failedInvocationsTotal", 0);
      expect(Array.isArray(res.body.samples)).toBe(true);
    });
  });
});
