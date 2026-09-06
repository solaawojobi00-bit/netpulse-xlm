/*
 * The URL contract for issue #43, tested through the real App rather than the
 * hook, because the thing being promised is "paste this link and get this
 * view" — which spans the hook, both controls, and the fetch calls they drive.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { HealthResponse, TrendPoint } from "./api";

const fetchHistory = vi.fn();
const fetchTrends = vi.fn();

vi.mock("./useSubscription", () => ({
  useSubscription: (network: string) => {
    seenNetworks.push(network);
    return {
      health,
      ledgers: [],
      feeSnapshots: [],
      soroban: null,
      error: null,
      isStreaming: true,
    };
  },
}));

// `fetchTrends` is stubbed alongside `fetchHistory` for the same reason: the
// spread keeps the real implementation, which would reach the network.
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchHistory: (...args: unknown[]) => fetchHistory(...args),
    fetchTrends: (...args: unknown[]) => fetchTrends(...args),
  };
});

let seenNetworks: string[] = [];

const health: HealthResponse = {
  status: "ok",
  lastUpdated: "2026-09-03T12:00:00.000Z",
  secondsSinceLastUpdate: 2,
  ledgerCloseTime: { currentSeconds: 5.2, averageSeconds: 5.4 },
  fees: { baseFeeStroops: 100, p10: 100, p50: 120, p90: 900, p99: 5000 },
  congestion: { ledgerCapacityUsage: 0.2, band: "low" },
  throughput: { operationsPerSecond: 40, transactionsPerSecond: 12 },
  recentLedgerCount: 0,
};

const trendPoints: TrendPoint[] = Array.from({ length: 3 }, (_, i) => ({
  date: `2026-01-0${i + 1}`,
  closeTimeSeconds: 5 + i * 0.2,
  congestionUsage: 0.3,
  maxCongestionUsage: 0.6,
  operations: 500,
  successfulTransactions: 200,
  failedTransactions: 2,
  p50Fee: 120,
  p90Fee: 900,
}));

function setUrl(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

beforeEach(() => {
  seenNetworks = [];
  fetchHistory.mockReset();
  fetchHistory.mockResolvedValue({
    network: "mainnet",
    range: "24h",
    points: [],
  });
  fetchTrends.mockReset();
  fetchTrends.mockResolvedValue({
    network: "mainnet",
    range: "90d",
    points: [],
  });
  setUrl("");
});

afterEach(() => {
  setUrl("");
  vi.clearAllMocks();
});

describe("view state in the URL", () => {
  it("loads the view the URL describes, with no flash of the default", () => {
    setUrl("?network=testnet&range=6h");
    render(<App />);

    // Asserted synchronously after the first render: if the default view were
    // painted first and corrected in an effect, mainnet would appear here.
    expect(screen.getByRole("button", { name: "Testnet" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "6h" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("6h Historical Trends")).toBeInTheDocument();

    // The very first subscription and fetch used the URL's values, so no
    // request was ever made against the default.
    expect(seenNetworks[0]).toBe("testnet");
    expect(fetchHistory).toHaveBeenCalledWith("testnet", "6h");
    expect(fetchHistory).not.toHaveBeenCalledWith("mainnet", "24h");
  });

  it("defaults cleanly when no params are present", () => {
    render(<App />);

    expect(screen.getByRole("button", { name: "Mainnet" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(fetchHistory).toHaveBeenCalledWith("mainnet", "24h");
  });

  it.each([
    "?network=mars&range=99h",
    "?network=&range=",
    "?network[]=testnet",
  ])("survives a hand-edited URL (%s) without breaking the page", (search) => {
    setUrl(search);
    render(<App />);

    // Renders, does not throw, and lands on the defaults.
    expect(
      screen.getByRole("heading", { level: 1, name: "NetPulse" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mainnet" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "24h" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("writes the network to the URL when the selector changes", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Testnet" }));

    expect(window.location.search).toBe("?network=testnet");
    await waitFor(() =>
      expect(fetchHistory).toHaveBeenCalledWith("testnet", "24h"),
    );
  });

  it("writes the range to the URL and refetches history", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "6h" }));

    expect(new URLSearchParams(window.location.search).get("range")).toBe("6h");
    await waitFor(() =>
      expect(fetchHistory).toHaveBeenCalledWith("mainnet", "6h"),
    );
    expect(screen.getByText("6h Historical Trends")).toBeInTheDocument();
  });

  it("keeps both params in the URL when both are changed", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Testnet" }));
    await userEvent.click(screen.getByRole("button", { name: "12h" }));

    const params = new URLSearchParams(window.location.search);
    expect(params.get("network")).toBe("testnet");
    expect(params.get("range")).toBe("12h");
  });

  it("does not reload the page when a param changes", async () => {
    render(<App />);
    // A reload would tear down the tree; holding a node across the change is
    // enough to show it survived.
    const heading = screen.getByRole("heading", { level: 1, name: "NetPulse" });

    await userEvent.click(screen.getByRole("button", { name: "Testnet" }));

    expect(heading).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "NetPulse" })).toBe(
      heading,
    );
  });

  it("does not pile up history entries as the user toggles", async () => {
    render(<App />);
    const before = window.history.length;

    await userEvent.click(screen.getByRole("button", { name: "Testnet" }));
    await userEvent.click(screen.getByRole("button", { name: "6h" }));
    await userEvent.click(screen.getByRole("button", { name: "Mainnet" }));

    // replaceState: Back leaves the dashboard rather than stepping back
    // through three filter changes.
    expect(window.history.length).toBe(before);
  });

  it("follows the address bar on back/forward", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Testnet" }));
    expect(screen.getByRole("button", { name: "Testnet" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // Simulate arriving back at a URL without the param.
    setUrl("");
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Mainnet" })).toHaveAttribute(
        "aria-pressed",
        "true",
      ),
    );
  });
});

/*
 * `trendRange` is a third, independent parameter rather than a second reader of
 * `range`. The two selectors offer disjoint values (6h/12h/24h against
 * 30d/90d/1y), so every assertion below can address a button by its label
 * without ambiguity.
 */
