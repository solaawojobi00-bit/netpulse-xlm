import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyncStatus } from "./SyncStatus";

/*
 * The key App gives this component, kept in one place so the tests below
 * exercise the real remount trigger rather than an approximation of it.
 * See the comment beside <SyncStatus> in App.tsx.
 */
function keyFor(lastUpdated: string | null, seconds: number | null) {
  return `${lastUpdated ?? ""}|${seconds ?? ""}`;
}

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

    expect(
      screen.getByText(/Backend last synced with Horizon/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/synced 5s ago/i)).toBeInTheDocument();
    expect(container.querySelector(".sync-status--ok")).toBeInTheDocument();
    expect(
      container.querySelector(".sync-status--stale"),
    ).not.toBeInTheDocument();
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

  /*
   * The clock contract, which #150 changed the mechanics of without changing
   * the behaviour: the count ticks locally between readings, and re-anchors to
   * the backend's own number whenever a new reading lands. It used to re-base
   * from an effect — one committed render *after* the render that already had
   * the new props — and now re-anchors by remounting on the key App supplies.
   */
  describe("clock anchoring", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("ticks locally between readings", () => {
      vi.useFakeTimers();
      const lastUpdated = new Date().toISOString();

      render(
        <SyncStatus
          key={keyFor(lastUpdated, 5)}
          lastUpdated={lastUpdated}
          secondsSinceLastUpdate={5}
        />,
      );

      expect(screen.getByText(/synced 5s ago/i)).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(3000);
      });

      // The backend has said nothing new; the local tick carries the count.
      expect(screen.getByText(/synced 8s ago/i)).toBeInTheDocument();
    });

    it("re-anchors to the backend's count when a new reading arrives", () => {
      vi.useFakeTimers();
      const first = new Date().toISOString();

      const { rerender } = render(
        <SyncStatus
          key={keyFor(first, 5)}
          lastUpdated={first}
          secondsSinceLastUpdate={5}
        />,
      );

      act(() => {
        vi.advanceTimersByTime(4000);
      });
      expect(screen.getByText(/synced 9s ago/i)).toBeInTheDocument();

      // A fresh reading: the backend says it synced 1 second ago. The local
      // count must restart from that, not continue from 9.
      const second = new Date().toISOString();
      rerender(
        <SyncStatus
          key={keyFor(second, 1)}
          lastUpdated={second}
          secondsSinceLastUpdate={1}
        />,
      );

      expect(screen.getByText(/synced 1s ago/i)).toBeInTheDocument();
      expect(screen.queryByText(/synced 9s ago/i)).not.toBeInTheDocument();
    });

    it("keeps ticking after a re-anchor", () => {
      vi.useFakeTimers();
      const first = new Date().toISOString();

      const { rerender } = render(
        <SyncStatus
          key={keyFor(first, 5)}
          lastUpdated={first}
          secondsSinceLastUpdate={5}
        />,
      );

      const second = new Date().toISOString();
      rerender(
        <SyncStatus
          key={keyFor(second, 1)}
          lastUpdated={second}
          secondsSinceLastUpdate={1}
        />,
      );

      /*
       * The remount replaces the component instance, so its 1s interval is a
       * new one. This is what proves the old instance's cleanup ran and the
       * new instance's effect took over — a leak or a missed effect would
       * leave the count frozen at 1s.
       */
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText(/synced 3s ago/i)).toBeInTheDocument();
    });
  });
});
