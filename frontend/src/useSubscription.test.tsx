import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse, LedgerSample } from "./api";
import { useSubscription } from "./useSubscription";

/*
 * The hook also fires a REST fetch per field on mount, so the page is not
 * blank before the first frame arrives. These tests are about the socket path,
 * and those fetches resolve after it -- stubbing them to a value would let
 * them overwrite the very state the assertions check.
 *
 * Rejecting makes them genuinely inert: each call site in the hook has its own
 * `.catch(() => {})`, so a rejected initial fetch writes nothing and leaves the
 * socket as the only writer. It is also a real scenario -- REST unreachable
 * while the stream is healthy.
 */
vi.mock("./api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./api")>();
  const unavailable = () => Promise.reject(new Error("REST unavailable"));
  return {
    ...actual,
    fetchHealth: vi.fn(unavailable),
    fetchRecentLedgers: vi.fn(unavailable),
    fetchRecentFees: vi.fn(unavailable),
    fetchSorobanMetrics: vi.fn(unavailable),
    fetchOperationBreakdown: vi.fn(unavailable),
  };
});

/*
 * jsdom has no WebSocket. This double records the instance so a test can drive
 * `onmessage` directly, which is the only way to deliver a chosen payload
 * without standing up a real server.
 */
class FakeWebSocket {
  static last: FakeWebSocket | null = null;
  /** Every socket the hook has constructed, so reconnects can be counted. */
  static instances: FakeWebSocket[] = [];

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];
  closed = false;

  constructor(public url: string) {
    FakeWebSocket.last = this;
    FakeWebSocket.instances.push(this);
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {
    this.closed = true;
  }
}

const health: HealthResponse = {
  status: "ok",
  lastUpdated: "2026-09-06T12:00:00.000Z",
  secondsSinceLastUpdate: 2,
  ledgerCloseTime: { currentSeconds: 5, averageSeconds: 5 },
  fees: { baseFeeStroops: 100, p10: 100, p50: 100, p90: 200, p99: 300 },
  congestion: { ledgerCapacityUsage: 0.2, band: "low" },
  throughput: { operationsPerSecond: 12, transactionsPerSecond: 4 },
  recentLedgerCount: 30,
};

const ledgers: LedgerSample[] = [
  {
    sequence: 1,
    closedAt: "2026-09-06T12:00:00.000Z",
    closeTimeSeconds: 5,
    successfulTransactionCount: 10,
    failedTransactionCount: 0,
    operationCount: 20,
    txSetOperationCount: 20,
    baseFeeInStroops: 100,
    maxTxSetSize: 1000,
  },
];

function deliver(payload: unknown) {
  act(() => {
    FakeWebSocket.last?.onmessage?.({ data: JSON.stringify(payload) });
  });
}

beforeEach(() => {
  FakeWebSocket.last = null;
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSubscription snapshot handling", () => {
  it("applies a full snapshot for the current network", async () => {
    const { result } = renderHook(() => useSubscription("mainnet"));

    deliver({
      type: "snapshot",
      network: "mainnet",
      health,
      ledgers,
      fees: [],
    });

    await waitFor(() => expect(result.current.health).toEqual(health));
    expect(result.current.ledgers).toEqual(ledgers);
  });

  /*
   * The regression this guards. Every field used to be assigned straight from
   * the payload, so a frame that omitted one wrote `undefined` into state
   * declared `T | null`. Consumers test for `null` to decide "still loading",
   * so an `undefined` slipped past that check and reached the charts as a
   * missing value instead of a loading state.
   */
  it("leaves existing state intact when a later frame omits fields", async () => {
    const { result } = renderHook(() => useSubscription("mainnet"));

    deliver({
      type: "snapshot",
      network: "mainnet",
      health,
      ledgers,
      fees: [],
    });
    await waitFor(() => expect(result.current.health).toEqual(health));

    // A partial frame: health only, no ledgers.
    deliver({ type: "snapshot", network: "mainnet", health });

    expect(result.current.ledgers).toEqual(ledgers);
    expect(result.current.ledgers).not.toBeUndefined();
  });

  it("ignores a snapshot addressed to a different network", async () => {
    const { result } = renderHook(() => useSubscription("mainnet"));

    deliver({
      type: "snapshot",
      network: "testnet",
      health,
      ledgers,
      fees: [],
    });

    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
    expect(result.current.health).toBeNull();
    expect(result.current.ledgers).toBeNull();
  });

  it("ignores a frame that is not a snapshot", async () => {
    const { result } = renderHook(() => useSubscription("mainnet"));

    deliver({ type: "pong", network: "mainnet", health, ledgers });

    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
    expect(result.current.health).toBeNull();
  });

  it("survives a malformed frame without throwing", async () => {
    const { result } = renderHook(() => useSubscription("mainnet"));

    act(() => {
      FakeWebSocket.last?.onmessage?.({ data: "not json{" });
    });

    await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
    expect(result.current.health).toBeNull();
  });
});

