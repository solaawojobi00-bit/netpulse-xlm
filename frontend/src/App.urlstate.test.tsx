/*
 * The URL contract for issue #43, tested through the real App rather than the
 * hook, because the thing being promised is "paste this link and get this
 * view" — which spans the hook, both controls, and the fetch calls they drive.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import type { HealthResponse } from "./api";

const fetchHistory = vi.fn();

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

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return { ...actual, fetchHistory: (...args: unknown[]) => fetchHistory(...args) };
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

function setUrl(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

beforeEach(() => {
  seenNetworks = [];
  fetchHistory.mockReset();
  fetchHistory.mockResolvedValue({ network: "mainnet", range: "24h", points: [] });
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
    expect(screen.getByRole("heading", { level: 1, name: "NetPulse" })).toBeInTheDocument();
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
    await waitFor(() => expect(fetchHistory).toHaveBeenCalledWith("testnet", "24h"));
  });

  it("writes the range to the URL and refetches history", async () => {
    render(<App />);

    await userEvent.click(screen.getByRole("button", { name: "6h" }));

    expect(new URLSearchParams(window.location.search).get("range")).toBe("6h");
    await waitFor(() => expect(fetchHistory).toHaveBeenCalledWith("mainnet", "6h"));
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
    expect(screen.getByRole("heading", { level: 1, name: "NetPulse" })).toBe(heading);
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
