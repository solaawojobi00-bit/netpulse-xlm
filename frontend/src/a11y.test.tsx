/*
 * Automated accessibility checks (issue #42).
 *
 * axe catches the mechanical failures — missing names, broken heading order,
 * bad ARIA — which is most of what regresses silently. It cannot judge whether
 * a chart's description is *useful*, so the assertions below the axe runs
 * cover the things a machine cannot see: that the network selector exposes
 * which network is active, that each chart is named after its data, and that
 * the congestion band survives without its colour.
 *
 * The colour-contrast rule is disabled here and covered by
 * `scripts/contrast-audit.mjs` instead: jsdom does not compute cascaded
 * colours or resolve custom properties, so axe would silently pass every pair
 * rather than measure it. The script parses the real token values.
 */
import axe from "axe-core";
import { render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";
import { StatTile } from "./components/StatTile";
import { ChartCard } from "./components/ChartCard";
import { HistoryView } from "./components/HistoryView";
import { LedgerCloseTimeChart } from "./components/LedgerCloseTimeChart";
import { TransactionSuccessChart } from "./components/TransactionSuccessChart";
import type {
  HealthResponse,
  HistoryPoint,
  LedgerSample,
  SorobanMetricsResponse,
} from "./api";

vi.mock("./useSubscription", () => ({
  useSubscription: () => mockSubscription,
}));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  fetchHistory: () => Promise.resolve({ range: "24h", points: historyPoints }),
}));

