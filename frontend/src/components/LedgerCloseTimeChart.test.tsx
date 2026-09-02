import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LedgerSample } from "../api";
import { LedgerCloseTimeChart } from "./LedgerCloseTimeChart";

const mockLedgers: LedgerSample[] = [
  {
    sequence: 1001,
    closedAt: "2026-09-02T12:00:00.000Z",
    closeTimeSeconds: 5.2,
    successfulTransactionCount: 20,
    failedTransactionCount: 1,
    operationCount: 50,
    txSetOperationCount: 50,
    baseFeeInStroops: 100,
    maxTxSetSize: 1000,
  },
  {
    sequence: 1002,
    closedAt: "2026-09-02T12:00:05.000Z",
    closeTimeSeconds: 4.9,
    successfulTransactionCount: 25,
    failedTransactionCount: 0,
    operationCount: 65,
    txSetOperationCount: 65,
    baseFeeInStroops: 100,
    maxTxSetSize: 1000,
  },
];

describe("LedgerCloseTimeChart", () => {
  it("renders heading without throwing on empty array", () => {
    render(<LedgerCloseTimeChart ledgers={[]} />);
    expect(screen.getByText("Ledger close time")).toBeInTheDocument();
  });

  it("renders heading and chart container with ledger samples", () => {
    const { container } = render(<LedgerCloseTimeChart ledgers={mockLedgers} />);
    expect(screen.getByText("Ledger close time")).toBeInTheDocument();
    expect(container.querySelector(".chart-card")).toBeInTheDocument();
  });
});