describe("the trend range in the URL", () => {
  it("paints the range the URL describes, with no flash of the 90d default", () => {
    setUrl("?trendRange=1y");
    render(<App />);

    // Synchronous, as with network and range above: a default painted first and
    // corrected in an effect would show 90d here.
    expect(screen.getByRole("button", { name: "1y" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("1y Long-Range Trends")).toBeInTheDocument();
    expect(fetchTrends).toHaveBeenCalledWith("mainnet", "1y");
    expect(fetchTrends).not.toHaveBeenCalledWith("mainnet", "90d");
  });

  it.each(["?trendRange=5y", "?trendRange=", "?trendRange[]=1y"])(
    "falls back to 90d on a hand-edited URL (%s) without throwing",
    (search) => {
      setUrl(search);
      render(<App />);

      expect(screen.getByRole("button", { name: "90d" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(fetchTrends).toHaveBeenCalledWith("mainnet", "90d");
    },
  );

  it("writes the trend range to the URL and refetches trends", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "1y" }));

    expect(new URLSearchParams(window.location.search).get("trendRange")).toBe(
      "1y",
    );
    await waitFor(() =>
      expect(fetchTrends).toHaveBeenCalledWith("mainnet", "1y"),
    );
    expect(screen.getByText("1y Long-Range Trends")).toBeInTheDocument();
  });

  it("coexists with network and range, and changing one preserves the others", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "Testnet" }));
    await userEvent.click(screen.getByRole("button", { name: "6h" }));
    await userEvent.click(screen.getByRole("button", { name: "30d" }));

    const params = new URLSearchParams(window.location.search);
    expect(params.get("network")).toBe("testnet");
    expect(params.get("range")).toBe("6h");
    expect(params.get("trendRange")).toBe("30d");

    // The history view kept its own range rather than following the trend one.
    expect(screen.getByText("6h Historical Trends")).toBeInTheDocument();
    expect(screen.getByText("30d Long-Range Trends")).toBeInTheDocument();
  });

  it("does not reload the page when the trend range changes", async () => {
    render(<App />);
    const heading = screen.getByRole("heading", { level: 1, name: "NetPulse" });

    await userEvent.click(screen.getByRole("button", { name: "1y" }));

    expect(screen.getByRole("heading", { level: 1, name: "NetPulse" })).toBe(
      heading,
    );
  });

  it("refetches trends and drops the previous points when the network changes", async () => {
    fetchTrends.mockResolvedValueOnce({
      network: "mainnet",
      range: "90d",
      points: trendPoints,
    });
    render(<App />);
    await screen.findByRole("img", { name: /90d Daily ledger close time/ });

    // The refetch never settles, which holds the panel in the state it enters
    // on a network change — the assertion would be racy against a resolved one.
    fetchTrends.mockReturnValueOnce(new Promise(() => {}));
    await userEvent.click(screen.getByRole("button", { name: "Testnet" }));

    expect(fetchTrends).toHaveBeenCalledWith("testnet", "90d");
    // Mainnet's series is gone rather than sitting under a testnet heading.
    expect(
      screen.queryByRole("img", { name: /90d Daily ledger close time/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("status", { name: "90d trends: loading" }),
    ).toBeInTheDocument();
  });

  it("polls trends every five minutes, not at history's 30s, and stops on unmount", () => {
    vi.useFakeTimers();
    try {
      const { unmount } = render(<App />);
      expect(fetchTrends).toHaveBeenCalledTimes(1);

      // History has polled ten times by now; trends must not have.
      act(() => void vi.advanceTimersByTime(299000));
      expect(fetchHistory.mock.calls.length).toBeGreaterThan(1);
      expect(fetchTrends).toHaveBeenCalledTimes(1);

      act(() => void vi.advanceTimersByTime(1000));
      expect(fetchTrends).toHaveBeenCalledTimes(2);

      unmount();
      act(() => void vi.advanceTimersByTime(900000));
      expect(fetchTrends).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves history and the live charts untouched when the trends fetch fails", async () => {
    fetchTrends.mockRejectedValue(new Error("GET /api/trends failed: 500"));
    fetchHistory.mockResolvedValue({
      network: "mainnet",
      range: "24h",
      points: [],
    });
    render(<App />);

    await screen.findByRole("status", { name: "90d trends: unavailable" });

    // The panels either side of the failure are still their own selves.
    expect(screen.getByText("24h Historical Trends")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "NetPulse" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mainnet" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
