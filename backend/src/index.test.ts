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

import {
  fetchFeeStats,
  fetchRecentLedgers,
  fetchRecentOperations,
} from "./horizon.js";
import { createApp } from "./index.js";
import { pollOnce, stores } from "./poller.js";
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

      const res = await request(app).get(
        "/api/history?network=testnet&range=6h&format=csv",
      );

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

  describe("GET /api/trends", () => {
    /*
     * Seeded by polling and then rolling up with a tiny retention, as the
     * issue suggests. That exercises the real write path — poll, insert,
     * roll up — rather than asserting against hand-written rollup rows, so
     * these tests would catch the endpoint and the rollup disagreeing.
     */
    const seedYesterday = async () => {
      const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const closedAt = new Date(
        Date.UTC(
          yesterday.getUTCFullYear(),
          yesterday.getUTCMonth(),
          yesterday.getUTCDate(),
          12,
        ),
      ).toISOString();

      vi.mocked(fetchRecentLedgers).mockResolvedValue([
        { ...mockLedger, sequence: 9001, closedAt },
      ]);
      vi.mocked(fetchFeeStats).mockResolvedValue({
        ...mockFee,
        fetchedAt: closedAt,
      });

      await pollOnce("mainnet");
      db.rollupAndPrune();

      return closedAt.slice(0, 10);
    };

    it("returns 200 with network, range and points", async () => {
      const date = await seedYesterday();

      const res = await request(app).get("/api/trends");

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("network", "mainnet");
      expect(res.body).toHaveProperty("range", "90d");
      expect(Array.isArray(res.body.points)).toBe(true);

      const point = res.body.points.find(
        (p: { date: string }) => p.date === date,
      );
      expect(point).toBeDefined();
      expect(point).toHaveProperty("closeTimeSeconds");
      expect(point).toHaveProperty("maxCongestionUsage");
      expect(point).toHaveProperty("successfulTransactions");
      expect(point).toHaveProperty("failedTransactions");
    });

    it("accepts 30d, 90d and 1y, echoing the canonical label", async () => {
      for (const [query, expected] of [
        ["?range=30d", "30d"],
        ["?range=90d", "90d"],
        ["?range=1y", "1y"],
      ]) {
        const res = await request(app).get(`/api/trends${query}`);
        expect(res.status).toBe(200);
        expect(res.body.range).toBe(expected);
      }
    });

    it("defaults to 90d when range is omitted", async () => {
      const res = await request(app).get("/api/trends");

      expect(res.status).toBe(200);
      expect(res.body.range).toBe("90d");
    });

    it("coerces an unrecognised range to 90d and still returns 200", async () => {
      /*
       * Deliberately lenient, matching /api/history and the four other routes.
       * Introducing 4xx here alone would make this endpoint behave unlike its
       * siblings; tightening the whole surface at once is #92.
       */
      for (const bad of [
        "?range=10y",
        "?range=GARBAGE",
        "?range=",
        "?range=24h",
      ]) {
        const res = await request(app).get(`/api/trends${bad}`);
        expect(res.status).toBe(200);
        expect(res.body.range).toBe("90d");
      }
    });

    it("respects network=testnet and coerces anything else to mainnet", async () => {
      const testnet = await request(app).get("/api/trends?network=testnet");
      expect(testnet.status).toBe(200);
      expect(testnet.body.network).toBe("testnet");

      for (const bad of ["?network=mars", "?network=", ""]) {
        const res = await request(app).get(`/api/trends${bad}`);
        expect(res.status).toBe(200);
        expect(res.body.network).toBe("mainnet");
      }
    });

    it("returns points oldest-first", async () => {
      await seedYesterday();

      const res = await request(app).get("/api/trends");
      const dates = res.body.points.map((p: { date: string }) => p.date);

      expect([...dates].sort()).toEqual(dates);
    });

    it("returns an empty array rather than 404 when nothing is rolled up", async () => {
      const res = await request(app).get("/api/trends?network=testnet");

      expect(res.status).toBe(200);
      expect(res.body.points).toEqual([]);
    });

    it("carries no Content-Disposition when no format is given", async () => {
      // The dashboard fetches this endpoint without a format; it must not
      // start downloading a file.
      const res = await request(app).get("/api/trends");

      expect(res.headers["content-disposition"]).toBeUndefined();
      expect(res.headers["content-type"]).toMatch(/application\/json/);
    });

    describe("export formats", () => {
      it("serves CSV as an attachment for format=csv", async () => {
        await seedYesterday();

        const res = await request(app).get("/api/trends?format=csv");

        expect(res.status).toBe(200);
        expect(res.headers["content-type"]).toMatch(/text\/csv/);
        expect(res.headers["content-disposition"]).toBe(
          'attachment; filename="netpulse-trends-mainnet-90d.csv"',
        );
        expect(res.text.split("\r\n")[0]).toBe(
          "network,range,date,closeTimeSeconds,congestionUsage,maxCongestionUsage," +
            "operations,successfulTransactions,failedTransactions,p50Fee,p90Fee",
        );
      });

      it("serves the same JSON body as an attachment for format=json", async () => {
        await seedYesterday();

        const inline = await request(app).get("/api/trends");
        const download = await request(app).get("/api/trends?format=json");

        expect(download.status).toBe(200);
        expect(download.headers["content-disposition"]).toBe(
          'attachment; filename="netpulse-trends-mainnet-90d.json"',
        );
        // Only the header differs — the body is the same resource.
        expect(download.body).toEqual(inline.body);
      });

      it("ignores an unrecognised format and serves inline JSON", async () => {
        for (const bad of ["?format=xml", "?format=", "?format=CSV"]) {
          const res = await request(app).get(`/api/trends${bad}`);

          expect(res.status).toBe(200);
          expect(res.headers["content-type"]).toMatch(/application\/json/);
          expect(res.headers["content-disposition"]).toBeUndefined();
        }
      });

      it("applies network and range to the export and the filename", async () => {
        const res = await request(app).get(
          "/api/trends?network=testnet&range=1y&format=csv",
        );

        expect(res.status).toBe(200);
        expect(res.headers["content-disposition"]).toBe(
          'attachment; filename="netpulse-trends-testnet-1y.csv"',
        );
      });

      it("emits one CSV row per day, nulls as empty fields", async () => {
        const date = await seedYesterday();

        const res = await request(app).get("/api/trends?format=csv");
        const rows = res.text.split("\r\n").slice(1).filter(Boolean);

        expect(rows.length).toBeGreaterThan(0);
        const row = rows.find((r) => r.includes(date));
        expect(row).toBeDefined();
        expect(row).toMatch(/^mainnet,90d,/);
        expect(row).not.toContain("null");
      });

      it("terminates the CSV with CRLF including the final row", async () => {
        await seedYesterday();

        const res = await request(app).get("/api/trends?format=csv");

        expect(res.text.endsWith("\r\n")).toBe(true);
      });

      it("serves a header-only CSV when nothing is rolled up", async () => {
        const res = await request(app).get(
          "/api/trends?network=testnet&format=csv",
        );

        expect(res.status).toBe(200);
        expect(res.text.split("\r\n").filter(Boolean)).toHaveLength(1);
      });
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

  describe("GET /api/operations/breakdown", () => {
    beforeEach(() => {
      // Samples accumulate across polls by design, so an exact count here
      // would otherwise depend on which tests ran first.
      stores.mainnet.reset();
      stores.testnet.reset();
    });

    it("returns every operation type from the poll, not just the Soroban ones", async () => {
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
        {
          id: "3",
          paging_token: "3",
          transaction_successful: true,
          type: "payment",
          created_at: new Date().toISOString(),
        },
      ]);

      await pollOnce("mainnet");

      const res = await request(app).get("/api/operations/breakdown");
      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("network", "mainnet");

      // The whole point of the issue: `payment` used to be discarded here.
      const payment = res.body.breakdown.find(
        (b: { type: string }) => b.type === "payment",
      );
      expect(payment.count).toBe(2);
      expect(
        res.body.breakdown.find(
          (b: { type: string }) => b.type === "invoke_host_function",
        ).count,
      ).toBe(1);
      expect(res.body.totalOperations).toBe(3);
    });

    it("honours the network query param", async () => {
      const res = await request(app).get(
        "/api/operations/breakdown?network=testnet",
      );

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty("network", "testnet");
      expect(Array.isArray(res.body.breakdown)).toBe(true);
    });
  });
});
