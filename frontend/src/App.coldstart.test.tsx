/*
 * The cold-start notice, tested through the real App rather than the hook,
 * because the promise in #196 is about what a visitor sees on the page: a
 * sleeping backend explains itself, and a healthy one never mentions it.
 *
 * The hook's own boundaries and clearing behaviour are covered in
 * useSlowStart.test.ts; this file is about the wiring and the copy.
 */
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { HealthResponse } from "./api";
import { SLOW_START_AFTER_MS } from "./useSlowStart";

let subscription: {
  health: HealthResponse | null;
  error: string | null;
};

vi.mock("./useSubscription", () => ({
  useSubscription: () => ({
    ledgers: null,
    feeSnapshots: null,
    soroban: null,
    operationBreakdown: null,
    isStreaming: false,
    ...subscription,
  }),
}));

// Left unresolved on purpose: a cold start is precisely the case where these
// requests are held open rather than failing, so resolving or rejecting them
// would model the wrong thing.
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchHistory: () => new Promise(() => {}),
    fetchTrends: () => new Promise(() => {}),
  };
});

const health: HealthResponse = {
  status: "ok",
  lastUpdated: "2026-09-12T12:00:00.000Z",
  secondsSinceLastUpdate: 2,
  ledgerCloseTime: { currentSeconds: 5, averageSeconds: 5 },
  fees: { baseFeeStroops: 100, p10: 100, p50: 100, p90: 200, p99: 300 },
  congestion: { ledgerCapacityUsage: 0.2, band: "low" },
  throughput: { operationsPerSecond: 12, transactionsPerSecond: 4 },
  recentLedgerCount: 30,
};

const NOTICE = /waking the backend up/i;

beforeEach(() => {
  vi.useFakeTimers();
  subscription = { health: null, error: null };
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("cold-start notice", () => {
  it("explains the wait once a first load takes too long", () => {
    render(<App />);
    expect(screen.queryByText(NOTICE)).toBeNull();

    advance(SLOW_START_AFTER_MS);

    const notice = screen.getByText(NOTICE);
    expect(notice).toBeInTheDocument();
    // Polite, like the two banners it sits above: the dashboard recovers on its
    // own, so interrupting whatever the visitor is reading would be wrong.
    expect(notice).toHaveAttribute("role", "status");
  });

  it("says nothing when data arrives promptly", () => {
    subscription = { health, error: null };
    render(<App />);

    advance(SLOW_START_AFTER_MS * 2);

    expect(screen.queryByText(NOTICE)).toBeNull();
  });

  it("defers to the unreachable banner rather than showing both", () => {
    subscription = { health: null, error: "Failed to fetch" };
    render(<App />);

    advance(SLOW_START_AFTER_MS * 2);

    expect(screen.queryByText(NOTICE)).toBeNull();
    expect(
      screen.getByText(/unable to reach the netpulse backend/i),
    ).toBeInTheDocument();
  });
});
