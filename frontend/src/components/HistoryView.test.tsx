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
    expect(screen.getByText(/Persistent Storage · 5m Aggregation/i)).toBeInTheDocument();
  });

  it("renders chart headings and subtitle when points are provided", () => {
    render(<HistoryView points={mockPoints} range="12h" />);

    expect(screen.getByText("12h Historical Trends")).toBeInTheDocument();
    expect(screen.getByText(/5m resolution · 7-day retention/i)).toBeInTheDocument();
    expect(screen.getByText("24h Ledger close time (avg seconds)")).toBeInTheDocument();
    expect(screen.getByText("24h Network congestion (capacity usage %)")).toBeInTheDocument();
  });
});
