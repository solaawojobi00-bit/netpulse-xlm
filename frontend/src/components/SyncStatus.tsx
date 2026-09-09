import { useEffect, useState } from "react";

interface SyncStatusProps {
  lastUpdated: string | null;
  secondsSinceLastUpdate: number | null;
  status?: "ok" | "stale";
}

export function SyncStatus({
  lastUpdated,
  secondsSinceLastUpdate,
  status = "ok",
}: SyncStatusProps) {
  /*
   * `baseSeconds` is the backend's own count and `receivedAt` is when it
   * reached this client. Both are needed: ticking from `lastUpdated` alone
   * would measure against the *client* clock, so any skew between the two
   * machines would show up as a wrong "synced Ns ago". Anchoring on the
   * server's number and ticking locally from arrival keeps the reading
   * server-authoritative, and re-anchoring on each frame that lands
   * re-corrects the local drift.
   *
   * Re-anchoring is a remount, driven by the `key` App gives this component
   * (#150). There used to be an effect here that re-based both values when
   * the props changed; it fired after React had already committed a render
   * pairing the new props with the stale anchor, so the corrected figure was
   * always one committed pass behind. A `key` covering the same two props
   * discards the whole component instead, which is what these initialisers
   * are for — and it is the only place a clock may be read, since
   * `react-hooks` rightly rejects `Date.now()` during render.
   */
  const [anchor] = useState(() => ({
    baseSeconds: secondsSinceLastUpdate,
    receivedAt: Date.now(),
  }));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const interval = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => clearInterval(interval);
  }, []);

  if (!lastUpdated) {
    return null;
  }

  const parsedTime = new Date(lastUpdated).getTime();
  const formattedTime = !Number.isNaN(parsedTime)
    ? new Date(lastUpdated).toLocaleTimeString()
    : lastUpdated;

  let elapsed: number;
  if (anchor.baseSeconds !== null && anchor.baseSeconds !== undefined) {
    const clientElapsed = (now - anchor.receivedAt) / 1000;
    elapsed = Math.max(0, Math.floor(anchor.baseSeconds + clientElapsed));
  } else if (!Number.isNaN(parsedTime)) {
    elapsed = Math.max(0, Math.floor((now - parsedTime) / 1000));
  } else {
    elapsed = 0;
  }

  const timeAgo =
    elapsed >= 60
      ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s ago`
      : `${elapsed}s ago`;

  const isStale = status === "stale";

  return (
    <span
      className={`sync-status ${isStale ? "sync-status--stale" : "sync-status--ok"}`}
    >
      <span className="sync-status__indicator" aria-hidden="true" />
      <span>
        {isStale ? (
          <>
            Backend sync is stale &middot; synced {timeAgo} ({formattedTime})
          </>
        ) : (
          <>
            Backend last synced with Horizon: {formattedTime} &middot; synced{" "}
            {timeAgo}
          </>
        )}
      </span>
    </span>
  );
}
