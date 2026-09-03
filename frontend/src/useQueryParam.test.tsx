import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useQueryParam } from "./useQueryParam";

const NETWORKS = ["mainnet", "testnet"] as const;
const RANGES = ["6h", "12h", "24h"] as const;

function setUrl(search: string) {
  window.history.replaceState(null, "", `/${search}`);
}

beforeEach(() => setUrl(""));
afterEach(() => setUrl(""));

describe("useQueryParam", () => {
  it("reads an existing param on the very first render", () => {
    setUrl("?network=testnet");
    const { result } = renderHook(() =>
      useQueryParam("network", NETWORKS, "mainnet"),
    );

    // Synchronous, not settled by an effect — this is what stops the page
    // painting the default view and then snapping to the real one.
    expect(result.current[0]).toBe("testnet");
  });

  it("falls back when the param is absent", () => {
    const { result } = renderHook(() => useQueryParam("network", NETWORKS, "mainnet"));
    expect(result.current[0]).toBe("mainnet");
  });

  it.each([
    ["?network=mars", "a value outside the allowed set"],
    ["?network=", "an empty value"],
    ["?network=TESTNET", "the right value in the wrong case"],
    ["?network=testnet&network=mainnet", "a repeated param"],
    ["?%network=%%", "a malformed query string"],
  ])("falls back without throwing on %s (%s)", (search) => {
    setUrl(search);
    expect(() =>
      renderHook(() => useQueryParam("network", NETWORKS, "mainnet")),
    ).not.toThrow();
  });

  it("hand-edited nonsense never yields a value outside the allowed set", () => {
    setUrl("?range=99h");
    const { result } = renderHook(() => useQueryParam("range", RANGES, "24h"));

    expect(RANGES).toContain(result.current[0]);
    expect(result.current[0]).toBe("24h");
  });

  it("writes a non-default value to the URL", () => {
    const { result } = renderHook(() => useQueryParam("network", NETWORKS, "mainnet"));

    act(() => result.current[1]("testnet"));

    expect(result.current[0]).toBe("testnet");
    expect(window.location.search).toBe("?network=testnet");
  });

  it("removes the param when the value returns to the default", () => {
    setUrl("?network=testnet");
    const { result } = renderHook(() => useQueryParam("network", NETWORKS, "mainnet"));

    act(() => result.current[1]("mainnet"));

    // Absent already means the default, so a clean URL says the same thing.
    expect(window.location.search).toBe("");
    expect(result.current[0]).toBe("mainnet");
  });

  it("leaves other params alone when writing", () => {
    setUrl("?range=6h&keep=this");
    const { result } = renderHook(() => useQueryParam("network", NETWORKS, "mainnet"));

    act(() => result.current[1]("testnet"));

    const params = new URLSearchParams(window.location.search);
    expect(params.get("range")).toBe("6h");
    expect(params.get("keep")).toBe("this");
    expect(params.get("network")).toBe("testnet");
  });

  it("lets two params coexist when both are written in turn", () => {
    const { result } = renderHook(() => ({
      network: useQueryParam("network", NETWORKS, "mainnet"),
      range: useQueryParam("range", RANGES, "24h"),
    }));

    act(() => result.current.network[1]("testnet"));
    act(() => result.current.range[1]("6h"));

    const params = new URLSearchParams(window.location.search);
    expect(params.get("network")).toBe("testnet");
    expect(params.get("range")).toBe("6h");
  });

  it("replaces rather than pushes, so toggling does not pile up history", () => {
    const before = window.history.length;
    const { result } = renderHook(() => useQueryParam("network", NETWORKS, "mainnet"));

    act(() => result.current[1]("testnet"));
    act(() => result.current[1]("mainnet"));
    act(() => result.current[1]("testnet"));

    // Three toggles, no new entries: Back still means "the page I came from".
    expect(window.history.length).toBe(before);
  });

  it("preserves the path and hash", () => {
    window.history.replaceState(null, "", "/dashboard#charts");
    const { result } = renderHook(() => useQueryParam("network", NETWORKS, "mainnet"));

    act(() => result.current[1]("testnet"));

    expect(window.location.pathname).toBe("/dashboard");
    expect(window.location.hash).toBe("#charts");
    expect(window.location.search).toBe("?network=testnet");
  });

  it("re-reads the URL on popstate so the control matches the address bar", () => {
    const { result } = renderHook(() => useQueryParam("network", NETWORKS, "mainnet"));
    expect(result.current[0]).toBe("mainnet");

    act(() => {
      setUrl("?network=testnet");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });

    expect(result.current[0]).toBe("testnet");
  });
});
