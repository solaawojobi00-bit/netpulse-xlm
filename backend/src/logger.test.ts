import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "./logger.js";

describe("Logger", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  const origLogLevel = process.env.LOG_LEVEL;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (origLogLevel !== undefined) {
      process.env.LOG_LEVEL = origLogLevel;
    } else {
      delete process.env.LOG_LEVEL;
    }
  });

  it("is silent by default when NODE_ENV is test and LOG_LEVEL is not set", () => {
    delete process.env.LOG_LEVEL;
    logger.info("should not appear");
    logger.warn("should not appear");
    logger.error("should not appear");

    expect(logSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logs formatted message with timestamp, level, component, and network when LOG_LEVEL is info", () => {
    process.env.LOG_LEVEL = "info";
    logger.info("server started", { component: "server", network: "mainnet", port: 4000 });

    expect(logSpy).toHaveBeenCalledTimes(1);
    const output = logSpy.mock.calls[0][0];
    expect(output).toMatch(/\[INFO\] \[server\]\[mainnet\] server started {"port":4000}/);
  });

  it("respects log level thresholds", () => {
    process.env.LOG_LEVEL = "warn";
    logger.debug("debug message");
    logger.info("info message");
    expect(logSpy).not.toHaveBeenCalled();

    logger.warn("warning message", { component: "poller" });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toMatch(/\[WARN\] \[poller\] warning message/);

    logger.error("error message", { component: "db" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toMatch(/\[ERROR\] \[db\] error message/);
  });

  it("formats Error objects with stack traces", () => {
    process.env.LOG_LEVEL = "error";
    const testErr = new Error("Database disk full");
    logger.error("Prune failed", { component: "db", err: testErr });

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const output = errorSpy.mock.calls[0][0];
    expect(output).toContain("[ERROR] [db] Prune failed");
    expect(output).toContain("Database disk full");
    expect(output).toContain(testErr.stack!);
  });
});
