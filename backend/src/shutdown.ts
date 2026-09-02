import { logger } from "./logger.js";

/**
 * Default grace period for cleanup. Deliberately below the 10s that Docker
 * and systemd allow between SIGTERM and SIGKILL, so the process reports its
 * own failure to drain rather than being killed mid-log.
 */
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 8000;

export interface ShutdownRunnerOptions {
  /** Teardown steps, in order. Ordering lives with the resources, not here. */
  run: () => Promise<void>;
  timeoutMs?: number;
  /** Called when cleanup exceeds timeoutMs. Defaults to exiting non-zero. */
  onTimeout?: () => void;
}

/**
 * Wraps a teardown routine with the concerns every signal handler needs:
 * run once only, log start and completion, and give up after a deadline.
 *
 * The timer is unref'd so it never keeps the event loop alive on its own —
 * once cleanup releases every handle the process exits naturally with 0,
 * which also avoids truncating the final log line the way an immediate
 * process.exit(0) can on a piped stdout.
 */
export function createShutdownRunner(options: ShutdownRunnerOptions) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
  const onTimeout =
    options.onTimeout ??
    (() => {
      process.exit(1);
    });

  let started = false;

  return async function shutdown(signal: string): Promise<void> {
    // A second signal while draining must not run cleanup twice.
    if (started) {
      logger.info(`Received ${signal} during shutdown; already stopping`, {
        component: "shutdown",
        signal,
      });
      return;
    }
    started = true;

    logger.info(`Received ${signal}, shutting down gracefully`, {
      component: "shutdown",
      signal,
      timeoutMs,
    });

    const timer = setTimeout(() => {
      logger.error(`Shutdown did not complete within ${timeoutMs}ms, forcing exit`, {
        component: "shutdown",
        timeoutMs,
      });
      onTimeout();
    }, timeoutMs);
    timer.unref();

    try {
      await options.run();
      logger.info("Shutdown complete", { component: "shutdown" });
    } catch (err) {
      logger.error("Error during shutdown", { component: "shutdown", err });
    } finally {
      clearTimeout(timer);
    }
  };
}
