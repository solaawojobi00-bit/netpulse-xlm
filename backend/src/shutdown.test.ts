import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SHUTDOWN_TIMEOUT_MS, createShutdownRunner } from "./shutdown.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("createShutdownRunner", () => {
  it("runs the teardown routine once per process", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdownRunner({ run });

    await shutdown("SIGTERM");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("ignores a second signal received during shutdown", async () => {
    // A container platform may send SIGTERM then SIGINT; cleanup must not
    // run twice or throw.
    let release!: () => void;
    const run = vi.fn(
      () => new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const shutdown = createShutdownRunner({ run });

    const first = shutdown("SIGTERM");
    await expect(shutdown("SIGINT")).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(1);

    release();
    await first;
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("is idempotent across repeated signals after completion", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const shutdown = createShutdownRunner({ run });

    await shutdown("SIGTERM");
    await shutdown("SIGTERM");
    await shutdown("SIGINT");

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("swallows a teardown error rather than rejecting the handler", async () => {
    // An unhandled rejection here would be reported as a crash on the way out.
    const run = vi.fn().mockRejectedValue(new Error("close failed"));
    const shutdown = createShutdownRunner({ run });

    await expect(shutdown("SIGTERM")).resolves.toBeUndefined();
  });

  it("fires onTimeout when cleanup exceeds the deadline", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const shutdown = createShutdownRunner({
      run: () => new Promise<void>(() => {}), // never settles
      timeoutMs: 5000,
      onTimeout,
    });

    void shutdown("SIGTERM");
    expect(onTimeout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5000);

    expect(onTimeout).toHaveBeenCalledTimes(1);
  });

  it("does not fire onTimeout when cleanup finishes in time", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const shutdown = createShutdownRunner({
      run: async () => {},
      timeoutMs: 5000,
      onTimeout,
    });

    await shutdown("SIGTERM");
    await vi.advanceTimersByTimeAsync(10000);

    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("defaults to a grace period below the usual 10s SIGKILL window", () => {
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeLessThan(10000);
    expect(DEFAULT_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
