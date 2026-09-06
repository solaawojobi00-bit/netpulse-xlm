import { afterEach, describe, expect, it, vi } from "vitest";
import { TREND_RANGES, fetchTrends } from "./api";

/*
 * Covers fetchTrends only. The API client had no direct tests before this;
 * rather than retrofit the whole module, this pins the two things #93 is
 * actually contracting: the request it issues, and that a non-ok response
 * throws in the same shape as its siblings rather than resolving with junk.
 */

const okResponse = (body: unknown) =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTrends", () => {
  it("requests the given network and range", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        okResponse({ network: "testnet", range: "1y", points: [] }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    await fetchTrends("testnet", "1y");

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/trends?network=testnet&range=1y",
    );
  });

  it("defaults to mainnet and 90d", async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValue(
        okResponse({ network: "mainnet", range: "90d", points: [] }),
      );
    vi.stubGlobal("fetch", fetchSpy);

    await fetchTrends();

    expect(fetchSpy).toHaveBeenCalledWith(
      "/api/trends?network=mainnet&range=90d",
    );
  });

  it("returns the parsed body", async () => {
    const body = {
      network: "mainnet",
      range: "90d",
      points: [
        {
          date: "2026-09-04",
          closeTimeSeconds: 5.62,
          congestionUsage: 0.4213,
          maxCongestionUsage: 0.9871,
          operations: 3427194,
          successfulTransactions: 1044821,
          failedTransactions: 20713,
          p50Fee: 137,
          p90Fee: 9042,
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(okResponse(body)));

    await expect(fetchTrends()).resolves.toEqual(body);
  });

  it("throws with the same message format as the other helpers", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 503 }),
    );

    await expect(fetchTrends()).rejects.toThrow("GET /api/trends failed: 503");
  });

  it("does not swallow a rejected fetch", async () => {
    // A network failure must surface, not resolve as an empty result.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));

    await expect(fetchTrends()).rejects.toThrow("offline");
  });
});

describe("TREND_RANGES", () => {
  it("lists exactly the ranges the backend recognises", () => {
    expect(TREND_RANGES).toEqual(["30d", "90d", "1y"]);
  });

  it("is readonly at the type level", () => {
    // @ts-expect-error TREND_RANGES is `as const`; pushing to it must not compile.
    TREND_RANGES.push("5y");
  });

  it("makes an unrecognised range a type error at the call site", async () => {
    /*
     * The point of deriving TrendRange from TREND_RANGES: the backend would
     * silently coerce "5y" to 90d and return plausible-looking data for a
     * window nobody asked for, so the mistake has to be caught here instead.
     *
     * `@ts-expect-error` fails the build if the line ever *stops* erroring, so
     * this asserts the constraint rather than merely describing it.
     */
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ network: "mainnet", range: "90d", points: [] }),
        ),
    );

    // @ts-expect-error "5y" is not a TrendRange.
    await fetchTrends("mainnet", "5y");
  });
});
