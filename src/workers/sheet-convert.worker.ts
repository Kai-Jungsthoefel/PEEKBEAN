// SPDX-License-Identifier: GPL-3.0-or-later
// Converts spreadsheets with SheetJS (Apache-2.0) off the main thread: to a workbook (XLSX, XLS, XLSB, ODS, FODS), to
// one HTML page with a table per sheet, or to CSV one file per sheet. SheetJS keeps values, formulas and number
// formats, not the formatting.
import * as XLSX from 'xlsx';
import { readWorkbook } from './sheet-read';

export interface SheetConvertRequest {
  buffer: ArrayBuffer;
  /** CSV or TSV, read as text. */
  text: boolean;
  target: 'xlsx' | 'xls' | 'xlsb' | 'ods' | 'fods' | 'html' | 'csv';
  /** Title of the HTML page. */
  name: string;
  separator: string;
  /** Starts CSV files with a byte order mark, so Excel reads them as UTF-8. */
  bom: boolean;
}

export type SheetConvertResponse =
  | { ok: true; workbook: Uint8Array } // a workbook or the HTML page
  | { ok: true; sheets: { name: string; csv: Uint8Array }[] }
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

self.onmessage = (event: MessageEvent<SheetConvertRequest>) => {
  const { buffer, text, target, name, separator, bom } = event.data;
  try {
    const workbook = readWorkbook(buffer, text, { cellDates: true, cellNF: true });
    if (target === 'html') {
      const data = new TextEncoder().encode(htmlPage(workbook, name));
      post({ ok: true, workbook: data }, [data.buffer]);
      return;
    }
    if (target !== 'csv') {
      const data = new Uint8Array(XLSX.write(workbook, { bookType: target, type: 'array', compression: true }) as ArrayBuffer);
      post({ ok: true, workbook: data }, [data.buffer]);
      return;
    }
    const encoder = new TextEncoder();
    const sheets = workbook.SheetNames.filter((name) => workbook.Sheets[name]['!ref']).map((name) => ({
      name,
      csv: encoder.encode((bom ? '﻿' : '') + XLSX.utils.sheet_to_csv(workbook.Sheets[name], { FS: separator })),
    }));
    if (sheets.length === 0) throw new Error('The file contains no data.');
    post({ ok: true, sheets }, sheets.map((s) => s.csv.buffer));
  } catch (error) {
    post({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