/*
 * The hook used to open the socket exactly once, so any close stranded the tab
 * on REST polling until someone reloaded. These cover the retry loop that
 * replaced that.
 *
 * Fake timers throughout, because the whole point is *when* a reconnect is
 * attempted. `Math.random` is pinned to 0 so the jitter collapses to the bottom
 * of its range and the delays are exact: with a ceiling of C the delay is
 * C/2 + 0, i.e. 500ms, then 1000ms, then 2000ms, doubling to a 15000ms floor
 * once the 30s ceiling is reached.
 */
describe("useSubscription reconnect", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drive a socket's close handler the way a dropped connection would. */
  function dropSocket(socket: FakeWebSocket | null) {
    act(() => {
      socket?.onclose?.();
    });
  }

  function advance(ms: number) {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it("opens a new socket after the connection closes", () => {
    renderHook(() => useSubscription("mainnet"));
    expect(FakeWebSocket.instances).toHaveLength(1);

    dropSocket(FakeWebSocket.last);
    // Nothing yet -- the retry is scheduled, not immediate.
    expect(FakeWebSocket.instances).toHaveLength(1);

    advance(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("backs off further on each successive failure", () => {
    renderHook(() => useSubscription("mainnet"));

    dropSocket(FakeWebSocket.last);
    advance(500);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Second failure: the delay has doubled, so 500ms is no longer enough.
    dropSocket(FakeWebSocket.last);
    advance(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    advance(1);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Third: doubled again.
    dropSocket(FakeWebSocket.last);
    advance(1999);
    expect(FakeWebSocket.instances).toHaveLength(3);
    advance(1);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("counts an error and the close that follows it as one attempt", () => {
    renderHook(() => useSubscription("mainnet"));

    // Browsers fire both for a single failure. Scheduling twice would leave one
    // orphaned timer still pending after the first retry fires, and the second
    // would open a socket the hook has no reference to and never closes.
    act(() => {
      FakeWebSocket.last?.onerror?.();
      FakeWebSocket.last?.onclose?.();
    });

    advance(500);
    expect(FakeWebSocket.instances).toHaveLength(2);

    // Long enough for any duplicate schedule to have fired. Exactly one retry.
    advance(5000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("resets the backoff once a connection has lasted long enough", () => {
    const { result } = renderHook(() => useSubscription("mainnet"));

    dropSocket(FakeWebSocket.last);
    advance(500);
    dropSocket(FakeWebSocket.last);
    advance(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // Third socket opens and stays up past the stability window.
    act(() => {
      FakeWebSocket.last?.onopen?.();
    });
    expect(result.current.isStreaming).toBe(true);
    advance(30000);

    // The next failure starts from the bottom of the backoff again.
    dropSocket(FakeWebSocket.last);
    advance(500);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });

  it("does not reset the backoff for a connection that opens and drops immediately", () => {
    renderHook(() => useSubscription("mainnet"));

    dropSocket(FakeWebSocket.last);
    advance(500);

    // Opens, then fails well inside the stability window: the delay must keep
    // growing rather than snapping back to its floor.
    act(() => {
      FakeWebSocket.last?.onopen?.();
    });
    advance(100);
    dropSocket(FakeWebSocket.last);

    advance(999);
    expect(FakeWebSocket.instances).toHaveLength(2);
    advance(1);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("marks the stream live again and stops polling once reconnected", () => {
    const { result } = renderHook(() => useSubscription("mainnet"));

    dropSocket(FakeWebSocket.last);
    expect(result.current.isStreaming).toBe(false);

    advance(500);
    act(() => {
      FakeWebSocket.last?.onopen?.();
    });

    expect(result.current.isStreaming).toBe(true);
    // The reopened socket re-announces the network it wants frames for.
    expect(FakeWebSocket.last?.sent).toContain(
      JSON.stringify({ type: "setNetwork", network: "mainnet" }),
    );
  });

  it("stops reconnecting after unmount", () => {
    const { unmount } = renderHook(() => useSubscription("mainnet"));

    dropSocket(FakeWebSocket.last);
    unmount();

    advance(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("closes the live socket on unmount without scheduling a retry", () => {
    const { unmount } = renderHook(() => useSubscription("mainnet"));
    const socket = FakeWebSocket.last;

    unmount();

    expect(socket?.closed).toBe(true);
    // Detached first, so the close cannot feed back into the retry loop.
    expect(socket?.onclose).toBeNull();
    advance(60000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});
