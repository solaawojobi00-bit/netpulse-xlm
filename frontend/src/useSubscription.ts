import { useEffect, useRef, useState } from "react";
import {
  fetchHealth,
  fetchRecentFees,
  fetchRecentLedgers,
  fetchOperationBreakdown,
  fetchSorobanMetrics,
  type FeeSnapshot,
  type HealthResponse,
  type LedgerSample,
  type Network,
  type OperationBreakdownResponse,
  type SorobanMetricsResponse,
} from "./api";
import { wsUrl } from "./config";

const POLL_FALLBACK_MS = 5000;

/*
 * Reconnect backoff.
 *
 * The socket used to be opened exactly once: any close — a backend deploy, a
 * dropped connection, a laptop waking from sleep — left the tab on the 5s REST
 * fallback until someone reloaded the page. The backend now runs on an instance
 * type that sleeps after 15 minutes of inactivity, so a close is routine rather
 * than exceptional.
 *
 * The ceiling is what matters most here. A sleeping instance takes roughly a
 * minute to wake, and the first connection attempt is itself what wakes it, so
 * retrying must stay cheap for far longer than a normal reconnect would need.
 */
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

/*
 * How long a connection must survive before the backoff is considered
 * recovered. Without this, a backend that accepts a socket and immediately
 * drops it would reset the delay to one second on every attempt and be hammered
 * in a near-tight loop — the flap looks like a success to anything that only
 * watches `onopen`.
 */
const RECONNECT_STABLE_MS = 30000;

/*
 * The shape the server sends on /ws. Declaring it is what lets the handler
 * below read fields without every access being an unchecked `any` hop into
 * typed React state.
 *
 * This is a shape declaration, not runtime validation -- the payload is still
 * whatever the socket delivered. Every field is therefore optional and the
 * handler treats a missing one as "no update", so a truncated or partial frame
 * leaves the previous value in place rather than writing `undefined` into
 * state typed as `T | null`.
 */
interface SnapshotMessage {
  type?: string;
  network?: string;
  health?: HealthResponse;
  ledgers?: LedgerSample[];
  fees?: FeeSnapshot[];
  operationBreakdown?: OperationBreakdownResponse;
  soroban?: SorobanMetricsResponse;
}

export interface SubscriptionData {
  health: HealthResponse | null;
  ledgers: LedgerSample[] | null;
  feeSnapshots: FeeSnapshot[] | null;
  soroban: SorobanMetricsResponse | null;
  operationBreakdown: OperationBreakdownResponse | null;
  error: string | null;
  isStreaming: boolean;
}

