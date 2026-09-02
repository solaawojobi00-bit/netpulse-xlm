import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchFeeStats,
  fetchRecentLedgers,
  fetchRecentOperations,
  HorizonFeeStatsResponseSchema,
  HorizonLedgerRecordSchema,
  HorizonLedgersResponseSchema,
  HorizonOperationRecordSchema,
  numericCoerce,
} from "./horizon.js";

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
        HorizonLedgerRecordSchema.parse({ ...valid, sequence: "not-a-number" }),
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
      expect(() => HorizonFeeStatsResponseSchema.parse(missingField)).toThrow();
    });

    it("validates HorizonOperationRecordSchema", () => {
      const valid = {
        id: "op-1",
        paging_token: "pt-1",
        transaction_successful: true,
        type: "invoke_host_function",
        created_at: "2026-09-02T12:00:00Z",
      };

      expect(HorizonOperationRecordSchema.parse(valid).type).toBe("invoke_host_function");
      expect(() => HorizonOperationRecordSchema.parse({ ...valid, transaction_successful: "true" })).toThrow();
    });
  });

  describe("API fetch functions with validation error reporting", () => {
    const originalFetch = globalThis.fetch;

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it("fetchFeeStats throws descriptive error on schema validation failure", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          last_ledger_base_fee: "100",
          ledger_capacity_usage: "0.20",
          fee_charged: {
            p10: "100",
            // p50 is missing!
            p90: "150",
            p99: "500",
          },
        }),
      } as Response);

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
      } as Response);

      await expect(fetchRecentLedgers(5, "https://horizon.test")).rejects.toThrow(
        /Horizon schema validation failed for \/ledgers\?order=desc&limit=5/,
      );
    });
  });
});
