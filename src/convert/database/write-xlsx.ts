// SPDX-License-Identifier: GPL-3.0-or-later
// One sheet per table with SheetJS (Apache-2.0): a header row with the column names and a filter on it, numbers as
// numbers, dates as dates with an ISO-like format. Excel's limits are kept: 1,048,576 rows and 16,384 columns per
// sheet, 32,767 characters per cell, sheet names of up to 31 characters. Sheets are built in dense mode (rows of
// cells), which takes the least memory SheetJS allows.
import * as XLSX from 'xlsx';
import { binaryCell, Changes, dateShape, EPOCH_1899, exactDecimal, isoText, plural, type ColumnKind, type DateShape, type Progress, type SourceDatabase, type Value } from './source';

const MAX_ROWS = 1_048_576;
const MAX_COLUMNS = 16_384;
const MAX_TEXT = 32_767;
const DAY = 86_400_000;
const FORMATS: Record<DateShape, string> = { date: 'yyyy-mm-dd', time: 'hh:mm:ss', datetime: 'yyyy-mm-dd hh:mm:ss' };
/** The last day Excel knows: December 31, 9999. */
const LAST_DAY = 2_958_465;

/** Excel's serial number of a date: days since December 30, 1899, the time of day as the fraction. */
function serial(date: Date, shape: DateShape): number | null {
  const ms = date.getTime();
  if (shape === 'time') return (((ms - EPOCH_1899) % DAY) + DAY) % DAY / DAY;
  const days = (ms - EPOCH_1899) / DAY;
  // Excel counts a February 29, 1900 that never was: days before March 1900 are one less. It knows no earlier days.
  if (days < 2 || days >= LAST_DAY + 1) return null;
  return days < 61 ? days - 1 : days;
}

/** A sheet name Excel accepts: none of \ / ? * [ ] :, no apostrophe at either end, at most 31 characters, unique. */
function sheetName(name: string, used: Set<string>): string {
  const clean = name.replace(/[\\/?*[\]:]/g, '_').replace(/^'+|'+$/g, '').trim() || 'Table';
  let candidate = clean.slice(0, 31);
  // "History" is reserved by Excel for change tracking.
  for (let n = 2; used.has(candidate.toLowerCase()) || candidate.toLowerCase() === 'history'; n++) {
    const suffix = ` (${n})`;
    candidate = clean.slice(0, 31 - suffix.length) + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function cell(value: Value, kind: ColumnKind, changes: Changes): XLSX.CellObject | undefined {
  if (value === null) return undefined;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return { t: 'n', v: value };
    return { t: 's', v: String(value) };
  }
  if (typeof value === 'boolean') return { t: 'b', v: value };
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return { t: 'n', v: number };
    changes.count('bigint', (n) => `${plural(n, 'integer')} beyond 2^53 written as text, as Excel would round them.`);
    return { t: 's', v: String(value) };
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return undefined;
    const shape = dateShape(value, kind);
    const number = serial(value, shape);
    // Milliseconds only where there are some, as in the CSV.
    if (number !== null) return { t: 'n', v: number, z: value.getUTCMilliseconds() && shape !== 'date' ? `${FORMATS[shape]}.000` : FORMATS[shape] };
    changes.count('old-date', (n) => `${plural(n, 'date')} outside Excel's range (1900 to 9999) written as text.`);
    return { t: 's', v: isoText(value, shape) };
  }
  if (value instanceof Uint8Array) return { t: 's', v: binaryCell(value, changes) };
  if (kind === 'decimal') {
    const number = exactDecimal(value);
    if (number !== null) return { t: 'n', v: number };
    changes.count('decimal', (n) => `${plural(n, 'decimal')} with more than 15 digits written as text, as Excel would round them.`);
  }
  if (value.length > MAX_TEXT) {
    changes.count('long-text', (n) => `${plural(n, 'text')} longer than ${MAX_TEXT.toLocaleString('en-US')} characters cut to Excel's limit.`);
    return { t: 's', v: value.slice(0, MAX_TEXT) };
  }
  return { t: 's', v: value };
}

/** Column width in characters, from the header and the first rows. */
function width(name: string, values: (XLSX.CellObject | undefined)[]): number {
  let chars = name.length;
  for (const c of values) {
    if (!c) continue;
    const length = c.z ? (c.z as string).length : c.t === 'b' ? 5 : String(c.v).length;
    if (length > chars) chars = length;
  }
  return Math.min(60, Math.max(8, chars + 2));
}

export async function writeXlsx(db: SourceDatabase, progress: Progress): Promise<{ data: Uint8Array; notes: string[] }> {
  const workbook = XLSX.utils.book_new();
  const changes = new Changes();
  const notes = db.tables.length > 1 ? [`One sheet for each of the ${db.tables.length} tables.`] : [];
  const used = new Set<string>();
  const total = db.tables.reduce((sum, t) => sum + Math.min(t.rowCount, MAX_ROWS - 1), 0) || 1;
  let done = 0;
  for (const [index, table] of db.tables.entries()) {
    const label = `Table ${index + 1} of ${db.tables.length}: ${table.name}`;
    progress(label, done / total);
    const name = sheetName(table.name, used);
    if (name !== table.name) notes.push(`Table “${table.name}” is on sheet “${name}”; Excel allows only certain sheet names.`);
    const columns = table.columns.slice(0, MAX_COLUMNS);
    if (columns.length < table.columns.length) {
      notes.push(`Table “${table.name}” has ${table.columns.length.toLocaleString('en-US')} columns; only the first ${MAX_COLUMNS.toLocaleString('en-US')} fit on a sheet.`);
    }
    const kinds = columns.map((c) => c.kind);
    const data: (XLSX.CellObject | undefined)[][] = [columns.map((c) => ({ t: 's', v: c.name.slice(0, MAX_TEXT) }))];
    let cut = false;
    reading: for await (const block of table.rows()) {
      for (const row of block) {
        if (data.length === MAX_ROWS) {
          cut = true;
          break reading;
        }
        const cells: (XLSX.CellObject | undefined)[] = new Array(columns.length);
        for (let c = 0; c < columns.length; c++) cells[c] = cell(row[c], kinds[c], changes);
        data.push(cells);
      }
      done += block.length;
      progress(label, done / total);
    }
    if (cut) notes.push(`Table “${table.name}” has ${table.rowCount.toLocaleString('en-US')} rows; only the first ${(MAX_ROWS - 1).toLocaleString('en-US')} fit on a sheet.`);
    const range = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: data.length - 1, c: Math.max(0, columns.length - 1) } });
    const sample = data.slice(1, 201);
    const sheet: XLSX.WorkSheet = {
      '!data': data as XLSX.CellObject[][],
      '!ref': range,
      '!cols': columns.map((c, i) => ({ wch: width(c.name, sample.map((r) => r[i])) })),
    };
    if (columns.length) sheet['!autofilter'] = { ref: range };
    XLSX.utils.book_append_sheet(workbook, sheet, name);
  }
  progress('Writing the XLSX file …');
  const data = new Uint8Array(XLSX.write(workbook, { bookType: 'xlsx', type: 'array', compression: true }) as ArrayBuffer);
  return { data, notes: [...notes, ...changes.notes()] };
}
