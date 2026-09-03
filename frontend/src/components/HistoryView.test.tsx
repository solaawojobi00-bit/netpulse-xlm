import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HistoryPoint } from "../api";
import { HistoryView } from "./HistoryView";

const mockPoints: HistoryPoint[] = [
  {
    timestamp: "2026-09-02T12:00:00.000Z",
    closeTimeSeconds: 5.1,
    congestionUsage: 0.15,
    operations: 120,
    transactions: 35,
    p50Fee: 100,
    p90Fee: 150,
  },
  {
    timestamp: "2026-09-02T12:05:00.000Z",
    closeTimeSeconds: 5.4,
    congestionUsage: 0.22,
    operations: 150,
    transactions: 42,
    p50Fee: 100,
    p90Fee: 150,
  },
];

describe("HistoryView", () => {
  it("renders a sensible empty state when points array is empty", () => {
    render(<HistoryView points={[]} range="24h" />);

    expect(screen.getByText("24h Historical Trends")).toBeInTheDocument();
    expect(screen.getByText(/Historical trend data is accumulating/i)).toBeInTheDocument();
    // One badge in every state. The empty state used to say "Persistent
    // Storage · 5m Aggregation" while the loaded state said "5m resolution ·
    // 7-day retention" — two descriptions of the same store, for no reason.
    expect(screen.getByText(/5m resolution · 7-day retention/i)).toBeInTheDocument();
  });

  it("renders chart headings and subtitle when points are provided", () => {
    render(<HistoryView points={mockPoints} range="12h" />);

    expect(screen.getByText("12h Historical Trends")).toBeInTheDocument();
    expect(screen.getByText(/5m resolution · 7-day retention/i)).toBeInTheDocument();
    // Chart headings follow the range prop; they previously hardcoded "24h"
    // even when the section header said otherwise.
    expect(screen.getByText("12h Ledger close time (avg seconds)")).toBeInTheDocument();
    expect(screen.getByText("12h Network congestion (capacity usage %)")).toBeInTheDocument();
  });

  it("shows a loading state before the first fetch resolves", () => {
    render(<HistoryView points={null} range="24h" />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    // Not loaded is not the same as loaded-and-quiet.
    expect(screen.queryByText(/Historical trend data is accumulating/i)).not.toBeInTheDocument();
  });

  it("surfaces a failed history fetch instead of looking empty", () => {
    render(<HistoryView points={null} range="24h" error="Failed to fetch" />);

    expect(screen.getByText(/Could not load historical trends/i)).toBeInTheDocument();
    expect(screen.queryByText(/Historical trend data is accumulating/i)).not.toBeInTheDocument();
  });

  it("states only once that history failed, not once per chart", () => {
    render(<HistoryView points={null} range="24h" error="Failed to fetch" />);

    expect(screen.getAllByText(/Could not load historical trends/i)).toHaveLength(1);
  });

  it("keeps showing existing history when a later refresh fails", () => {
    // A refresh failing should not blank trends the user can still read.
    render(<HistoryView points={mockPoints} range="24h" error="Failed to fetch" />);

    expect(screen.getByText("24h Ledger close time (avg seconds)")).toBeInTheDocument();
    expect(screen.queryByText(/Could not load historical trends/i)).not.toBeInTheDocument();
  });
});
