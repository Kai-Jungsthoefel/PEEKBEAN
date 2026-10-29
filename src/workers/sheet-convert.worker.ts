// SPDX-License-Identifier: GPL-3.0-or-later
// Converts spreadsheets with SheetJS (Apache-2.0) off the main thread: to a workbook (XLSX, XLS, XLSB, ODS, FODS), to
// one HTML page with a table per sheet, or to CSV, TSV, JSON or Markdown one file per sheet. SheetJS keeps values,
// formulas and number formats, not the formatting.
import * as XLSX from 'xlsx';
import { readWorkbook } from './sheet-read';

export interface SheetConvertRequest {
  buffer: ArrayBuffer;
  /** CSV or TSV, read as text. */
  text: boolean;
  target: 'xlsx' | 'xls' | 'xlsb' | 'ods' | 'fods' | 'html' | 'csv' | 'tsv' | 'json' | 'md';
  /** Title of the HTML page. */
  name: string;
  separator: string;
  /** Starts CSV and TSV files with a byte order mark, so Excel reads them as UTF-8. */
  bom: boolean;
}

export type SheetConvertResponse =
  | { ok: true; workbook: Uint8Array } // a workbook or the HTML page
  | { ok: true; sheets: { name: string; data: Uint8Array }[]; notes: string[] }
  | { ok: false; error: string };

const post = (response: SheetConvertResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(response, transfer);

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ESCAPES[c]);

/** SheetJS writes only the first sheet as HTML; this page has a heading and a table for each sheet. */
function htmlPage(workbook: XLSX.WorkBook, name: string): string {
  const sheets = workbook.SheetNames.filter((sheet) => workbook.Sheets[sheet]['!ref']).map(
    (sheet) => `<h2>${escape(sheet)}</h2>\n${XLSX.utils.sheet_to_html(workbook.Sheets[sheet], { header: '', footer: '' })}`,
  );
  const style = 'body{font-family:system-ui,sans-serif;margin:24px}table{border-collapse:collapse}td{border:1px solid #ccc;padding:2px 6px}';
  return `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${escape(name)}</title><style>${style}</style></head>\n<body>\n${sheets.join('\n')}\n</body>\n</html>\n`;
}

/** Dates as written in the sheet, without a time zone: SheetJS gives them in local time. */
function localDate(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return time === '00:00:00' ? day : `${day}T${time}`;
}

/**
 * The row with the column names: the first of the fullest rows near the top. A title above the table ("Parts list
 * gearbox A" in one cell) is left out instead of becoming the names. Counted in the sheet's range.
 */
function headerRow(sheet: XLSX.WorkSheet): number {
  const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null, blankrows: true }).slice(0, 20);
  const counts = rows.map((row) => row.filter((value) => value !== null && value !== '').length);
  return Math.max(0, counts.indexOf(Math.max(0, ...counts)));
}

/**
 * An array with an object per row, keyed by the header row. Workbooks give numbers, booleans and dates as such; CSV
 * and TSV give their text unchanged, so codes such as 00123 keep their leading zeros.
 */
function sheetJson(sheet: XLSX.WorkSheet, text: boolean, header: number): string {
  const range = XLSX.utils.decode_range(sheet['!ref']!);
  range.s.r += header;
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: null, raw: !text, rawNumbers: !text, range });
  // Dates are turned to text by their toJSON before a replacer sees them, so they are looked up in the row itself.
  const json = JSON.stringify(rows, function (this: Record<string, unknown>, key, value: unknown) {
    const own = this[key];
    return own instanceof Date ? localDate(own) : value;
  }, 2);
  return `${json}\n`;
}

/** A Markdown table with the header row as its head; pipes are escaped and line breaks become <br>. */
function sheetMarkdown(sheet: XLSX.WorkSheet, header: number): string {
  const range = XLSX.utils.decode_range(sheet['!ref']!);
  range.s.r += header;
  const rows = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1, raw: false, defval: '', blankrows: false, range });
  const width = Math.max(1, ...rows.map((row) => row.length));
  const cell = (value: unknown) => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, '<br>').trim();
  const line = (row: string[]) => `| ${Array.from({ length: width }, (_, i) => cell(row[i])).join(' | ')} |`;
  const [head = [], ...body] = rows;
  return `${[line(head), `|${' --- |'.repeat(width)}`, ...body.map(line)].join('\n')}\n`;
}

self.onmessage = (event: MessageEvent<SheetConvertRequest>) => {
  const { buffer, text, target, name, separator, bom } = event.data;
  try {
    const workbook = readWorkbook(buffer, text, { cellDates: true, cellNF: true });
    if (target === 'html') {
      const data = new TextEncoder().encode(htmlPage(workbook, name));
      post({ ok: true, workbook: data }, [data.buffer]);
      return;
    }
    if (target !== 'csv' && target !== 'tsv' && target !== 'json' && target !== 'md') {
      const data = new Uint8Array(XLSX.write(workbook, { bookType: target, type: 'array', compression: true }) as ArrayBuffer);
      post({ ok: true, workbook: data }, [data.buffer]);
      return;
    }
    const encoder = new TextEncoder();
    const notes: string[] = [];
    const write = (name: string, sheet: XLSX.WorkSheet) => {
      if (target !== 'json' && target !== 'md') return (bom ? '﻿' : '') + XLSX.utils.sheet_to_csv(sheet, { FS: target === 'tsv' ? '\t' : separator });
      const header = headerRow(sheet);
      if (header > 0) notes.push(`${workbook.SheetNames.length > 1 ? `${name}: ` : ''}${header === 1 ? 'The first row' : `The first ${header} rows`} above the column names ${header === 1 ? 'is' : 'are'} left out.`);
      return target === 'json' ? sheetJson(sheet, text, header) : sheetMarkdown(sheet, header);
    };
    const sheets = workbook.SheetNames.filter((name) => workbook.Sheets[name]['!ref']).map((name) => ({ name, data: encoder.encode(write(name, workbook.Sheets[name])) }));
    if (sheets.length === 0) throw new Error('The file contains no data.');
    post({ ok: true, sheets, notes }, sheets.map((s) => s.data.buffer));
  } catch (error) {
    post({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
