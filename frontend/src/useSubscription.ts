import { useEffect, useRef, useState } from "react";
import {
  fetchHealth,
  fetchRecentFees,
  fetchRecentLedgers,
  fetchSorobanMetrics,
  type FeeSnapshot,
  type HealthResponse,
  type LedgerSample,
  type Network,
  type SorobanMetricsResponse,
} from "./api";

const POLL_FALLBACK_MS = 5000;

export interface SubscriptionData {
  health: HealthResponse | null;
  ledgers: LedgerSample[] | null;
  feeSnapshots: FeeSnapshot[] | null;
  soroban: SorobanMetricsResponse | null;
  error: string | null;
  isStreaming: boolean;
}

export function useSubscription(network: Network): SubscriptionData {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [ledgers, setLedgers] = useState<LedgerSample[] | null>(null);
  const [feeSnapshots, setFeeSnapshots] = useState<FeeSnapshot[] | null>(null);
  const [soroban, setSoroban] = useState<SorobanMetricsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStreaming, setIsStreaming] = useState<boolean>(false);

  const networkRef = useRef(network);
  networkRef.current = network;

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
        const [h, l, f, s] = await Promise.all([
          fetchHealth(networkRef.current),
          fetchRecentLedgers(networkRef.current),
          fetchRecentFees(networkRef.current),
          fetchSorobanMetrics(networkRef.current),
        ]);
        if (!cancelled) {
          setHealth(h);
          setLedgers(l);
          setFeeSnapshots(f);
          setSoroban(s);
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
          const payload = JSON.parse(event.data);
          if (payload.type === "snapshot" && payload.network === networkRef.current) {
            setHealth(payload.health);
            setLedgers(payload.ledgers);
            setFeeSnapshots(payload.fees);
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

  return { health, ledgers, feeSnapshots, soroban, error, isStreaming };
}
