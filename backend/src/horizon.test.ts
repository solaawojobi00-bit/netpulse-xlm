import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectHorizonLedgerStream,
  fetchFeeStats,
  fetchRecentLedgers,
  fetchRecentLedgersWithCursor,
  HorizonFeeStatsResponseSchema,
  HorizonLedgerRecordSchema,
  HorizonOperationRecordSchema,
  numericCoerce,
  recordToSample,
} from "./horizon.js";
import type { HorizonLedgerRecord } from "./horizon.js";

describe("Horizon Unit Tests", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe("recordToSample", () => {
    const baseRecord: HorizonLedgerRecord = {
      sequence: 100,
      closed_at: "2026-09-02T12:00:05Z",
      successful_transaction_count: 10,
      failed_transaction_count: 1,
      operation_count: 25,
      tx_set_operation_count: 25,
      base_fee_in_stroops: 100,
      max_tx_set_size: 1000,
    };

    it("computes closeTimeSeconds from prevClosedAt", () => {
      const prevClosedAt = "2026-09-02T12:00:00Z";
      const sample = recordToSample(baseRecord, prevClosedAt);
      expect(sample.closeTimeSeconds).toBe(5);
      expect(sample.sequence).toBe(100);
      expect(sample.closedAt).toBe("2026-09-02T12:00:05Z");
      expect(sample.successfulTransactionCount).toBe(10);
      expect(sample.failedTransactionCount).toBe(1);
      expect(sample.operationCount).toBe(25);
      expect(sample.txSetOperationCount).toBe(25);
      expect(sample.baseFeeInStroops).toBe(100);
      expect(sample.maxTxSetSize).toBe(1000);
    });

    it("returns null for closeTimeSeconds when prevClosedAt is absent or null", () => {
      const sampleNull = recordToSample(baseRecord, null);
      expect(sampleNull.closeTimeSeconds).toBeNull();

      const sampleUndefined = recordToSample(baseRecord);
      expect(sampleUndefined.closeTimeSeconds).toBeNull();
    });
  });

  describe("fetchRecentLedgers", () => {
    it("returns samples oldest-first with correct closeTimeSeconds deltas", async () => {
      // Horizon returns newest-first: ledger 3, ledger 2, ledger 1
      const mockRecords: HorizonLedgerRecord[] = [
        {
          sequence: 3,
          closed_at: "2026-09-02T12:00:11Z",
          successful_transaction_count: 15,
          failed_transaction_count: 0,
          operation_count: 30,
          tx_set_operation_count: 30,
          base_fee_in_stroops: 100,
          max_tx_set_size: 1000,
        },
        {
          sequence: 2,
          closed_at: "2026-09-02T12:00:06Z",
          successful_transaction_count: 10,
          failed_transaction_count: 1,
          operation_count: 20,
          tx_set_operation_count: 20,
          base_fee_in_stroops: 100,
          max_tx_set_size: 1000,
        },
        {
          sequence: 1,
          closed_at: "2026-09-02T12:00:01Z",
          successful_transaction_count: 5,
          failed_transaction_count: 0,
          operation_count: 10,
          tx_set_operation_count: 10,
          base_fee_in_stroops: 100,
          max_tx_set_size: 1000,
        },
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          _embedded: { records: mockRecords },
        }),
      });

      const samples = await fetchRecentLedgers(
        3,
        "https://horizon-test.example.com",
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://horizon-test.example.com/ledgers?order=desc&limit=3",
        { headers: { Accept: "application/json" } },
      );

      // Chronological order: sequence 1, sequence 2, sequence 3
      expect(samples).toHaveLength(3);
      expect(samples[0].sequence).toBe(1);
      expect(samples[0].closeTimeSeconds).toBeNull();

      expect(samples[1].sequence).toBe(2);
      expect(samples[1].closeTimeSeconds).toBe(5); // 12:00:06 - 12:00:01

      expect(samples[2].sequence).toBe(3);
      expect(samples[2].closeTimeSeconds).toBe(5); // 12:00:11 - 12:00:06
    });
  });

  describe("fetchFeeStats", () => {
    it("coerces string fields from Horizon to numbers", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          last_ledger_base_fee: "150",
          ledger_capacity_usage: "0.42",
          fee_charged: {
            p10: "100",
            p50: "125",
            p90: "250",
            p99: "1000",
          },
        }),
      });

      const feeStats = await fetchFeeStats("https://horizon-test.example.com");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://horizon-test.example.com/fee_stats",
        { headers: { Accept: "application/json" } },
      );

      expect(typeof feeStats.lastLedgerBaseFee).toBe("number");
      expect(feeStats.lastLedgerBaseFee).toBe(150);
      expect(typeof feeStats.ledgerCapacityUsage).toBe("number");
      expect(feeStats.ledgerCapacityUsage).toBe(0.42);
      expect(feeStats.feeChargedP10).toBe(100);
      expect(feeStats.feeChargedP50).toBe(125);
      expect(feeStats.feeChargedP90).toBe(250);
      expect(feeStats.feeChargedP99).toBe(1000);
      expect(feeStats.fetchedAt).toBeDefined();
    });
  });

  /*
   * The cursor half of the warm-up (#109). These assert on which record's
   * token is returned, because picking the wrong end of a newest-first
   * response would seed the stream from the *oldest* ledger of the window and
   * replay it, which is a plausible mistake that still type-checks.
   */
  describe("fetchRecentLedgersWithCursor", () => {
    const record = (
      sequence: number,
      closedAt: string,
      pagingToken?: string,
    ): HorizonLedgerRecord => ({
      ...(pagingToken === undefined ? {} : { paging_token: pagingToken }),
      sequence,
      closed_at: closedAt,
      successful_transaction_count: 1,
      failed_transaction_count: 0,
      operation_count: 2,
      tx_set_operation_count: 2,
      base_fee_in_stroops: 100,
      max_tx_set_size: 1000,
    });

    const mockResponse = (records: HorizonLedgerRecord[]) => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ _embedded: { records } }),
      });
    };

    it("returns the newest record's paging token, not the oldest", async () => {
      // Horizon returns newest-first, so sequence 3 is index 0.
      mockResponse([
        record(3, "2026-09-02T12:00:11Z", "token-3"),
        record(2, "2026-09-02T12:00:06Z", "token-2"),
        record(1, "2026-09-02T12:00:01Z", "token-1"),
      ]);

      const page = await fetchRecentLedgersWithCursor(
        3,
        "https://horizon-test.example.com",
      );

      expect(page.newestPagingToken).toBe("token-3");
      // Samples stay oldest-first, exactly as fetchRecentLedgers presents them.
      expect(page.samples.map((s) => s.sequence)).toEqual([1, 2, 3]);
    });

    it("returns the same samples as fetchRecentLedgers for the same response", async () => {
      const records = [
        record(3, "2026-09-02T12:00:11Z", "token-3"),
        record(2, "2026-09-02T12:00:06Z", "token-2"),
      ];

      mockResponse(records);
      const page = await fetchRecentLedgersWithCursor(
        2,
        "https://horizon-test.example.com",
      );

      mockResponse(records);
      const samples = await fetchRecentLedgers(
        2,
        "https://horizon-test.example.com",
      );

      expect(page.samples).toEqual(samples);
    });

    it("returns null when the newest record carries no paging token", async () => {
      mockResponse([
        record(3, "2026-09-02T12:00:11Z"), // newest, no token
        record(2, "2026-09-02T12:00:06Z", "token-2"),
      ]);

      const page = await fetchRecentLedgersWithCursor(
        2,
        "https://horizon-test.example.com",
      );

      // Deliberately not "fall back to the next record's token": that would
      // resume before a ledger already held, replaying it.
      expect(page.newestPagingToken).toBeNull();
      expect(page.samples).toHaveLength(2);
    });

    it("returns null and no samples for an empty response", async () => {
      mockResponse([]);

      const page = await fetchRecentLedgersWithCursor(
        5,
        "https://horizon-test.example.com",
      );

      expect(page.newestPagingToken).toBeNull();
      expect(page.samples).toEqual([]);
    });

    it("never returns a ledger sequence as the token", async () => {
      mockResponse([
        record(64345549, "2026-09-02T12:00:11Z", "276362028598165504"),
      ]);

      const page = await fetchRecentLedgersWithCursor(
        1,
        "https://horizon-test.example.com",
      );

      // A real token is not the sequence: this is the #84 confusion, and the
      // two are genuinely different magnitudes on live Horizon.
      expect(page.newestPagingToken).toBe("276362028598165504");
      expect(page.newestPagingToken).not.toBe("64345549");
      expect(page.newestPagingToken).not.toBe(String(page.samples[0].sequence));
    });
  });

  describe("horizonFetch error path", () => {
    it("throws with path and status in message when response is non-2xx", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
      });

      await expect(
        fetchRecentLedgers(5, "https://horizon-test.example.com"),
      ).rejects.toThrow(
        "Horizon request failed: /ledgers?order=desc&limit=5 -> 503",
      );
    });
  });

  describe("connectHorizonLedgerStream", () => {
    function createMockStream(chunks: string[]): ReadableStream<Uint8Array> {
      const encoder = new TextEncoder();
      return new ReadableStream({
        start(controller) {
          for (const chunk of chunks) {
            controller.enqueue(encoder.encode(chunk));
          }
          controller.close();
        },
      });
    }

    const validRecord: HorizonLedgerRecord = {
      sequence: 999,
      closed_at: "2026-09-02T12:00:00Z",
      successful_transaction_count: 20,
      failed_transaction_count: 0,
      operation_count: 50,
      tx_set_operation_count: 50,
      base_fee_in_stroops: 100,
      max_tx_set_size: 1000,
    };

    it("invokes onLedger callback with parsed record on well-formed data event", async () => {
      const ssePayload = "data: " + JSON.stringify(validRecord) + "\n\n";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: createMockStream([ssePayload]),
      });

      const onLedger = vi.fn();
      await connectHorizonLedgerStream(
        "https://horizon-test.example.com",
        "now",
        onLedger,
      );

      expect(onLedger).toHaveBeenCalledTimes(1);
      expect(onLedger).toHaveBeenCalledWith(validRecord);
    });

    it("buffers and parses an event split across two stream chunks", async () => {
      const fullEvent = "data: " + JSON.stringify(validRecord) + "\n\n";
      const half = Math.floor(fullEvent.length / 2);
      const chunk1 = fullEvent.slice(0, half);
      const chunk2 = fullEvent.slice(half);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: createMockStream([chunk1, chunk2]),
      });

      const onLedger = vi.fn();
      await connectHorizonLedgerStream(
        "https://horizon-test.example.com",
        "now",
        onLedger,
      );

      expect(onLedger).toHaveBeenCalledTimes(1);
      expect(onLedger).toHaveBeenCalledWith(validRecord);
    });

    it("ignores hello handshake payload and non-JSON heartbeat lines without throwing", async () => {
      const streamData = [
        'data: "hello"\n\n',
        ": heartbeat\n\n",
        "data: not-json\n\n",
        "data: " + JSON.stringify(validRecord) + "\n\n",
      ];

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: createMockStream(streamData),
      });

      const onLedger = vi.fn();
      await expect(
        connectHorizonLedgerStream(
          "https://horizon-test.example.com",
          "now",
          onLedger,
        ),
      ).resolves.toBeUndefined();

      expect(onLedger).toHaveBeenCalledTimes(1);
      expect(onLedger).toHaveBeenCalledWith(validRecord);
    });

    it("does not invoke callback for record without sequence", async () => {
      const invalidRecord = {
        closed_at: "2026-09-02T12:00:00Z",
        successful_transaction_count: 20,
        failed_transaction_count: 0,
        operation_count: 50,
        tx_set_operation_count: 50,
        base_fee_in_stroops: 100,
        max_tx_set_size: 1000,
      };

      const ssePayload = "data: " + JSON.stringify(invalidRecord) + "\n\n";
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        body: createMockStream([ssePayload]),
      });

      const onLedger = vi.fn();
      await connectHorizonLedgerStream(
        "https://horizon-test.example.com",
        "now",
        onLedger,
      );

      expect(onLedger).not.toHaveBeenCalled();
    });

    it("throws if response is not ok or body is missing", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        body: null,
      });

      await expect(
        connectHorizonLedgerStream(
          "https://horizon-test.example.com",
          "now",
          vi.fn(),
        ),
      ).rejects.toThrow(
        "Horizon SSE stream failed: https://horizon-test.example.com/ledgers?cursor=now&order=asc -> 502",
      );
    });
  });

  describe("Horizon Zod Validation", () => {
    describe("numericCoerce", () => {
      it("coerces valid numeric strings and numbers to number", () => {
        expect(numericCoerce.parse("100")).toBe(100);
        expect(numericCoerce.parse("0.25")).toBe(0.25);
        expect(numericCoerce.parse(42)).toBe(42);
      });

      it("rejects non-numeric strings, empty strings, and null", () => {
        expect(() => numericCoerce.parse("abc")).toThrow();
        expect(() => numericCoerce.parse("")).toThrow();
        expect(() => numericCoerce.parse(null)).toThrow();
      });
    });

    describe("Schema shapes", () => {
      it("validates HorizonLedgerRecordSchema", () => {
        const valid = {
          sequence: 12345,
          closed_at: "2026-09-02T12:00:00Z",
          successful_transaction_count: 50,
          failed_transaction_count: 2,
          operation_count: 100,
          tx_set_operation_count: 100,
          base_fee_in_stroops: 100,
          max_tx_set_size: 1000,
        };

        const result = HorizonLedgerRecordSchema.parse(valid);
        expect(result.sequence).toBe(12345);

        expect(() =>
          HorizonLedgerRecordSchema.parse({
            ...valid,
            sequence: "not-a-number",
          }),
        ).toThrow();
      });

      it("validates and coerces HorizonFeeStatsResponseSchema", () => {
        const validHorizonPayload = {
          last_ledger_base_fee: "100",
          ledger_capacity_usage: "0.15",
          fee_charged: {
            p10: "100",
            p50: "120",
            p90: "150",
            p99: "500",
          },
        };

        const parsed = HorizonFeeStatsResponseSchema.parse(validHorizonPayload);
        expect(parsed.last_ledger_base_fee).toBe(100);
        expect(parsed.ledger_capacity_usage).toBe(0.15);
        expect(parsed.fee_charged.p50).toBe(120);

        // Missing p50 field
        const missingField = {
          last_ledger_base_fee: "100",
          ledger_capacity_usage: "0.15",
          fee_charged: {
            p10: "100",
            p90: "150",
            p99: "500",
          },
        };
        expect(() =>
          HorizonFeeStatsResponseSchema.parse(missingField),
        ).toThrow();
      });

      it("validates HorizonOperationRecordSchema", () => {
        const valid = {
          id: "op-1",
          paging_token: "pt-1",
          transaction_successful: true,
          type: "invoke_host_function",
          created_at: "2026-09-02T12:00:00Z",
        };

        expect(HorizonOperationRecordSchema.parse(valid).type).toBe(
          "invoke_host_function",
        );
        expect(() =>
          HorizonOperationRecordSchema.parse({
            ...valid,
            transaction_successful: "true",
          }),
        ).toThrow();
      });
    });

    describe("API fetch functions with validation error reporting", () => {
      it("fetchFeeStats throws descriptive error on schema validation failure", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            last_ledger_base_fee: "100",
            ledger_capacity_usage: "0.20",
            fee_charged: {
              p10: "100",
              p90: "150",
              p99: "500",
            },
          }),
        });

        await expect(fetchFeeStats("https://horizon.test")).rejects.toThrow(
          /Horizon schema validation failed for \/fee_stats: fee_charged\.p50/,
        );
      });

      it("fetchRecentLedgers throws descriptive error on invalid record shape", async () => {
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            _embedded: {
              records: [
                {
                  sequence: "not-a-number",
                  closed_at: "2026-09-02T12:00:00Z",
                },
              ],
            },
          }),
        });

        await expect(
          fetchRecentLedgers(5, "https://horizon.test"),
        ).rejects.toThrow(
          /Horizon schema validation failed for \/ledgers\?order=desc&limit=5/,
        );
      });
    });
  });
});
