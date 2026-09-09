/*
 * What the history and trends panels may show while a fetch for a *different*
 * range is still in flight (#150).
 *
 * App used to clear its history state from inside the effect that starts the
 * fetch. These tests pin the contract that replaced it: a fetched result is
 * tagged with the network and range it was fetched for, and is readable only
 * while that tag still matches the controls — so a series can never be shown
 * under a label it does not belong to, and a response for the range you just
 * left cannot land in the view.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { HealthResponse, HistoryPoint } from "./api";

const fetchHistory = vi.fn();
const fetchTrends = vi.fn();

vi.mock("./useSubscription", () => ({
  useSubscription: () => ({
    health,
    ledgers: [],
    feeSnapshots: [],
    soroban: null,
    operationBreakdown: null,
    error: null,
    isStreaming: true,
  }),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchHistory: (...args: unknown[]) => fetchHistory(...args),
    fetchTrends: (...args: unknown[]) => fetchTrends(...args),
  };
});

const health: HealthResponse = {
  status: "ok",
  lastUpdated: "2026-09-09T12:00:00.000Z",
  secondsSinceLastUpdate: 2,
  ledgerCloseTime: { currentSeconds: 5.2, averageSeconds: 5.4 },
  fees: { baseFeeStroops: 100, p10: 100, p50: 120, p90: 900, p99: 5000 },
  congestion: { ledgerCapacityUsage: 0.2, band: "low" },
  throughput: { operationsPerSecond: 40, transactionsPerSecond: 12 },
  recentLedgerCount: 12,
};

function points(count: number, operations: number): HistoryPoint[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 8, 9, 12, i * 5)).toISOString(),
    closeTimeSeconds: 5,
    congestionUsage: 0.2,
    operations,
    transactions: 10,
    p50Fee: 120,
    p90Fee: 900,
  }));
}

/*
 * The ready state renders this subtitle and the loading and error states do
 * not, which makes it the cleanest signal for "this panel is showing a
 * series" through jsdom — Recharts draws nothing at zero width, so the series
 * itself cannot be asserted through the DOM.
 */
const READY_SUBTITLE = /Coarser historical trend view/i;

/** A promise that never settles: a fetch still in flight. */
function pending<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

beforeEach(() => {
  fetchHistory.mockReset();
  fetchTrends.mockReset();
  fetchTrends.mockResolvedValue({
    network: "mainnet",
    range: "90d",
    points: [],
  });
  window.history.replaceState(null, "", "/");
});

afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.clearAllMocks();
});

describe("history results are scoped to the range they were fetched for", () => {
  it("shows the loading state, not the previous series, while a new range is in flight", async () => {
    const user = userEvent.setup();
    fetchHistory.mockImplementation((_network: string, range: string) =>
      range === "24h"
        ? Promise.resolve({ network: "mainnet", range, points: points(3, 500) })
        : pending(),
    );

    render(<App />);
    await waitFor(() =>
      expect(screen.getByText(READY_SUBTITLE)).toBeInTheDocument(),
    );
    expect(screen.getByText("24h Historical Trends")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "6h" }));

    /*
     * The heading has moved to 6h and the 6h fetch has not resolved, so the
     * panel must be back in its loading state. If the 24h points were still
     * readable here, this is where they would appear — a three-point series
     * sitting under a "6h" heading.
     */
    expect(screen.getByText("6h Historical Trends")).toBeInTheDocument();
    expect(screen.queryByText(READY_SUBTITLE)).not.toBeInTheDocument();
  });

  it("ignores a response for the range the user has already left", async () => {
    const user = userEvent.setup();
    let resolve24h: ((value: unknown) => void) | undefined;
    fetchHistory.mockImplementation((_network: string, range: string) =>
      range === "24h"
        ? new Promise((res) => {
            resolve24h = res;
          })
        : pending(),
    );

    render(<App />);
    await waitFor(() =>
      expect(fetchHistory).toHaveBeenCalledWith("mainnet", "24h"),
    );

    await user.click(screen.getByRole("button", { name: "6h" }));

    // The 24h request now comes back, after the switch it lost.
    resolve24h?.({ network: "mainnet", range: "24h", points: points(3, 500) });

    await waitFor(() =>
      expect(screen.getByText("6h Historical Trends")).toBeInTheDocument(),
    );
    expect(screen.queryByText(READY_SUBTITLE)).not.toBeInTheDocument();
  });

  /*
   * The counterpart to the rule above: within one range, a *failed refresh*
   * must not blank a series that was fine a moment ago. The tagged result
   * carries the previous points forward when the tag still matches, so the
   * error appears beside the last good data rather than instead of it.
   */
  it("keeps the last good series when a later refresh for the same range fails", async () => {
    fetchHistory
      .mockResolvedValueOnce({
        network: "mainnet",
        range: "24h",
        points: points(3, 500),
      })
      .mockRejectedValue(new Error("history endpoint down"));

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<App />);
      await waitFor(() =>
        expect(screen.getByText(READY_SUBTITLE)).toBeInTheDocument(),
      );

      // The 30s refresh interval fires and rejects.
      await vi.advanceTimersByTimeAsync(30000);
      await waitFor(() => expect(fetchHistory).toHaveBeenCalledTimes(2));

      // Still showing the series, under its own range, rather than blanking.
      expect(screen.getByText(READY_SUBTITLE)).toBeInTheDocument();
      expect(screen.getByText("24h Historical Trends")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
