import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLOW_START_AFTER_MS, useSlowStart } from "./useSlowStart";

/*
 * Fake timers throughout: every case here is about *when* the notice appears,
 * and the threshold is deliberately long enough that real timers would make the
 * suite take longer than the rest of it combined.
 */
beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number) {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("useSlowStart", () => {
  it("stays quiet before the threshold", () => {
    const { result } = renderHook(() => useSlowStart(false, null));

    expect(result.current).toBe(false);
    // One millisecond short: the boundary itself is the contract.
    advance(SLOW_START_AFTER_MS - 1);
    expect(result.current).toBe(false);
  });

  it("reports a slow start once the threshold passes", () => {
    const { result } = renderHook(() => useSlowStart(false, null));

    advance(SLOW_START_AFTER_MS);
    expect(result.current).toBe(true);
  });

  it("stays quiet when data arrives before the threshold", () => {
    const { result, rerender } = renderHook(
      ({ hasData }) => useSlowStart(hasData, null),
      { initialProps: { hasData: false } },
    );

    advance(SLOW_START_AFTER_MS - 1000);
    rerender({ hasData: true });
    advance(SLOW_START_AFTER_MS);

    expect(result.current).toBe(false);
  });

  it("stays quiet when the request fails instead of hanging", () => {
    // A failure has its own banner. Showing both would be contradictory:
    // one says it is starting, the other says it is unreachable.
    const { result } = renderHook(() => useSlowStart(false, "boom"));

    advance(SLOW_START_AFTER_MS * 2);
    expect(result.current).toBe(false);
  });

  it("clears as soon as data arrives, even after the notice is showing", () => {
    const { result, rerender } = renderHook(
      ({ hasData }) => useSlowStart(hasData, null),
      { initialProps: { hasData: false } },
    );

    advance(SLOW_START_AFTER_MS);
    expect(result.current).toBe(true);

    rerender({ hasData: true });
    expect(result.current).toBe(false);
  });

  it("clears if the wait ends in an error rather than data", () => {
    const { result, rerender } = renderHook(
      ({ error }) => useSlowStart(false, error),
      { initialProps: { error: null as string | null } },
    );

    advance(SLOW_START_AFTER_MS);
    expect(result.current).toBe(true);

    rerender({ error: "unreachable" });
    expect(result.current).toBe(false);
  });

  it("does not leave a timer behind on unmount", () => {
    const { unmount } = renderHook(() => useSlowStart(false, null));

    unmount();
    // Would throw on a setState against an unmounted hook if the timer survived.
    expect(() => advance(SLOW_START_AFTER_MS * 2)).not.toThrow();
  });
});
