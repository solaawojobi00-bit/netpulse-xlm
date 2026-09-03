import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OperationBreakdownResponse } from "../api";
import { OperationTypeChart } from "./OperationTypeChart";

function breakdown(
  rows: { type: string; count: number; isOther?: boolean }[],
  overrides: Partial<OperationBreakdownResponse> = {},
): OperationBreakdownResponse {
  const totalOperations = rows.reduce((acc, r) => acc + r.count, 0);
  return {
    network: "mainnet",
    sampleCount: 4,
    windowSeconds: 120,
    totalOperations,
    distinctTypes: rows.length,
    breakdown: rows.map((r) => ({
      type: r.type,
      count: r.count,
      share: totalOperations > 0 ? r.count / totalOperations : 0,
      isOther: r.isOther ?? false,
    })),
    ...overrides,
  };
}

describe("OperationTypeChart", () => {
  it("labels the figure as a sample over a window, not a total", () => {
    render(
      <OperationTypeChart
        breakdown={breakdown([{ type: "payment", count: 90 }, { type: "change_trust", count: 10 }])}
      />,
    );

    // "100 operations" alone invites being read as per-ledger or all-time.
    expect(screen.getByText(/100 operations sampled over the last 2m/)).toBeInTheDocument();
  });

  it("names each type in the chart's accessible description with its share", () => {
    render(
      <OperationTypeChart
        breakdown={breakdown([
          { type: "payment", count: 75 },
          { type: "path_payment_strict_send", count: 25 },
        ])}
      />,
    );

    const name = screen.getByRole("img").getAttribute("aria-label") ?? "";

    expect(name).toContain("Operation types");
    expect(name).toContain("Payment 75 (75%)");
    // Humanized, not the raw Horizon identifier.
    expect(name).toContain("Path payment (strict send) 25 (25%)");
    expect(name).not.toContain("path_payment_strict_send");
  });

  it("describes the grouped tail as a bucket rather than a type", () => {
    render(
      <OperationTypeChart
        breakdown={breakdown([
          { type: "payment", count: 90 },
          { type: "other", count: 10, isOther: true },
        ])}
      />,
    );

    expect(screen.getByRole("img").getAttribute("aria-label")).toContain("Other types 10");
  });

  it("renders a type it has never heard of readably", () => {
    render(
      <OperationTypeChart
        breakdown={breakdown([{ type: "some_future_operation", count: 5 }])}
      />,
    );

    const name = screen.getByRole("img").getAttribute("aria-label") ?? "";
    expect(name).toContain("Some future operation 5");
  });

  it("says a quiet window is quiet instead of drawing an empty axis", () => {
    render(<OperationTypeChart breakdown={breakdown([], { distinctTypes: 0 })} />);

    expect(screen.getByText("No operations in the recent sample window.")).toBeInTheDocument();
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("distinguishes not-yet-loaded from a genuinely quiet window", () => {
    render(<OperationTypeChart breakdown={null} />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(
      screen.queryByText("No operations in the recent sample window."),
    ).not.toBeInTheDocument();
  });

  it("reports a cold-start failure rather than looking empty", () => {
    render(<OperationTypeChart breakdown={null} error="backend unreachable" />);

    expect(screen.getByText("Could not load the operation breakdown.")).toBeInTheDocument();
  });

  it("keeps showing a breakdown that already arrived when a refresh fails", () => {
    render(
      <OperationTypeChart
        breakdown={breakdown([{ type: "payment", count: 10 }])}
        error="backend unreachable"
      />,
    );

    // Same precedence as every other chart: existing data beats a transient error.
    expect(screen.getByRole("img")).toBeInTheDocument();
    expect(
      screen.queryByText("Could not load the operation breakdown."),
    ).not.toBeInTheDocument();
  });

  it("mentions how many distinct types were seen when the tail is grouped", () => {
    render(
      <OperationTypeChart
        breakdown={breakdown(
          [
            { type: "payment", count: 50 },
            { type: "other", count: 50, isOther: true },
          ],
          { distinctTypes: 12 },
        )}
      />,
    );

    expect(screen.getByText(/12 types seen/)).toBeInTheDocument();
  });
});
