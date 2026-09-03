import { useCallback, useEffect, useState } from "react";

/*
 * View state in the query string, so the URL is the thing you can paste to
 * someone. No router: two params do not justify the dependency, and the
 * History API does all of this directly.
 *
 * Two decisions worth knowing about before reading the code.
 *
 * `replaceState`, not `pushState`. Switching network or range filters the
 * view; it does not navigate anywhere. With pushState, someone who arrives
 * from a link, glances at testnet and then at 6h has to press Back three
 * times to leave the page — each filter toggle becomes a fake destination.
 * replaceState keeps Back meaning "the page I came from" while the URL still
 * reflects the current view at every moment, which is the whole point of the
 * feature. The cost is that Back does not undo a toggle; the visible controls
 * already do that, and they say which one is active.
 *
 * Defaults are omitted from the URL rather than written out. A first visit
 * stays on a clean `/` instead of being rewritten to
 * `/?network=mainnet&range=24h`, and an absent param already means the
 * default by definition. The trade-off is that a link shared while on the
 * defaults pins nothing, so if a default ever changes, that link changes
 * meaning with it — worth remembering if these defaults are ever revisited.
 */

/** Reads the current value for `key`, falling back when absent or unknown. */
function readParam<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  if (typeof window === "undefined") return fallback;

  // URLSearchParams does not throw on malformed input — a hand-edited URL
  // yields null or a junk string here, and both land on the fallback.
  const raw = new URLSearchParams(window.location.search).get(key);
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

/**
 * A query param constrained to a known set of values.
 *
 * The initial value is read synchronously during the first render, so a URL
 * carrying params paints that view directly — reading it in an effect would
 * render the default first and visibly snap.
 */
export function useQueryParam<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readParam(key, allowed, fallback));

  const set = useCallback(
    (next: T) => {
      setValue(next);

      if (typeof window === "undefined") return;

      // Re-read the live search string rather than closing over it: the other
      // param's setter may have written in this same tick, and replaceState is
      // synchronous, so whatever it wrote is already here.
      const params = new URLSearchParams(window.location.search);
      if (next === fallback) params.delete(key);
      else params.set(key, next);

      const query = params.toString();
      window.history.replaceState(
        window.history.state,
        "",
        `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`,
      );
    },
    [key, fallback],
  );

  /*
   * replaceState never creates an entry of our own, but the user can still
   * arrive here through history — Back into the page, or forward out of it.
   * Re-reading on popstate keeps the controls agreeing with the address bar
   * instead of showing whatever was selected before the navigation.
   */
  useEffect(() => {
    function sync() {
      setValue(readParam(key, allowed, fallback));
    }
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
    // `allowed` is a module-level constant at every call site; listing it
    // would re-subscribe on each render for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fallback]);

  return [value, set];
}
