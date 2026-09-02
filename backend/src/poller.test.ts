import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeeSnapshot, LedgerSample } from "./types.js";
import type { HorizonLedgerRecord } from "./horizon.js";

// Mock horizon module before importing poller
const mockConnectHorizonLedgerStream = vi.fn();
const mockFetchRecentLedgers = vi.fn();
const mockFetchFeeStats = vi.fn();

vi.mock("./horizon.js", async () => {
  const actual = await vi.importActual<typeof import("./horizon.js")>("./horizon.js");
  return {
    ...actual,
    fetchRecentLedgers: (...args: any[]) => mockFetchRecentLedgers(...args),
    fetchFeeStats: (...args: any[]) => mockFetchFeeStats(...args),
    connectHorizonLedgerStream: (...args: any[]) => mockConnectHorizonLedgerStream(...args),
  };
});

import { startStreamForNetwork, stores } from "./poller.js";

describe("Poller SSE Reconnect and Backoff Unit Tests", () => {
  let controller: AbortController;

  const mockLedger = (seq: number, closedAt: string = "2026-09-02T12:00:00Z"): LedgerSample => ({
    sequence: seq,
    closedAt,
    closeTimeSeconds: 5.0,
    successfulTransactionCount: 10,
    failedTransactionCount: 0,
    operationCount: 20,
    txSetOperationCount: 20,
    baseFeeInStroops: 100,
    maxTxSetSize: 1000,
  });

  const mockFee = (): FeeSnapshot => ({
    fetchedAt: "2026-09-02T12:00:00Z",
    lastLedgerBaseFee: 100,
    ledgerCapacityUsage: 0.1,
    feeChargedP10: 100,
    feeChargedP50: 100,
    feeChargedP90: 150,
    feeChargedP99: 500,
  });

  const resetStore = (network: "mainnet" | "testnet" = "mainnet") => {
    const s = stores[network] as any;
    s.ledgers = [];
    s.feeSnapshots = [];
    s.sorobanSamples = [];
    s.lastSuccessAt = null;
    s.lastErrorMessage = null;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    controller = new AbortController();
    resetStore("mainnet");
    resetStore("testnet");

    mockFetchRecentLedgers.mockReset().mockResolvedValue([mockLedger(100)]);
    mockFetchFeeStats.mockReset().mockResolvedValue(mockFee());
    mockConnectHorizonLedgerStream.mockReset();
  });

  afterEach(async () => {
    controller.abort();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("Backoff growth and ceiling", () => {
    it("doubles backoff delay on successive failures: 1s, 2s, 4s, ..., and caps at 30s", async () => {
      const scheduledDelays: number[] = [];
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      mockConnectHorizonLedgerStream.mockRejectedValue(new Error("Stream drop"));

      const streamPromise = startStreamForNetwork("mainnet", controller.signal);

      // We expect backoff delays: 1s, 2s, 4s, 8s, 16s, 30s, 30s
      const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];

      for (const delay of expectedDelays) {
        // Wait for next scheduled timer
        await vi.advanceTimersByTimeAsync(delay);
      }

      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      await streamPromise;

      const backoffCalls = setTimeoutSpy.mock.calls
        .map((call) => call[1])
        .filter((d): d is number => typeof d === "number" && d >= 1000);

      expect(backoffCalls.slice(0, 7)).toEqual(expectedDelays);
    });
  });

  describe("Backoff reset", () => {
    it("resets backoff to 1s after receiving a ledger on the stream", async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

      let callCount = 0;
      mockConnectHorizonLedgerStream.mockImplementation(async (_url, _cursor, onLedger) => {
        callCount++;
        if (callCount === 1) {
          // First failure: backoff will be 1000ms -> next 2000ms
          throw new Error("Drop 1");
        } else if (callCount === 2) {
          // Second failure: backoff will be 2000ms -> next 4000ms
          throw new Error("Drop 2");
        } else if (callCount === 3) {
          // Success: receive a ledger, then throw
          const record: HorizonLedgerRecord = {
            sequence: 101,
            closed_at: "2026-09-02T12:00:05Z",
            successful_transaction_count: 5,
            failed_transaction_count: 0,
            operation_count: 10,
            tx_set_operation_count: 10,
            base_fee_in_stroops: 100,
            max_tx_set_size: 1000,
          };
          onLedger(record);
          throw new Error("Drop 3 after success");
        } else {
          // Fourth failure: delay should have been reset to 1000ms!
          throw new Error("Drop 4");
        }
      });

      const streamPromise = startStreamForNetwork("mainnet", controller.signal);

      // Call 1 failure -> wait 1000ms
      await vi.advanceTimersByTimeAsync(1000);
      // Call 2 failure -> wait 2000ms
      await vi.advanceTimersByTimeAsync(2000);
      // Call 3 received ledger, then failed -> delay was reset to 1000ms!
      await vi.advanceTimersByTimeAsync(1000);

      controller.abort();
      await vi.advanceTimersByTimeAsync(1);
      await streamPromise;

      const backoffCalls = setTimeoutSpy.mock.calls
        .map((call) => call[1])
        .filter((d): d is number => typeof d === "number" && d >= 1000);

      expect(backoffCalls.slice(0, 3)).toEqual([1000, 2000, 1000]);
    });
  });

  describe("Cursor derivation and resume", () => {
    it("derives initial cursor from newest warm-up ledger sequence", async () => {
      mockFetchRecentLedgers.mockResolvedValue([mockLedger(100), mockLedger(105)]);

      mockConnectHorizonLedgerStream.mockImplementation(async () => {
        controller.abort();
      });

      await startStreamForNetwork("mainnet", controller.signal);

      expect(mockConnectHorizonLedgerStream).toHaveBeenCalledWith(
        expect.any(String),
        "105",
        expect.any(Function),
        controller.signal,
      );
    });

    it("falls back to 'now' when warm-up produces no ledgers", async () => {
      mockFetchRecentLedgers.mockResolvedValue([]);

      mockConnectHorizonLedgerStream.mockImplementation(async () => {
        controller.abort();
      });

      await startStreamForNetwork("mainnet", controller.signal);

      expect(mockConnectHorizonLedgerStream).toHaveBeenCalledWith(
        expect.any(String),
        "now",
        expect.any(Function),
        controller.signal,
      );
    });

    it("resumes from paging_token or sequence of last-seen ledger after reconnect", async () => {
      const cursorsPassed: string[] = [];

      mockFetchRecentLedgers.mockResolvedValue([mockLedger(200)]);

      let iteration = 0;
      mockConnectHorizonLedgerStream.mockImplementation(async (_url, cursor, onLedger) => {
        cursorsPassed.push(cursor);
        iteration++;
        if (iteration === 1) {
          // First stream receives a record with paging_token
          onLedger({
            sequence: 201,
            paging_token: "token-201",
            closed_at: "2026-09-02T12:00:05Z",
            successful_transaction_count: 5,
            failed_transaction_count: 0,
            operation_count: 10,
            tx_set_operation_count: 10,
            base_fee_in_stroops: 100,
            max_tx_set_size: 1000,
          });
          throw new Error("Disconnect 1");
        } else if (iteration === 2) {
          // Second stream receives record without paging_token (fallback to sequence)
          onLedger({
            sequence: 202,
            closed_at: "2026-09-02T12:00:10Z",
            successful_transaction_count: 8,
            failed_transaction_count: 0,
            operation_count: 12,
            tx_set_operation_count: 12,
            base_fee_in_stroops: 100,
            max_tx_set_size: 1000,
          });
          throw new Error("Disconnect 2");
        } else {
          controller.abort();
        }
      });

      const streamPromise = startStreamForNetwork("mainnet", controller.signal);

      // Reconnect after first drop
      await vi.advanceTimersByTimeAsync(1000);
      // Reconnect after second drop
      await vi.advanceTimersByTimeAsync(1000);

      await streamPromise;

      expect(cursorsPassed).toEqual(["200", "token-201", "202"]);
    });
  });

  describe("Abort handling", () => {
    it("exits the loop and stops scheduling reconnects while waiting out backoff delay", async () => {
      mockConnectHorizonLedgerStream.mockRejectedValue(new Error("Disconnect"));

      const streamPromise = startStreamForNetwork("mainnet", controller.signal);

      // Let initial failure occur and enter backoff sleep
      await vi.advanceTimersByTimeAsync(10);

      // Abort during the backoff delay
      controller.abort();

      await vi.advanceTimersByTimeAsync(1000);
      await streamPromise;

      // Stream should not have reconnected after abort
      expect(mockConnectHorizonLedgerStream).toHaveBeenCalledTimes(1);
    });
  });

  describe("Warm-up failure handling", () => {
    it("records error on store when warm-up fails but still proceeds to start stream", async () => {
      mockFetchRecentLedgers.mockRejectedValue(new Error("Warm-up failed"));

      mockConnectHorizonLedgerStream.mockImplementation(async () => {
        controller.abort();
      });

      await startStreamForNetwork("mainnet", controller.signal);

      expect(stores.mainnet.getLastErrorMessage()).toBe("Warm-up failed");
      expect(mockConnectHorizonLedgerStream).toHaveBeenCalledWith(
        expect.any(String),
        "now",
        expect.any(Function),
        controller.signal,
      );
    });
  });
});
