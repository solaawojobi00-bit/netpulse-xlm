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

const POLL_FALLBACK_MS = 5000;

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
    let cancelled = false;

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
      if (!cancelled) {
        fallbackTimer = setTimeout(pollFallback, POLL_FALLBACK_MS);
      }
    }

    // Try WebSocket connection first
    try {
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wsUrl = `${protocol}//${window.location.host}/ws`;
      ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        if (cancelled) return;
        setIsStreaming(true);
        ws?.send(JSON.stringify({ type: "setNetwork", network }));
      };

      ws.onmessage = (event) => {
        if (cancelled) return;
        try {
          const payload = JSON.parse(
            event.data as string,
          ) as SnapshotMessage;
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

      ws.onerror = () => {
        if (cancelled) return;
        setIsStreaming(false);
        if (!fallbackTimer) {
          void pollFallback();
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        setIsStreaming(false);
        if (!fallbackTimer) {
          void pollFallback();
        }
      };
    } catch {
      setIsStreaming(false);
      void pollFallback();
    }

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
        ws.onopen = null;
        ws.onmessage = null;
        ws.onerror = null;
        ws.onclose = null;
        ws.close();
      }
      if (fallbackTimer) clearTimeout(fallbackTimer);
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
