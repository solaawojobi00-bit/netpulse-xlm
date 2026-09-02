import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SorobanMetricsResponse } from "../api";
import { SorobanActivityChart } from "./SorobanActivityChart";

const mockSoroban: SorobanMetricsResponse = {
  network: "mainnet",
  invocationsPerSecond: 1.5,
  recentInvocationsTotal: 15,
  successfulInvocationsTotal: 12,
  failedInvocationsTotal: 3,
  samples: [
    {
      timestamp: "2026-09-02T12:00:00.000Z",
      invocationsCount: 5,
      successfulCount: 4,
      failedCount: 1,
    },
    {
      timestamp: "2026-09-02T12:00:10.000Z",
      invocationsCount: 10,
      successfulCount: 8,
      failedCount: 2,
    },
  ],
};

describe("SorobanActivityChart", () => {
  it("renders heading and empty note without throwing when soroban is null", () => {
    render(<SorobanActivityChart soroban={null} />);

    expect(screen.getByText("Soroban Contract Invocations")).toBeInTheDocument();
    expect(screen.getByText(/No Soroban smart contract invocations/i)).toBeInTheDocument();
  });

  it("renders metrics stats and heading with data", () => {
    render(<SorobanActivityChart soroban={mockSoroban} />);

    expect(screen.getByText("Soroban Contract Invocations")).toBeInTheDocument();
    expect(screen.getByText("1.5")).toBeInTheDocument();
    expect(screen.getByText(/15 total in window/i)).toBeInTheDocument();
  });
});
