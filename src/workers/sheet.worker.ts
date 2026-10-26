// SPDX-License-Identifier: GPL-3.0-or-later
// Reads spreadsheets with SheetJS (Apache-2.0) off the main thread; for xlsx the formatting is added from the package.
import * as XLSX from 'xlsx';
import * as cptable from 'xlsx/dist/cpexcel.full';
import type { GridCell } from '../viewers/grid';
import { addFormatting } from './sheet-styled';
import type { SheetRequest, SheetResponse, SheetData } from './sheet-types';

// Legacy .xls and DBF files store text in Windows code pages.
XLSX.set_cptable(cptable);

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// SheetJS returns the cell's date and time as UTC, independent of the viewer's time zone.
function formatDate(date: Date): string {
  const hasTime = date.getUTCHours() || date.getUTCMinutes() || date.getUTCSeconds();
  return hasTime ? date.toLocaleString('en-US', { timeZone: 'UTC' }) : date.toLocaleDateString('en-US', { timeZone: 'UTC' });
}

function convert(name: string, sheet: XLSX.WorkSheet): SheetData {
  const ref = sheet['!ref'];
  if (!ref) return { name, rows: [], columnCount: 0, columnWidths: [], firstRow: 0 };
  const range = XLSX.utils.decode_range(ref);
  const dense = (sheet['!data'] ?? []) as (XLSX.CellObject | undefined)[][];
  const rows: GridCell[][] = [];
  // Formatting often stretches the used range far beyond the data; trim to the last filled row and column.
  let columnCount = 0;
  let rowCount = 0;
  // Walk the stored cells only; the declared range can span millions of empty cells.
  for (let r = range.s.r; r <= Math.min(range.e.r, dense.length - 1); r++) {
    const source = dense[r] ?? [];
    const row: GridCell[] = [];
    for (let c = 0; c < Math.min(source.length, range.e.c + 1); c++) {
      const cell = source[c];
      if (!cell) {
        row.push('');
        continue;
      }
      let text = cell.w ?? (cell.v === undefined || cell.v === null ? '' : String(cell.v));
      if (cell.t === 'b' && cell.w === undefined) text = cell.v ? 'TRUE' : 'FALSE';
      if (cell.t === 'd' && cell.v instanceof Date) text = formatDate(cell.v);
      if (cell.t === 'n' || cell.t === 'd' || cell.f) {
        row.push({ text, numeric: cell.t === 'n' || cell.t === 'd', formula: cell.f ? `=${cell.f}` : undefined });
      } else {
        row.push(text);
      }
      if (text) {
        columnCount = Math.max(columnCount, c + 1);
        rowCount = r - range.s.r + 1;
      }
    }
    rows.push(row);
  }
  rows.length = rowCount;
  for (const row of rows) row.length = Math.min(row.length, columnCount);
  const columnWidths = (sheet['!cols'] ?? []).map((col) =>
    col?.wpx ? Math.round(col.wpx) : col?.wch ? Math.round(col.wch * 7 + 12) : (undefined as unknown as number),
  );
  return { name, rows, columnCount, columnWidths, firstRow: range.s.r };
}

self.onmessage = async (event: MessageEvent<SheetRequest>) => {
  const { buffer, csv, styled } = event.data;
  try {
    const options: XLSX.ParsingOptions = { dense: true, cellDates: true, cellNF: false, cellStyles: false };
    const workbook = csv
      ? XLSX.read(decodeText(new Uint8Array(buffer)), { ...options, type: 'string', raw: false })
      : XLSX.read(new Uint8Array(buffer), { ...options, type: 'array' });
    const sheets = workbook.SheetNames.map((name) => convert(name, workbook.Sheets[name]));
    let formatted = false;
    if (styled) {
      try {
        await addFormatting(buffer, sheets);
        formatted = true;
      } catch (error) {
        // The values are shown either way; formatting is a bonus.
        console.warn('Formatting not readable:', error);
      }
    }
    const response: SheetResponse = { ok: true, sheets, formatted };
    self.postMessage(response);
  } catch (error) {
    const response: SheetResponse = { ok: false, error: error instanceof Error ? error.message : String(error) };
    self.postMessage(response);
  }
};
