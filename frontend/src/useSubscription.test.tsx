import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HealthResponse, LedgerSample, Network } from "./api";
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

  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  sent: string[] = [];

  constructor(public url: string) {
    FakeWebSocket.last = this;
  }

  send(payload: string) {
    this.sent.push(payload);
  }

  close() {}
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
 * `isStreaming` is tagged with the network it describes (#150). What that buys
 * is below: the flag cannot outlive the socket it came from, which is also
 * what let the socket-construction `catch` stop writing state synchronously
 * from the effect body.
 */
describe("useSubscription streaming state", () => {
  it("reports streaming once the socket for the current network opens", async () => {
    const { result } = renderHook(() => useSubscription("mainnet"));

    expect(result.current.isStreaming).toBe(false);

    act(() => {
      FakeWebSocket.last?.onopen?.();
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(true));
  });

  /*
   * The regression this guards. Switching network tears the old socket down
   * and opens a new one, but nothing calls `onclose` on a socket whose
   * handlers were just detached — so a flag stored as a bare boolean stayed
   * `true` and claimed a live stream for a network whose socket had not
   * opened yet.
   */
  it("stops reporting streaming the moment the network changes", async () => {
    const { result, rerender } = renderHook(
      ({ network }: { network: Network }) => useSubscription(network),
      { initialProps: { network: "mainnet" satisfies Network } },
    );

    act(() => {
      FakeWebSocket.last?.onopen?.();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    rerender({ network: "testnet" as const });

    // Asserted with no waiting: the new network's socket has been constructed
    // but has not opened, so there is no moment at which this reads true.
    expect(result.current.isStreaming).toBe(false);

    act(() => {
      FakeWebSocket.last?.onopen?.();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));
  });

  it("clears streaming when the socket closes", async () => {
    const { result } = renderHook(() => useSubscription("mainnet"));

    act(() => {
      FakeWebSocket.last?.onopen?.();
    });
    await waitFor(() => expect(result.current.isStreaming).toBe(true));

    act(() => {
      FakeWebSocket.last?.onclose?.();
    });

    await waitFor(() => expect(result.current.isStreaming).toBe(false));
  });

  it("falls back to polling without reporting streaming when the socket cannot be constructed", async () => {
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          throw new Error("blocked");
        }
      },
    );

    const { result } = renderHook(() => useSubscription("mainnet"));

    expect(result.current.isStreaming).toBe(false);

    /*
     * The `catch` writes no state at all now, so the proof that it ran is the
     * fallback poll: every stubbed REST call rejects, and only the poll path
     * surfaces that as `error`. The mount-time fetches swallow their own
     * failures silently.
     */
    await waitFor(() => expect(result.current.error).toBe("REST unavailable"));
    expect(result.current.isStreaming).toBe(false);
  });
});