async function expectNoViolations(container: HTMLElement) {
  const results = await axe.run(container, {
    rules: {
      "color-contrast": { enabled: false },
      // Charts are rendered into a fixed-size container; jsdom reports every
      // element as 0x0, which trips rules that reason about geometry.
      "target-size": { enabled: false },
    },
  });

  const summary = results.violations.map(
    (v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.map((n) => n.html).join("\n  ")}`,
  );
  expect(summary, summary.join("\n\n")).toEqual([]);
}

const ledgers: LedgerSample[] = Array.from({ length: 5 }, (_, i) => ({
  sequence: 1000 + i,
  closeTimeSeconds: 5 + i * 0.1,
  operationCount: 100 + i,
  successfulTransactionCount: 40 + i,
  failedTransactionCount: 2,
  closedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
})) as LedgerSample[];

const historyPoints: HistoryPoint[] = Array.from({ length: 4 }, (_, i) => ({
  timestamp: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
  closeTimeSeconds: 5 + i * 0.2,
  congestionUsage: 0.3 + i * 0.05,
  operations: 500 + i,
  transactions: 200 + i,
})) as HistoryPoint[];

const health: HealthResponse = {
  status: "ok",
  lastUpdated: new Date(Date.UTC(2026, 0, 1, 12)).toISOString(),
  secondsSinceLastUpdate: 3,
  horizonUrl: "https://horizon.stellar.org",
  ledgerCloseTime: { currentSeconds: 5.2, averageSeconds: 5.4 },
  fees: { baseFeeStroops: 100, p10: 100, p50: 120, p90: 900, p99: 5000 },
  congestion: { ledgerCapacityUsage: 0.88, band: "high", alertThreshold: 0.75 },
  throughput: { operationsPerSecond: 42.5, transactionsPerSecond: 12.1 },
  recentLedgerCount: 5,
};

const soroban: SorobanMetricsResponse = {
  network: "mainnet",
  invocationsPerSecond: 3,
  recentInvocationsTotal: 90,
  successfulInvocationsTotal: 85,
  failedInvocationsTotal: 5,
  samples: Array.from({ length: 4 }, (_, i) => ({
    timestamp: new Date(Date.UTC(2026, 0, 1, 12, i)).toISOString(),
    invocationsCount: 20 + i,
    successfulCount: 18 + i,
    failedCount: 2,
  })),
};

let mockSubscription: {
  health: HealthResponse | null;
  ledgers: LedgerSample[] | null;
  feeSnapshots: never[] | null;
  soroban: SorobanMetricsResponse | null;
  error: string | null;
  isStreaming: boolean;
};

beforeEach(() => {
  mockSubscription = {
    health,
    ledgers,
    feeSnapshots: [],
    soroban,
    error: null,
    isStreaming: true,
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("axe: no mechanical violations", () => {
  it("stat tile, loaded and with a congestion band", async () => {
    const { container } = render(
      <StatTile label="Network congestion" value="42%" band="moderate" tone="warn" />,
    );
    await expectNoViolations(container);
  });

  it("stat tile, loading", async () => {
    const { container } = render(<StatTile label="Base fee" value={null} loading />);
    await expectNoViolations(container);
  });

  it("chart card in every state", async () => {
    for (const status of ["loading", "empty", "error", "ready"] as const) {
      const { container, unmount } = render(
        <ChartCard title="Ledger close time" status={status} summary="Currently 5 seconds.">
          <div>chart</div>
        </ChartCard>,
      );
      await expectNoViolations(container);
      unmount();
    }
  });

  it("history view, loaded", async () => {
    const { container } = render(<HistoryView points={historyPoints} range="24h" />);
    await expectNoViolations(container);
  });

  it("history view, failed", async () => {
    const { container } = render(
      <HistoryView points={null} range="24h" error="network down" />,
    );
    await expectNoViolations(container);
  });
});

/*
 * The whole-page checks. Heading order, landmarks and the selector's pressed
 * state only exist at this level, and these are the assertions that actually
 * failed before this change: axe reported `heading-order` (h1 followed by h3,
 * no h2 between) and `region` (the grids sat outside any landmark).
 */
describe("axe: the assembled page", () => {
  it("has no violations with data loaded", async () => {
    const { container } = render(<App />);
    await waitFor(() => expect(screen.getAllByRole("img").length).toBeGreaterThan(0));
    await expectNoViolations(container);
  });

  it("has no violations while still loading", async () => {
    mockSubscription = {
      health: null,
      ledgers: null,
      feeSnapshots: null,
      soroban: null,
      error: null,
      isStreaming: false,
    };
    const { container } = render(<App />);
    await expectNoViolations(container);
  });

  it("has no violations when the backend is unreachable", async () => {
    mockSubscription = {
      health: null,
      ledgers: null,
      feeSnapshots: null,
      soroban: null,
      error: "backend unreachable",
      isStreaming: false,
    };
    const { container } = render(<App />);
    await expectNoViolations(container);
  });

  it("keeps an unbroken heading outline: one h1, then h2s, then h3s", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByRole("img").length).toBeGreaterThan(0));

    const levels = screen
      .getAllByRole("heading")
      .map((h) => Number(h.tagName.slice(1)));

    expect(levels.filter((l) => l === 1)).toHaveLength(1);
    expect(levels[0]).toBe(1);
    // No jump of more than one level anywhere in document order — this is the
    // h1 -> h3 skip that existed before the section headings were added.
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
    }
  });

  it("puts the dashboard in a main landmark and the sync line in contentinfo", async () => {
    render(<App />);
    await waitFor(() => expect(screen.getAllByRole("img").length).toBeGreaterThan(0));

    expect(screen.getByRole("main")).toBeInTheDocument();
    expect(screen.getByRole("banner")).toBeInTheDocument();
    // The footer must sit outside <main> to count as contentinfo at all.
    const footer = screen.getByRole("contentinfo");
    expect(screen.getByRole("main").contains(footer)).toBe(false);
  });

  it("announces which network is selected, not just which one looks selected", async () => {
    render(<App />);

    const mainnet = screen.getByRole("button", { name: "Mainnet" });
    const testnet = screen.getByRole("button", { name: "Testnet" });

    expect(mainnet).toHaveAttribute("aria-pressed", "true");
    expect(testnet).toHaveAttribute("aria-pressed", "false");
  });

  it("announces the banners politely rather than interrupting", async () => {
    // health.congestion.band is "high", so the danger banner is rendered.
    render(<App />);
    await waitFor(() =>
      expect(screen.getByText(/High Network Congestion/)).toBeInTheDocument(),
    );

    const banner = screen.getByText(/High Network Congestion/).closest(".banner");
    expect(banner).toHaveAttribute("role", "status");
    // Never assertive: the backend reconnects on its own and the banner flaps.
    expect(banner).not.toHaveAttribute("aria-live", "assertive");
  });
});

describe("charts are named after their data", () => {
  it("gives a chart an accessible name built from its current values", () => {
    render(<LedgerCloseTimeChart ledgers={ledgers} />);

    // role="img" is what collapses the SVG's internals into one named node.
    const figure = screen.getByRole("img");
    const name = figure.getAttribute("aria-label") ?? "";

    expect(name).toContain("Ledger close time");
    expect(name).toContain("Close time per ledger");
    // The latest value, not just a generic "a chart of close times".
    expect(name).toContain("5.4");
    expect(name).toContain("seconds");
  });

  it("describes both series of a two-series chart", () => {
    render(<TransactionSuccessChart ledgers={ledgers} />);
    const name = screen.getByRole("img").getAttribute("aria-label") ?? "";

    expect(name).toContain("Successful transactions per ledger");
    expect(name).toContain("Failed transactions per ledger");
  });

  it("falls back to the title rather than an empty name when there is no data", () => {
    render(<LedgerCloseTimeChart ledgers={[]} />);
    // Empty state renders no chart, so there is no img to misname.
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("No ledger close times in this window.")).toBeInTheDocument();
  });

  it("names both history charts distinctly", async () => {
    render(<HistoryView points={historyPoints} range="24h" />);
    await waitFor(() => expect(screen.getAllByRole("img")).toHaveLength(2));

    const names = screen.getAllByRole("img").map((el) => el.getAttribute("aria-label"));
    expect(names[0]).toContain("Ledger close time");
    expect(names[1]).toContain("Network congestion");
    expect(names[0]).not.toEqual(names[1]);
  });
});

describe("state is not carried by colour alone", () => {
  it("renders the congestion band as text beside its glyph", () => {
    render(<StatTile label="Network congestion" value="88%" band="high" tone="bad" />);

    const band = screen.getByText("high");
    expect(band).toBeInTheDocument();

    // The glyph is decorative duplication and must not be announced.
    const glyph = within(band).getByText("■");
    expect(glyph).toHaveAttribute("aria-hidden", "true");
  });

  it("gives the loading skeleton a name a screen reader will actually use", () => {
    // aria-label on a role-less <div> is ignored; role="status" makes it count.
    render(<StatTile label="Base fee" value={null} loading />);
    expect(screen.getByRole("status")).toHaveAccessibleName("Base fee: loading");
  });
});
