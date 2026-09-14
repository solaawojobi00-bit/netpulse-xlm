/*
 * The header's way out of the app. There is no router and no about page, so
 * these three links are the only path from the deployed dashboard to the
 * project behind it — worth pinning, because nothing else in the app renders
 * an anchor and a regression here would be invisible in every other test.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App";

vi.mock("./useSubscription", () => ({
  useSubscription: () => ({
    health: null,
    error: null,
    ledgers: null,
    feeSnapshots: null,
    soroban: null,
    operationBreakdown: null,
    isStreaming: false,
  }),
}));

vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  return {
    ...actual,
    fetchHistory: () => new Promise(() => {}),
    fetchTrends: () => new Promise(() => {}),
  };
});

describe("header project links", () => {
  it("points at the repo, the architecture notes and the API docs", () => {
    render(<App />);

    const nav = screen.getByRole("navigation", { name: "Project links" });
    const links = within(nav).getAllByRole("link");

    expect(links.map((link) => link.textContent)).toEqual([
      "Source on GitHub",
      "How it works",
      "API docs",
    ]);
    for (const link of links) {
      expect(link).toHaveAttribute(
        "href",
        expect.stringContaining("github.com/solaawojobi00-bit/netpulse-xlm"),
      );
      // Opened in a new tab, so the referrer opt-out has to travel with them.
      expect(link).toHaveAttribute(
        "rel",
        expect.stringContaining("noreferrer"),
      );
    }
  });

  it("says what the dashboard is without adding a second heading", () => {
    render(<App />);

    expect(screen.getByText(/real data, no mocks/i)).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });
});
