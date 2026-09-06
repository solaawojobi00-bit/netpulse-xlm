import { useEffect, useRef, useState } from "react";

const POLL_INTERVAL_MS = 5000;

export function usePolling<T>(fetcher: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  /*
   * The "latest ref" pattern: `tick` below is scheduled once per effect run
   * but must call whatever `fetcher` is current when the timer fires, not the
   * one captured when the effect started.
   *
   * Synced in an effect rather than assigned during render. Mutating a ref
   * while rendering is what React warns about -- under StrictMode or a
   * concurrent re-render the write can happen for a render that is then
   * discarded. Declared before the polling effect so it commits first, and
   * with no dependency array so it tracks every render. `useRef(fetcher)`
   * already seeds the first value, so there is no window where it is stale.
   */
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick() {
      if (document.visibilityState === "hidden") {
        scheduleNext();
        return;
      }
      try {
        const result = await fetcherRef.current();
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
      scheduleNext();
    }

    function scheduleNext() {
      if (!cancelled) {
        timer = setTimeout(tick, POLL_INTERVAL_MS);
      }
    }

    void tick();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error };
}
