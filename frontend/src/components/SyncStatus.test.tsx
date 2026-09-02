import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SyncStatus } from "./SyncStatus";

describe("SyncStatus", () => {
  it("renders null when lastUpdated is null", () => {
    const { container } = render(
      <SyncStatus lastUpdated={null} secondsSinceLastUpdate={null} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it("renders synced relative time with ok status indicator", () => {
    const lastUpdated = new Date().toISOString();
    const { container } = render(
      <SyncStatus
        lastUpdated={lastUpdated}
        secondsSinceLastUpdate={5}
        status="ok"
      />,
    );

    expect(screen.getByText(/Backend last synced with Horizon/i)).toBeInTheDocument();
    expect(screen.getByText(/synced 5s ago/i)).toBeInTheDocument();
    expect(container.querySelector(".sync-status--ok")).toBeInTheDocument();
    expect(container.querySelector(".sync-status--stale")).not.toBeInTheDocument();
  });

  it("visibly distinguishes stale status", () => {
    const lastUpdated = new Date(Date.now() - 120_000).toISOString();
    const { container } = render(
      <SyncStatus
        lastUpdated={lastUpdated}
        secondsSinceLastUpdate={120}
        status="stale"
      />,
    );

    expect(screen.getByText(/Backend sync is stale/i)).toBeInTheDocument();
    expect(screen.getByText(/synced 2m 0s ago/i)).toBeInTheDocument();
    expect(container.querySelector(".sync-status--stale")).toBeInTheDocument();
    expect(container.querySelector(".sync-status--ok")).not.toBeInTheDocument();
  });
});
