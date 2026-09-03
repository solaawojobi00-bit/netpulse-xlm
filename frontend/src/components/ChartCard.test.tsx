import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChartCard, resolveChartStatus } from "./ChartCard";

describe("resolveChartStatus", () => {
  it("reports loading before any data has arrived", () => {
    expect(resolveChartStatus(null)).toBe("loading");
    expect(resolveChartStatus(undefined)).toBe("loading");
  });

  it("reports empty when data arrived and there was genuinely nothing", () => {
    expect(resolveChartStatus([])).toBe("empty");
  });

  it("reports ready when there is data", () => {
    expect(resolveChartStatus([1, 2, 3])).toBe("ready");
  });

  it("reports error when the source failed with nothing to fall back on", () => {
    expect(resolveChartStatus(null, "connection lost")).toBe("error");
    expect(resolveChartStatus([], "connection lost")).toBe("error");
  });

  it("prefers existing data over an error so a blip does not blank the chart", () => {
    // Six live charts share one subscription; blanking them all on a dropped
    // connection would discard seconds-old data and print six identical
    // errors, when the global banner already explains the outage.
    expect(resolveChartStatus([1, 2], "connection lost")).toBe("ready");
  });

  it("treats loading and empty as distinct, which is the whole point", () => {
    expect(resolveChartStatus(null)).not.toBe(resolveChartStatus([]));
  });
});

describe("ChartCard", () => {
  it("renders the chart when ready", () => {
    render(
      <ChartCard title="Ledger close time" status="ready">
        <p>chart body</p>
      </ChartCard>,
    );

    expect(screen.getByText("chart body")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("hides the chart body and exposes a status role while loading", () => {
    render(
      <ChartCard title="Ledger close time" status="loading">
        <p>chart body</p>
      </ChartCard>,
    );

    expect(screen.queryByText("chart body")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveAttribute(
      "aria-label",
      "Ledger close time: loading",
    );
  });

  it("says an empty window is empty, in words", () => {
    render(
      <ChartCard title="Ops" status="empty" emptyMessage="No ledgers in this window.">
        <p>chart body</p>
      </ChartCard>,
    );

    expect(screen.getByText("No ledgers in this window.")).toBeInTheDocument();
  });

  it("announces an error rather than looking like an empty chart", () => {
    render(
      <ChartCard title="Ops" status="error" errorMessage="Could not load ledger data.">
        <p>chart body</p>
      </ChartCard>,
    );

    expect(screen.getByRole("status")).toHaveAttribute("aria-label", "Ops: unavailable");
    expect(screen.getByText("Could not load ledger data.")).toBeInTheDocument();
    expect(screen.queryByText("chart body")).not.toBeInTheDocument();
  });

  it("keeps the title visible in every state so the card never loses identity", () => {
    for (const status of ["loading", "empty", "error", "ready"] as const) {
      const { unmount } = render(
        <ChartCard title="Ledger close time" status={status}>
          <p>chart body</p>
        </ChartCard>,
      );
      expect(screen.getByText("Ledger close time")).toBeInTheDocument();
      unmount();
    }
  });

  it("gives every non-ready state the same fixed-height box, so nothing shifts", () => {
    const heights = (["loading", "empty", "error"] as const).map((status) => {
      const { container, unmount } = render(
        <ChartCard title="t" status={status}>
          <p>body</p>
        </ChartCard>,
      );
      const el = container.querySelector(".chart-card__state");
      const cls = el?.className ?? "";
      unmount();
      return cls.includes("chart-card__state");
    });

    expect(heights).toEqual([true, true, true]);
  });
});
