import { describe, expect, it } from "vitest";
import { HISTORY_CSV_COLUMNS, historyExportFilename, historyToCsv } from "./csv.js";
import type { HistoryResponse } from "./db.js";

const history: HistoryResponse = {
  network: "mainnet",
  range: "24h",
  points: [
    {
      timestamp: "2026-09-02T21:35:00.000Z",
      closeTimeSeconds: 5.12,
      congestionUsage: 0.4231,
      operations: 640,
      transactions: 205,
      p50Fee: 180,
      p90Fee: 4200,
    },
    {
      // A bucket with ledger data but no fee snapshot — the nullable case
      // getHistory actually produces.
      timestamp: "2026-09-02T21:40:00.000Z",
      closeTimeSeconds: null,
      congestionUsage: null,
      operations: 0,
      transactions: 0,
      p50Fee: null,
      p90Fee: null,
    },
  ],
};

describe("historyToCsv", () => {
  it("emits a header row matching the HistoryPoint fields plus the envelope", () => {
    const [header] = historyToCsv(history).split("\r\n");

    expect(header).toBe(
      "network,range,timestamp,closeTimeSeconds,congestionUsage,operations,transactions,p50Fee,p90Fee",
    );
    expect(HISTORY_CSV_COLUMNS).toHaveLength(9);
  });

  it("writes one row per bucket with envelope fields denormalised", () => {
    const rows = historyToCsv(history).trimEnd().split("\r\n");

    expect(rows).toHaveLength(3); // header + 2 buckets
    expect(rows[1]).toBe(
      "mainnet,24h,2026-09-02T21:35:00.000Z,5.12,0.4231,640,205,180,4200",
    );
  });

  it("renders nulls as empty fields rather than the text null", () => {
    const rows = historyToCsv(history).trimEnd().split("\r\n");

    // Empty for the four nullable columns; zeros stay as zeros.
    expect(rows[2]).toBe("mainnet,24h,2026-09-02T21:40:00.000Z,,,0,0,,");
    expect(rows[2]).not.toContain("null");
  });

  it("terminates rows with CRLF including the last one", () => {
    const csv = historyToCsv(history);

    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n").filter(Boolean)).toHaveLength(3);
  });

  it("emits only a header when there are no buckets", () => {
    const csv = historyToCsv({ network: "testnet", range: "6h", points: [] });

    expect(csv).toBe(`${HISTORY_CSV_COLUMNS.join(",")}\r\n`);
  });

  it("quotes and escapes values that would otherwise break the format", () => {
    // No current field can contain these, but a serializer that only works for
    // today's data breaks silently when a column is added.
    const csv = historyToCsv({
      network: 'we"ird,name',
      range: "24h",
      points: [
        {
          timestamp: "2026-09-02T21:35:00.000Z",
          closeTimeSeconds: 1,
          congestionUsage: 0.5,
          operations: 1,
          transactions: 1,
          p50Fee: 1,
          p90Fee: 1,
        },
      ],
    });

    expect(csv.split("\r\n")[1].startsWith('"we""ird,name",24h,')).toBe(true);
  });
});

describe("historyExportFilename", () => {
  it("names the file after what was exported", () => {
    expect(historyExportFilename(history, "csv")).toBe("netpulse-history-mainnet-24h.csv");
    expect(historyExportFilename({ ...history, network: "testnet", range: "6h" }, "json")).toBe(
      "netpulse-history-testnet-6h.json",
    );
  });
});
