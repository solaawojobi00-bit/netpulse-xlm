import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TrendPoint } from "../api";
import { TREND_RANGES } from "../api";
import { TrendsView, formatTrendDate } from "./TrendsView";

const mockPoints: TrendPoint[] = [
  {
    date: "2026-09-01",
    closeTimeSeconds: 5.1,
    congestionUsage: 0.15,
    maxCongestionUsage: 0.61,
    operations: 120000,
    successfulTransactions: 35000,
    failedTransactions: 400,
    p50Fee: 100,
    p90Fee: 150,
  },
  {
    date: "2026-09-02",
    closeTimeSeconds: 5.4,
    congestionUsage: 0.22,
    maxCongestionUsage: 0.94,
    operations: 150000,
    successfulTransactions: 42000,
    failedTransactions: 510,
    p50Fee: 100,
    p90Fee: 150,
  },
];

const rangeOptions = TREND_RANGES.map((value) => ({ value, label: value }));

describe("TrendsView", () => {
  it("shows a loading state before the first fetch resolves", () => {
    render(<TrendsView points={null} range="90d" />);

    expect(screen.getByRole("status")).toBeInTheDocument();
    // null is not the same as loaded-and-empty.
    expect(screen.queryByText(/No daily rollups yet/i)).not.toBeInTheDocument();
  });

  it("renders an empty state with daily-grain copy, not history's wording", () => {
    render(<TrendsView points={[]} range="90d" />);

    expect(screen.getByText("90d Long-Range Trends")).toBeInTheDocument();
    expect(screen.getByText(/No daily rollups yet/i)).toBeInTheDocument();
    /*
     * At daily grain the wait is until tomorrow, so history's "check back
     * after several ledgers close" would send someone to refresh in a minute.
     */
    expect(screen.queryByText(/several ledgers close/i)).not.toBeInTheDocument();
  });

  it("surfaces a failed fetch instead of looking empty", () => {
    render(<TrendsView points={null} range="90d" error="Failed to fetch" />);

    expect(screen.getByText(/Could not load long-range trends/i)).toBeInTheDocument();
    expect(screen.queryByText(/No daily rollups yet/i)).not.toBeInTheDocument();
  });

  it("prints the error message once, not once per chart", () => {
    render(<TrendsView points={null} range="90d" error="Failed to fetch" />);

    // One fetch drives every card, so one failure is one message.
    expect(screen.getAllByText(/Could not load long-range trends/i)).toHaveLength(1);
  });

  it("renders the badge and range control in every state", () => {
    const states: { points: TrendPoint[] | null; error?: string }[] = [
      { points: null },
      { points: [] },
      { points: null, error: "Failed to fetch" },
      { points: mockPoints },
    ];

    for (const state of states) {
      const { unmount } = render(
        <TrendsView
          points={state.points}
          range="90d"
          error={state.error}
          rangeOptions={rangeOptions}
          onRangeChange={vi.fn()}
        />,
      );

      // A failed or loading panel is exactly when someone wants another range.
      expect(screen.getByText(/Daily resolution · retained indefinitely/i)).toBeInTheDocument();
      expect(screen.getByRole("group", { name: /trend time range/i })).toBeInTheDocument();

      unmount();
    }
  });

  it("renders chart headings that follow the range prop", () => {
    render(<TrendsView points={mockPoints} range="1y" />);

    expect(screen.getByText("1y Long-Range Trends")).toBeInTheDocument();
    expect(screen.getByText("1y Daily ledger close time (avg seconds)")).toBeInTheDocument();
    expect(
      screen.getByText("1y Daily congestion, average and peak (capacity usage %)"),
    ).toBeInTheDocument();
  });

  it("gives each chart a distinct accessible name", () => {
    render(<TrendsView points={mockPoints} range="90d" />);

    const names = screen.getAllByRole("img").map((el) => el.getAttribute("aria-label"));

    expect(names).toHaveLength(2);
    // Two charts both called "trends" would pass axe and still be useless.
    expect(new Set(names).size).toBe(2);
    for (const name of names) {
      expect(name).toBeTruthy();
    }
  });

  it("describes each chart rather than only naming it", () => {
    render(<TrendsView points={mockPoints} range="90d" />);

    const names = screen.getAllByRole("img").map((el) => el.getAttribute("aria-label") ?? "");

    expect(names.some((n) => /close time/i.test(n) && /5\.4/.test(n))).toBe(true);
    expect(names.some((n) => /peak capacity usage/i.test(n) && /94/.test(n))).toBe(true);
  });

  it("reports a range change through onRangeChange", async () => {
    const onRangeChange = vi.fn();
    const user = userEvent.setup();

    render(
      <TrendsView
        points={mockPoints}
        range="90d"
        rangeOptions={rangeOptions}
        onRangeChange={onRangeChange}
      />,
    );

    await user.click(screen.getByRole("button", { name: "1y" }));

    expect(onRangeChange).toHaveBeenCalledWith("1y");
  });

  it("stays renderable with no range control supplied", () => {
    // Read-only mode, as HistoryView supports, for tests and future callers.
    render(<TrendsView points={mockPoints} range="30d" />);

    expect(screen.getByText("30d Long-Range Trends")).toBeInTheDocument();
    expect(screen.queryByRole("group")).not.toBeInTheDocument();
  });

  it("defaults to 90d when no range is given", () => {
    render(<TrendsView points={[]} />);

    expect(screen.getByText("90d Long-Range Trends")).toBeInTheDocument();
  });

  it("tolerates null metrics in a point", () => {
    // A day with ledgers but no fee snapshots — the rollup produces this.
    const sparse: TrendPoint[] = [
      { ...mockPoints[0], congestionUsage: null, maxCongestionUsage: null },
    ];

    expect(() => render(<TrendsView points={sparse} range="90d" />)).not.toThrow();
    expect(screen.getByText("90d Long-Range Trends")).toBeInTheDocument();
  });
});

