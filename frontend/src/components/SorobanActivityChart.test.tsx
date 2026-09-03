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
  it("shows a loading state, not an empty note, when metrics have not arrived", () => {
    // null means the metrics have not loaded. Claiming "no invocations" here
    // would report a quiet network we have not actually observed.
    render(<SorobanActivityChart soroban={null} />);

    expect(screen.getByText("Soroban Contract Invocations")).toBeInTheDocument();
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.queryByText(/No Soroban smart contract invocations/i)).not.toBeInTheDocument();
  });

  it("reports a genuinely quiet window as empty once metrics have arrived", () => {
    render(
      <SorobanActivityChart
        soroban={{
          network: "mainnet",
          invocationsPerSecond: 0,
          recentInvocationsTotal: 0,
          successfulInvocationsTotal: 0,
          failedInvocationsTotal: 0,
          samples: [],
        }}
      />,
    );

    expect(screen.getByText(/No Soroban smart contract invocations/i)).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("surfaces an error when metrics failed and nothing was ever loaded", () => {
    render(<SorobanActivityChart soroban={null} error="connection lost" />);

    expect(screen.getByText(/Could not load Soroban metrics/i)).toBeInTheDocument();
  });

  it("renders metrics stats and heading with data", () => {
    render(<SorobanActivityChart soroban={mockSoroban} />);

    expect(screen.getByText("Soroban Contract Invocations")).toBeInTheDocument();
    expect(screen.getByText("1.5")).toBeInTheDocument();
    expect(screen.getByText(/15 total in window/i)).toBeInTheDocument();
  });
});
