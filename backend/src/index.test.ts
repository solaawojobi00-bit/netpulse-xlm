import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./horizon.js", () => ({
  HORIZON_URLS: {
    mainnet: "https://horizon.stellar.org",
    testnet: "https://horizon-testnet.stellar.org",
  },
  fetchRecentLedgers: vi.fn(),
  fetchFeeStats: vi.fn(),
}));

import { fetchFeeStats, fetchRecentLedgers } from "./horizon.js";
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

describe("Backend API Routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
});
