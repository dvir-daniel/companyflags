// CSV export shared by every list (flags, keys, history, approvals, customers).

// A spreadsheet runs a cell that starts with one of these as a formula ("CSV injection"); names, reasons and
// comments are free text, so such cells get a leading apostrophe, which spreadsheets show as plain text.
const FORMULA_START = /^[=+\-@\t\r]/;

/** One quoted CSV cell. Numbers stay numbers; text that a spreadsheet would run as a formula is neutralised. */
export function csvCell(v: unknown): string {
  let s = v == null ? '' : String(v);
  if (typeof v !== 'number' && FORMULA_START.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
}

/** Builds the file and hands it to the browser as a download. */
export function downloadCsv(filename: string, header: string[], rows: unknown[][]): void {
  // (typed loosely: the Node tests load this module for csvCell, and Node has no document)
  const doc = (globalThis as unknown as { document: { createElement(tag: 'a'): { href: string; download: string; click(): void } } }).document;
  const url = URL.createObjectURL(new Blob([toCsv(header, rows)], { type: 'text/csv' }));
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  // revoking at once can cancel the download in some browsers: give it a moment
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
