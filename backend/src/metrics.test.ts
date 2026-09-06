import { beforeEach, describe, expect, it } from "vitest";
import { buildHealthResponse, congestionBand } from "./metrics.js";
import { stores } from "./poller.js";
import type { LedgerSample } from "./types.js";

describe("congestionBand", () => {
  it("returns 'unknown' for null input", () => {
    expect(congestionBand(null)).toBe("unknown");
  });

  it("returns 'low' for values just under 0.5", () => {
    expect(congestionBand(0)).toBe("low");
    expect(congestionBand(0.499)).toBe("low");
  });

  it("returns 'moderate' for values at and just over 0.5", () => {
    expect(congestionBand(0.5)).toBe("moderate");
    expect(congestionBand(0.501)).toBe("moderate");
  });

  it("returns 'moderate' for values just under 0.8", () => {
    expect(congestionBand(0.799)).toBe("moderate");
  });

  it("returns 'high' for values at and over 0.8", () => {
    expect(congestionBand(0.8)).toBe("high");
    expect(congestionBand(0.801)).toBe("high");
    expect(congestionBand(1.0)).toBe("high");
  });

  it("respects a custom high threshold", () => {
    expect(congestionBand(0.65, 0.7)).toBe("moderate");
    expect(congestionBand(0.7, 0.7)).toBe("high");
    expect(congestionBand(0.75, 0.7)).toBe("high");
  });
});

describe("buildHealthResponse ledgerCloseTime", () => {
  const ledger = (
    sequence: number,
    closeTimeSeconds: number | null,
  ): LedgerSample => ({
    sequence,
    closedAt: new Date(Date.UTC(2026, 8, 4, 11, 17, sequence)).toISOString(),
    closeTimeSeconds,
    successfulTransactionCount: 5,
    failedTransactionCount: 0,
    operationCount: 10,
    txSetOperationCount: 10,
    baseFeeInStroops: 100,
    maxTxSetSize: 1000,
  });

  const seed = (samples: LedgerSample[]) => {
    const store = stores.mainnet as any;
    store.ledgers = samples;
    store.lastSuccessAt = new Date();
  };

  beforeEach(() => {
    const store = stores.mainnet as any;
    store.ledgers = [];
    store.feeSnapshots = [];
    store.sorobanSamples = [];
    store.lastSuccessAt = null;
    store.lastErrorMessage = null;
  });

  it("averages the plausible samples only", () => {
    /*
     * The reported case: a 50-ledger window holding stale records alongside
     * current ones. Averaging all of them gave about -8.4 months. This is the
     * last line of defence — the ingestion fixes stop such values being
     * produced, but rows persisted before them must not poison the number
     * either.
     */
    seed([
      ledger(1, -36192909),
      ledger(2, -36192904),
      ledger(3, 6),
      ledger(4, 5),
      ledger(5, 7),
    ]);

    const health = buildHealthResponse("mainnet");

    expect(health.ledgerCloseTime.averageSeconds).toBe(6); // avg(6, 5, 7)
  });

  it("ignores nulls and zeroes as it always ignored nulls", () => {
    seed([ledger(1, null), ledger(2, 0), ledger(3, 4), ledger(4, 6)]);

    const health = buildHealthResponse("mainnet");

    expect(health.ledgerCloseTime.averageSeconds).toBe(5); // avg(4, 6)
  });

  it("reports null when no sample is usable", () => {
    // No data is not the same as zero seconds.
    seed([ledger(1, -5), ledger(2, null)]);

    const health = buildHealthResponse("mainnet");

    expect(health.ledgerCloseTime.averageSeconds).toBeNull();
    expect(health.ledgerCloseTime.currentSeconds).toBeNull();
  });

  it("reports the newest usable sample as currentSeconds", () => {
    seed([ledger(1, 5), ledger(2, 6), ledger(3, -36192904)]);

    const health = buildHealthResponse("mainnet");

    expect(health.ledgerCloseTime.currentSeconds).toBe(6);
  });
});