describe("formatTrendDate", () => {
  /*
   * Tested directly rather than through the rendered axis: Recharts measures
   * its container, jsdom reports zero width, and no tick text is ever emitted.
   * Asserting on the DOM here would pass vacuously.
   */
  it("formats a UTC day as a short month and day", () => {
    expect(formatTrendDate("2026-09-01")).toMatch(/Sep/);
    expect(formatTrendDate("2026-09-01")).toMatch(/\b1\b/);
  });

  it("renders the UTC day, not the local rendering of it", () => {
    /*
     * The failure this guards against — `new Date("2026-09-01")` parsing as
     * UTC midnight but *rendering* in local time, so west of Greenwich every
     * label slips to the previous day — is only observable on a machine west
     * of UTC. It cannot be reproduced in this suite: Node on Windows ignores
     * the TZ environment variable, so the run's timezone cannot be forced.
     *
     * So this asserts the contract instead of the symptom: whatever the host
     * timezone, the output must equal an explicitly-UTC formatting of the same
     * day. That is exact everywhere and, on a west-of-UTC machine, is also
     * precisely the assertion that fails if `timeZone: "UTC"` is dropped.
     */
    for (const date of ["2026-09-01", "2026-01-01", "2026-12-31", "2026-03-01"]) {
      const utcReference = new Date(`${date}T00:00:00Z`).toLocaleDateString([], {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      });

      expect(formatTrendDate(date)).toBe(utcReference);
    }
  });

  it("keeps the day number from the input string", () => {
    // A cheap, timezone-independent check that the day is not off by one.
    expect(formatTrendDate("2026-09-01")).toContain("1");
    expect(formatTrendDate("2026-09-15")).toContain("15");
    expect(formatTrendDate("2026-12-31")).toContain("31");
  });

  it("emits no time component", () => {
    expect(formatTrendDate("2026-12-25")).not.toMatch(/\d\d:\d\d/);
  });
});
