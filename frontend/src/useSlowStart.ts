import { useEffect, useState } from "react";

/*
 * How long the dashboard waits with nothing to show before explaining itself.
 *
 * Measured rather than guessed. Against the deployed backend, a warm
 * `/api/health` returns in roughly 1.0-1.5s:
 *
 *   1.520s  1.156s  1.094s  1.061s  1.046s
 *
 * Six seconds is about four times the warm case, so an ordinary load — even a
 * slow one on a bad connection — never trips it, while a sleeping instance
 * (which takes about a minute to wake) always will. The cost of getting this
 * wrong is asymmetric: a false positive tells a healthy visitor the backend is
 * asleep when it is not, which is worse than a few extra seconds of the loading
 * state they were already watching.
 */
export const SLOW_START_AFTER_MS = 6000;

/**
 * Whether the first load has been waiting long enough to deserve an
 * explanation: no data yet, nothing failed, and the threshold has passed.
 *
 * The backend sleeps after 15 minutes of inactivity and the request that wakes
 * it is held open rather than failing, so a cold start produces no error to
 * report — just an indefinite loading state indistinguishable from a fast one.
 *
 * `elapsed` is deliberately never reset. It only matters while `waiting` is
 * true, and `waiting` is monotonic in practice: `useSubscription` only ever
 * writes non-null data, so once anything has arrived it cannot go back to
 * having nothing. Resetting would mean calling setState synchronously from the
 * effect body, which buys nothing here and costs a cascading render.
 */
export function useSlowStart(hasData: boolean, error: string | null): boolean {
  const waiting = !hasData && !error;
  const [elapsed, setElapsed] = useState(false);

  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout(() => setElapsed(true), SLOW_START_AFTER_MS);
    return () => clearTimeout(timer);
  }, [waiting]);

  return waiting && elapsed;
}
