import type { HistoryResponse } from "./db.js";

/*
 * A hand-rolled writer rather than a dependency: the row shape is flat with a
 * fixed set of columns, so a CSV library would be a lot of surface for a few
 * lines of quoting.
 */

/** Columns in emitted order. `network` and `range` live on the HistoryResponse
 *  envelope and are denormalised onto every row, so an exported file stands on
 *  its own without the reader needing the request that produced it. */
export const HISTORY_CSV_COLUMNS = [
  "network",
  "range",
  "timestamp",
  "closeTimeSeconds",
  "congestionUsage",
  "operations",
  "transactions",
  "p50Fee",
  "p90Fee",
] as const;

/**
 * RFC 4180 quoting: wrap in double quotes when the value contains a comma,
 * quote, CR or LF, and double any embedded quote. None of the current fields
 * can contain those, but a serializer that only works for today's data is a
 * trap for whoever adds a column later.
 */
function escapeCsvValue(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Nulls become empty fields rather than the text "null", which is what
 *  spreadsheets and pandas read as missing. */
function formatCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return escapeCsvValue(String(value));
}

/**
 * Serialises a history response to CSV, one row per 5-minute bucket.
 * Rows are terminated with CRLF per RFC 4180, including the final row, which
 * is what Excel expects.
 */
export function historyToCsv(history: HistoryResponse): string {
  const lines = [HISTORY_CSV_COLUMNS.join(",")];

  for (const point of history.points) {
    const row: Record<(typeof HISTORY_CSV_COLUMNS)[number], string | number | null> = {
      network: history.network,
      range: history.range,
      timestamp: point.timestamp,
      closeTimeSeconds: point.closeTimeSeconds,
      congestionUsage: point.congestionUsage,
      operations: point.operations,
      transactions: point.transactions,
      p50Fee: point.p50Fee,
      p90Fee: point.p90Fee,
    };
    lines.push(HISTORY_CSV_COLUMNS.map((c) => formatCsvValue(row[c])).join(","));
  }

  return lines.join("\r\n") + "\r\n";
}

/** Stable, sortable filename that records what was exported. */
export function historyExportFilename(
  history: HistoryResponse,
  extension: "csv" | "json",
): string {
  return `netpulse-history-${history.network}-${history.range}.${extension}`;
}
