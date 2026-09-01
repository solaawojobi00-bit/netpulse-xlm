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
  const [snapshot, setSnapshot] = useState(() => ({
    receivedAt: Date.now(),
    baseSeconds: secondsSinceLastUpdate,
  }));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setSnapshot({
      receivedAt: Date.now(),
      baseSeconds: secondsSinceLastUpdate,
    });
    setNow(Date.now());
  }, [lastUpdated, secondsSinceLastUpdate]);

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
  if (snapshot.baseSeconds !== null && snapshot.baseSeconds !== undefined) {
    const clientElapsed = (now - snapshot.receivedAt) / 1000;
    elapsed = Math.max(0, Math.floor(snapshot.baseSeconds + clientElapsed));
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
    <span className={`sync-status ${isStale ? "sync-status--stale" : "sync-status--ok"}`}>
      <span className="sync-status__indicator" aria-hidden="true" />
      <span>
        {isStale ? (
          <>Backend sync is stale &middot; synced {timeAgo} ({formattedTime})</>
        ) : (
          <>Backend last synced with Horizon: {formattedTime} &middot; synced {timeAgo}</>
        )}
      </span>
    </span>
  );
}
