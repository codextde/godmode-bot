/** CSV for the admin exports (people, audit log): RFC 4180 quoting, safe to open in a spreadsheet. */

/**
 * One cell. Text that a spreadsheet would run as a formula (a leading = + - @, tab or carriage return, also after
 * leading spaces) gets a leading apostrophe, so exported names and addresses can never execute anything.
 */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "yes" : "no";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (/^\s*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(cells: unknown[]): string {
  return cells.map(csvCell).join(",");
}

/** A whole file: header line plus rows, CRLF line ends, with a byte-order mark so Excel reads it as UTF-8. */
export function toCsv(header: string[], rows: unknown[][]): string {
  return `﻿${[header, ...rows].map(csvRow).join("\r\n")}\r\n`;
}

/** The download response: always an attachment, never cached, never sniffed. `name` is a fixed word, not user input. */
export function csvResponse(name: string, csv: string): Response {
  const day = new Date().toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${name}-${day}.csv"`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
