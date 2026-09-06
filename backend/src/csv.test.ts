import { describe, expect, it } from "vitest";
import {
  HISTORY_CSV_COLUMNS,
  buildCsv,
  exportFilename,
  historyExportFilename,
  historyToCsv,
} from "./csv.js";
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

describe("historyToCsv output is unchanged by the buildCsv extraction", () => {
  /*
   * The literal below was produced by running the pre-refactor historyToCsv —
   * the version with the row loop inlined — against the fixture in this block.
   * It is a golden record of the old behaviour, not a restatement of the new
   * code's logic, so it fails if the extraction changed the bytes in any way:
   * column order, separators, CRLF placement including the trailing one, how
   * nulls are written, or how a genuine zero is written.
   */
  const fixture: HistoryResponse = {
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
        timestamp: "2026-09-02T21:40:00.000Z",
        closeTimeSeconds: null,
        congestionUsage: null,
        operations: 0,
        transactions: 0,
        p50Fee: null,
        p90Fee: null,
      },
      {
        // A zero is not a null: it must render as "0", not as an empty field.
        timestamp: "2026-09-02T21:45:00.000Z",
        closeTimeSeconds: 0,
        congestionUsage: 0,
        operations: 12,
        transactions: 3,
        p50Fee: 0,
        p90Fee: 0,
      },
    ],
  };

  const PRE_REFACTOR_OUTPUT =
    "network,range,timestamp,closeTimeSeconds,congestionUsage,operations,transactions,p50Fee,p90Fee\r\n" +
    "mainnet,24h,2026-09-02T21:35:00.000Z,5.12,0.4231,640,205,180,4200\r\n" +
    "mainnet,24h,2026-09-02T21:40:00.000Z,,,0,0,,\r\n" +
    "mainnet,24h,2026-09-02T21:45:00.000Z,0,0,12,3,0,0\r\n";

  it("is byte-identical to the pre-refactor output", () => {
    expect(historyToCsv(fixture)).toBe(PRE_REFACTOR_OUTPUT);
  });

  it("is byte-identical for an empty points array", () => {
    // Header plus its terminator, and nothing else.
    expect(historyToCsv({ ...fixture, points: [] })).toBe(
      "network,range,timestamp,closeTimeSeconds,congestionUsage,operations,transactions,p50Fee,p90Fee\r\n",
    );
  });
});

describe("buildCsv", () => {
  const columns = ["a", "b", "c"] as const;

  it("emits a header row followed by one row per entry", () => {
    const csv = buildCsv(columns, [
      { a: 1, b: 2, c: 3 },
      { a: 4, b: 5, c: 6 },
    ]);

    expect(csv).toBe("a,b,c\r\n1,2,3\r\n4,5,6\r\n");
  });

  it("terminates every row with CRLF, including the last", () => {
    const csv = buildCsv(columns, [{ a: 1, b: 2, c: 3 }]);

    expect(csv.endsWith("\r\n")).toBe(true);
    expect(csv.split("\r\n")).toEqual(["a,b,c", "1,2,3", ""]);
  });

  it("emits only a header when there are no rows", () => {
    expect(buildCsv(columns, [])).toBe("a,b,c\r\n");
  });

  it("writes null and undefined as empty fields, and zero as 0", () => {
    const csv = buildCsv(columns, [{ a: null, b: undefined, c: 0 }]);

    expect(csv).toBe("a,b,c\r\n,,0\r\n");
  });

  it("follows the column order given, not the key order of the row", () => {
    const csv = buildCsv(columns, [{ c: 3, a: 1, b: 2 }]);

    expect(csv).toBe("a,b,c\r\n1,2,3\r\n");
  });

  it("quotes values containing a comma, quote, CR or LF", () => {
    const csv = buildCsv(["v"] as const, [
      { v: "a,b" },
      { v: 'say "hi"' },
      { v: "line1\nline2" },
      { v: "cr\rhere" },
      { v: "plain" },
    ]);

    expect(csv).toBe(
      'v\r\n"a,b"\r\n"say ""hi"""\r\n"line1\nline2"\r\n"cr\rhere"\r\nplain\r\n',
    );
  });
});

describe("exportFilename", () => {
  it("names the resource, network and range", () => {
    expect(exportFilename("trends", "testnet", "90d", "csv")).toBe(
      "netpulse-trends-testnet-90d.csv",
    );
    expect(exportFilename("history", "mainnet", "6h", "json")).toBe(
      "netpulse-history-mainnet-6h.json",
    );
  });
});

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