export function useSubscription(network: Network): SubscriptionData {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ledgers, setLedgers] = useState<LedgerSample[] | null>(null);
  const [feeSnapshots, setFeeSnapshots] = useState<FeeSnapshot[] | null>(null);
  const [soroban, setSoroban] = useState<SorobanMetricsResponse | null>(null);
  const [operationBreakdown, setOperationBreakdown] =
    useState<OperationBreakdownResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  /*
   * Read from the socket handler and the poll loop, both of which fire long
   * after the render that scheduled them and must see the network the user is
   * currently on. Synced in an effect rather than written during render, for
   * the same reason as usePolling: a ref mutated mid-render can be written for
   * a render React later throws away.
   */
  const networkRef = useRef(network);
  useEffect(() => {
    networkRef.current = network;
  });

  useEffect(() => {
    let ws: WebSocket | null = null;
    let fallbackTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let stableTimer: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;

    /*
     * Consecutive failed connection attempts, driving the backoff delay. Reset
     * only once a connection has lasted RECONNECT_STABLE_MS.
     */
    let attempt = 0;

    /*
     * Whether the REST fallback loop is running. Tracked explicitly rather than
     * inferred from `fallbackTimer`, because that timer is unset for the whole
     * duration of an in-flight poll — so two disconnect events arriving while
     * one poll was awaiting would each start their own loop, and from then on
     * every tick would fire twice.
     */
    let polling = false;

    async function pollFallback() {
      if (document.visibilityState === "hidden") {
        scheduleNextPoll();
        return;
      }
      try {
        const [h, l, f, s, ob] = await Promise.all([
          fetchHealth(networkRef.current),
          fetchRecentLedgers(networkRef.current),
          fetchRecentFees(networkRef.current),
          fetchSorobanMetrics(networkRef.current),
          fetchOperationBreakdown(networkRef.current),
        ]);
        if (!cancelled) {
          setHealth(h);
          setLedgers(l);
          setFeeSnapshots(f);
          setSoroban(s);
          setOperationBreakdown(ob);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      scheduleNextPoll();
    }

    function scheduleNextPoll() {
      if (!cancelled && polling) {
        fallbackTimer = setTimeout(pollFallback, POLL_FALLBACK_MS);
      }
    }

    function startPolling() {
      if (cancelled || polling) return;
      polling = true;
      void pollFallback();
    }

    function stopPolling() {
      polling = false;
      if (fallbackTimer) {
        clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
      }
    }

    /*
     * Exponential backoff with jitter over the range [delay/2, delay]. The
     * jitter matters because every open tab is disconnected by the same event —
     * a deploy, or the instance going to sleep — so without it they would all
     * retry in lockstep and arrive together on a backend that is still starting.
     */
    function scheduleReconnect() {
      if (cancelled || reconnectTimer) return;
      const ceiling = Math.min(
        RECONNECT_BASE_MS * 2 ** attempt,
        RECONNECT_MAX_MS,
      );
      const delay = ceiling / 2 + Math.random() * (ceiling / 2);
      attempt += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        connect();
      }, delay);
    }

    /*
     * Shared by every path that loses the socket. `onerror` is normally
     * followed by `onclose`, so this runs twice for one failure — the
     * `reconnectTimer` guard in scheduleReconnect is what keeps that from
     * counting as two attempts and doubling the delay.
     */
    function handleDisconnect() {
      if (cancelled) return;
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = undefined;
      }
      setIsStreaming(false);
      startPolling();
      scheduleReconnect();
    }

    function connect() {
      if (cancelled) return;

      let socket: WebSocket;
      try {
        socket = new WebSocket(wsUrl());
      } catch {
        // A malformed URL or a blocked scheme throws here rather than firing
        // `onerror`, so this path still has to fall back and retry.
        handleDisconnect();
        return;
      }
      ws = socket;

      socket.onopen = () => {
        if (cancelled) return;
        setIsStreaming(true);
        // The socket supersedes polling; leaving both running would double
        // every request for as long as the connection lasted.
        stopPolling();
        socket.send(JSON.stringify({ type: "setNetwork", network }));
        stableTimer = setTimeout(() => {
          attempt = 0;
        }, RECONNECT_STABLE_MS);
      };

      socket.onmessage = (event) => {
        if (cancelled) return;
        try {
          const payload = JSON.parse(event.data as string) as SnapshotMessage;
          if (
            payload.type === "snapshot" &&
            payload.network === networkRef.current
          ) {
            // Guarded individually: these three used to be assigned straight
            // through, so a frame missing one would write `undefined` into
            // state declared as `T | null` and every consumer's `=== null`
            // check would miss it.
            if (payload.health) setHealth(payload.health);
            if (payload.ledgers) setLedgers(payload.ledgers);
            if (payload.fees) setFeeSnapshots(payload.fees);
            if (payload.operationBreakdown) {
              setOperationBreakdown(payload.operationBreakdown);
            }
            if (payload.soroban) {
              setSoroban(payload.soroban);
            }
            setError(null);
          }
        } catch {
          // Ignore non-JSON
        }
      };

      socket.onerror = handleDisconnect;
      socket.onclose = handleDisconnect;
    }

    connect();

    // Always fetch initial data immediately via REST so there is no blank state
    void fetchHealth(network)
      .then((h) => {
        if (!cancelled) setHealth(h);
      })
      .catch(() => {});
    void fetchRecentLedgers(network)
      .then((l) => {
        if (!cancelled) setLedgers(l);
      })
      .catch(() => {});
    void fetchRecentFees(network)
      .then((f) => {
        if (!cancelled) setFeeSnapshots(f);
      })
      .catch(() => {});
    void fetchSorobanMetrics(network)
      .then((s) => {
        if (!cancelled) setSoroban(s);
      })
      .catch(() => {});
    void fetchOperationBreakdown(network)
      .then((ob) => {
        if (!cancelled) setOperationBreakdown(ob);
      })
      .catch(() => {});

    return () => {
      cancelled = true;
      if (ws) {
        // Detached before closing: otherwise this close fires `onclose`, which
        // would schedule a reconnect for a hook that is going away.
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      }
      if (fallbackTimer) clearTimeout(fallbackTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (stableTimer) clearTimeout(stableTimer);
    };
  }, [network]);

  return {
    health,
    ledgers,
    feeSnapshots,
    soroban,
    operationBreakdown,
    error,
    isStreaming,
  };
}
