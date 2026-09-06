import type { HistoryResponse, TrendsResponse } from "./db.js";

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

/** A single value a CSV cell can hold before formatting. */
export type CsvValue = string | number | null | undefined;

/**
 * Serialises a header row plus `rows` to CSV.
 *
 * Rows are terminated with CRLF per RFC 4180, **including the final row**,
 * which is what Excel expects. A row supplies its cells by column name; a
 * column with no entry becomes an empty field rather than shifting later
 * columns left, so a partial row cannot silently corrupt the file.
 *
 * Generic over the column tuple so `rows` is checked against the columns the
 * caller declared — passing a row keyed by a name not in `columns` is a type
 * error rather than a silently dropped value.
 */
export function buildCsv<const Columns extends readonly string[]>(
  columns: Columns,
  rows: readonly Readonly<Record<Columns[number], CsvValue>>[],
): string {
  const lines = [columns.join(",")];

  for (const row of rows) {
    lines.push(
      columns
        .map((column) => formatCsvValue(row[column as Columns[number]]))
        .join(","),
    );
  }

  return lines.join("\r\n") + "\r\n";
}

/**
 * Serialises a history response to CSV, one row per 5-minute bucket.
 */
export function historyToCsv(history: HistoryResponse): string {
  return buildCsv(
    HISTORY_CSV_COLUMNS,
    history.points.map((point) => ({
      network: history.network,
      range: history.range,
      timestamp: point.timestamp,
      closeTimeSeconds: point.closeTimeSeconds,
      congestionUsage: point.congestionUsage,
      operations: point.operations,
      transactions: point.transactions,
      p50Fee: point.p50Fee,
      p90Fee: point.p90Fee,
    })),
  );
}

/**
 * Stable, sortable filename that records what was exported.
 *
 * `resource` names what is being exported — `history`, `trends` — so a reader
 * with several downloads in one folder can tell them apart, and so the two
 * cannot collide on `network` and `range` alone.
 */
export function exportFilename(
  resource: string,
  network: string,
  range: string,
  extension: "csv" | "json",
): string {
  return `netpulse-${resource}-${network}-${range}.${extension}`;
}

/** `exportFilename` bound to the history resource. */
export function historyExportFilename(
  history: HistoryResponse,
  extension: "csv" | "json",
): string {
  return exportFilename("history", history.network, history.range, extension);
}

/**
 * Columns in emitted order, mirroring `HISTORY_CSV_COLUMNS`.
 *
 * `network` and `range` are denormalised onto every row for the same reason as
 * history: an exported file should stand on its own without the request that
 * produced it.
 *
 * Successful and failed transactions stay separate rather than summed, as they
 * are in the JSON. Summing them here to match history's single `transactions`
 * column would discard information the table holds, and a spreadsheet can add
 * two columns far more easily than it can recover one.
 */
export const TRENDS_CSV_COLUMNS = [
  "network",
  "range",
  "date",
  "closeTimeSeconds",
  "congestionUsage",
  "maxCongestionUsage",
  "operations",
  "successfulTransactions",
  "failedTransactions",
  "p50Fee",
  "p90Fee",
] as const;

/** Serialises a trends response to CSV, one row per day. */
export function trendsToCsv(trends: TrendsResponse): string {
  return buildCsv(
    TRENDS_CSV_COLUMNS,
    trends.points.map((point) => ({
      network: trends.network,
      range: trends.range,
      date: point.date,
      closeTimeSeconds: point.closeTimeSeconds,
      congestionUsage: point.congestionUsage,
      maxCongestionUsage: point.maxCongestionUsage,
      operations: point.operations,
      successfulTransactions: point.successfulTransactions,
      failedTransactions: point.failedTransactions,
      p50Fee: point.p50Fee,
      p90Fee: point.p90Fee,
    })),
  );
}

/** `exportFilename` bound to the trends resource. */
export function trendsExportFilename(
  trends: TrendsResponse,
  extension: "csv" | "json",
): string {
  return exportFilename("trends", trends.network, trends.range, extension);
}
