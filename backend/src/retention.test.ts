import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
 * Retention scheduling, which is a concern of poller.ts distinct from the SSE
 * reconnect behaviour in poller.test.ts — same split as operationBreakdown.
 * It lives in its own file because it is the only suite that drives
 * startStreaming(), which needs every Horizon call stubbed (including
 * fetchRecentOperations, which poller.test.ts has no reason to mock) and the
 * prune itself spied.
 */

const mockRollupAndPrune = vi.fn();
const mockConnectHorizonLedgerStream = vi.fn();
const mockFetchRecentLedgers = vi.fn();
const mockFetchFeeStats = vi.fn();
const mockFetchRecentOperations = vi.fn();

/*
 * Only rollupAndPrune is replaced. The inserts stay real — DEFAULT_DB_PATH is
 * ":memory:" under NODE_ENV=test — so this suite exercises the scheduling
 * without also asserting against a stubbed database.
 */
vi.mock("./db.js", async () => {
  const actual = await vi.importActual<typeof import("./db.js")>("./db.js");
  return {
    ...actual,
    db: {
      ...actual.db,
      rollupAndPrune: (...args: any[]) => mockRollupAndPrune(...args),
    },
  };
});

vi.mock("./horizon.js", async () => {
  const actual =
    await vi.importActual<typeof import("./horizon.js")>("./horizon.js");
  return {
    ...actual,
    fetchRecentLedgers: (...args: any[]) => mockFetchRecentLedgers(...args),
    fetchFeeStats: (...args: any[]) => mockFetchFeeStats(...args),
    fetchRecentOperations: (...args: any[]) =>
      mockFetchRecentOperations(...args),
    connectHorizonLedgerStream: (...args: any[]) =>
      mockConnectHorizonLedgerStream(...args),
  };
});

import { logger } from "./logger.js";
import { PRUNE_INTERVAL_MS, startStreaming } from "./poller.js";

/**
 * The Horizon poll period these tests run startStreaming with. Far larger than
 * production's few seconds on purpose: advancing days of fake time fires this
 * timer too, and every tick starts four stubbed Horizon calls that the prune
 * assertions do not look at. At production cadence a four-day span would fire
 * it ~57,000 times and time the test out. The one test that does care about
 * poll cadence passes its own value.
 */
const POLL_INTERVAL_MS = 24 * 60 * 60 * 1000;

describe("Retention scheduling", () => {
  let handles: Array<{ stop: () => Promise<void> }>;

  /**
   * Starts streaming and registers the handle for teardown, so a failing
   * assertion cannot leave SSE loops and timers running into the next test.
   */
  const start = (intervalMs: number = POLL_INTERVAL_MS) => {
    const handle = startStreaming(intervalMs);
    handles.push(handle);
    return handle;
  };

  /*
   * Synchronous advance, deliberately: the prune callback is synchronous, so
   * this is all the scheduling assertions need. advanceTimersByTimeAsync would
   * additionally await every poll callback fired along the way — thousands of
   * them across a multi-day span — for no added coverage.
   */
  const advance = (ms: number) => vi.advanceTimersByTime(ms);

  beforeEach(() => {
    vi.useFakeTimers();
    handles = [];

    mockRollupAndPrune.mockReset();
    mockFetchRecentLedgers.mockReset().mockResolvedValue([]);
    mockFetchFeeStats.mockReset().mockResolvedValue(null);
    mockFetchRecentOperations.mockReset().mockResolvedValue([]);

    /*
     * Stands in for a healthy stream: resolves only once aborted, the way a
     * live SSE connection stays open. Resolving immediately would spin the
     * reconnect loop with no timer to gate it.
     */
    mockConnectHorizonLedgerStream.mockImplementation(
      (
        _url: string,
        _cursor: string,
        _onRecord: unknown,
        signal?: AbortSignal,
      ) =>
        new Promise<void>((resolve) => {
          if (signal?.aborted) return resolve();
          signal?.addEventListener("abort", () => resolve());
        }),
    );
  });

  afterEach(async () => {
    for (const handle of handles) await handle.stop();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("prunes once on startup", () => {
    start();

    expect(mockRollupAndPrune).toHaveBeenCalledTimes(1);
  });

  it("prunes again after each interval elapses", () => {
    start();
    expect(mockRollupAndPrune).toHaveBeenCalledTimes(1);

    advance(PRUNE_INTERVAL_MS);
    expect(mockRollupAndPrune).toHaveBeenCalledTimes(2);

    advance(PRUNE_INTERVAL_MS);
    expect(mockRollupAndPrune).toHaveBeenCalledTimes(3);
  });

  it("keeps pruning across a long-running process", () => {
    start();

    // Four days at a six-hour period: the startup prune plus sixteen more.
    advance(4 * 24 * 60 * 60 * 1000);

    expect(mockRollupAndPrune).toHaveBeenCalledTimes(17);
  });

  it("does not prune on the Horizon poll interval", () => {
    // Production's six-second cadence, the timer this must not be wired to.
    const productionPollMs = 6000;
    start(productionPollMs);

    // A hundred poll periods, still well short of one prune period.
    expect(productionPollMs * 100).toBeLessThan(PRUNE_INTERVAL_MS);
    advance(productionPollMs * 100);

    expect(mockRollupAndPrune).toHaveBeenCalledTimes(1);
  });

  it("stops pruning once stop() is called", async () => {
    const handle = start();

    advance(PRUNE_INTERVAL_MS);
    expect(mockRollupAndPrune).toHaveBeenCalledTimes(2);

    await handle.stop();
    advance(PRUNE_INTERVAL_MS * 3);

    expect(mockRollupAndPrune).toHaveBeenCalledTimes(2);
  });

  it("leaves no timer running after stop()", async () => {
    const handle = start();

    await handle.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("logs a prune failure and keeps the schedule running", () => {
    const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
    const failure = new Error("database is locked");
    mockRollupAndPrune.mockImplementationOnce(() => {
      throw failure;
    });

    // A throwing prune must not take startStreaming down with it.
    expect(() => start()).not.toThrow();
    expect(errorSpy).toHaveBeenCalledWith("Prune failed", {
      component: "db",
      err: failure,
    });

    // ...nor cancel the interval that was scheduled alongside it.
    advance(PRUNE_INTERVAL_MS);
    expect(mockRollupAndPrune).toHaveBeenCalledTimes(2);
  });
});
