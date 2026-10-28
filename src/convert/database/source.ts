// SPDX-License-Identifier: GPL-3.0-or-later
// What the database readers hand to the writers: tables with typed columns and their rows in blocks, as plain values.
// Readers and writers run in the database converter's worker (workers/database-convert.worker.ts).

/**
 * What a column holds. Values carry their own type; the kind refines how dates are written and what SQLite declares.
 * "datetime" (Access) leaves out what a value lacks: the time at midnight, the day of a time of day; a "timestamp"
 * (Parquet, Arrow) always has both.
 */
export type ColumnKind = 'integer' | 'real' | 'decimal' | 'boolean' | 'text' | 'datetime' | 'timestamp' | 'date' | 'time' | 'binary' | 'any';

/**
 * A value as the readers deliver it. Dates and times are Date objects with the wall time in their UTC fields (times of
 * day on December 30, 1899, as Access keeps them); exact decimals are strings in a decimal column; nested values are
 * already JSON text.
 */
export type Value = null | boolean | number | bigint | string | Date | Uint8Array;

export interface SourceColumn {
  name: string;
  kind: ColumnKind;
  /** Declared type for SQLite, e.g. "INTEGER" or "DECIMAL(12, 2)". */
  sqlType: string;
}

export interface SourceTable {
  name: string;
  columns: SourceColumn[];
  rowCount: number;
  /** Columns that make up the primary key, when the reader knows them. */
  primaryKey?: string[];
  /** The rows in blocks, one value per column. Breaking out of the loop ends the read. */
  rows(): AsyncGenerator<Value[][]>;
}

export interface SourceDatabase {
  tables: SourceTable[];
  /** What the reader left out or simplified, for the notes below the result. */
  notes: string[];
  close(): void;
}

export type Progress = (message: string, fraction?: number) => void;

/** Rows per block: large enough to keep the per-block work small, small enough for little memory. */
export const BLOCK = 5000;

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const DAY = 86_400_000;
/** Day zero of Excel and Access: December 30, 1899. */
export const EPOCH_1899 = Date.UTC(1899, 11, 30);

/** Whether a date is written as a day, a time of day or both. */
export type DateShape = 'date' | 'time' | 'datetime';

export function dateShape(date: Date, kind: ColumnKind): DateShape {
  if (kind === 'date' || kind === 'time') return kind;
  if (kind === 'timestamp') return 'datetime';
  const ms = date.getTime();
  // Access keeps times of day as dates on December 30, 1899.
  if (ms >= EPOCH_1899 && ms < EPOCH_1899 + DAY) return 'time';
  return ms % DAY === 0 ? 'date' : 'datetime';
}

/** ISO 8601 text of a date as SQLite writes it: 2026-09-01, 14:30:05 or 2026-09-01 14:30:05.250 (no time zone). */
export function isoText(date: Date, shape: DateShape): string {
  const year = date.getUTCFullYear();
  const day = `${year < 0 ? '-' : ''}${pad(Math.abs(year), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  if (shape === 'date') return day;
  const ms = date.getUTCMilliseconds();
  const time = `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${ms ? `.${pad(ms, 3)}` : ''}`;
  return shape === 'time' ? time : `${day} ${time}`;
}

/** A time of day given in some unit since midnight (ms = 1000 per second …) as a Date on December 30, 1899. */
export function timeOfDay(value: number | bigint, perSecond: number): Date {
  const ms = typeof value === 'bigint' ? Number((value * 1000n) / BigInt(perSecond)) : (value * 1000) / perSecond;
  return new Date(EPOCH_1899 + ms);
}

/**
 * Parses date and time text as SQLite stores it (2026-09-01, 2026-09-01 14:30:05.250, 2026-09-01T14:30Z, 14:30:05).
 * Text with a time zone offset other than Z stays text: its wall time would be ambiguous.
 */
export function parseIsoText(text: string): Date | null {
  const m = /^(\d{4})-(\d\d)-(\d\d)(?:[ T](\d\d):(\d\d)(?::(\d\d)(\.\d+)?)?Z?)?$/.exec(text) ?? /^()()()(\d\d):(\d\d)(?::(\d\d)(\.\d+)?)?$/.exec(text);
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', fraction = ''] = m;
  const ms = fraction ? Math.round(Number(fraction) * 1000) : 0;
  if (!y) return Number(h) < 24 && Number(mi) < 60 && Number(s) < 60 ? new Date(EPOCH_1899 + ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + ms) : null;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), ms));
  // Date.UTC rolls February 30 over into March; such text is no date.
  return date.getUTCDate() === Number(d) && date.getUTCHours() === Number(h) && date.getUTCMinutes() === Number(mi) ? date : null;
}

/** The number a decimal text stands for, when a double holds it to the digit (at most 15 significant digits). */
export function exactDecimal(text: string): number | null {
  const m = /^[-+]?(\d*)(?:\.(\d*))?$/.exec(text);
  if (!m) return null;
  const digits = `${m[1]}${m[2] ?? ''}`.replace(/^0+/, '').replace(/0+$/, '');
  return digits.length <= 15 ? Number(text) : null;
}

/** Decimal text without trailing zeros after the point: 64.0000 → 64, 980.50 → 980.5. */
export function trimDecimal(text: string): string {
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

/** Binary values up to this size are written as hexadecimal text, larger ones as a placeholder with their size. */
const HEX_LIMIT = 256;

function binaryText(bytes: Uint8Array): string {
  if (bytes.length > HEX_LIMIT) return `[binary, ${bytes.length.toLocaleString('en-US')} bytes]`;
  let hex = '0x';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0').toUpperCase();
  return hex;
}

/** A binary value as text for XLSX and CSV, counted for the notes. */
export function binaryCell(bytes: Uint8Array, changes: Changes): string {
  if (bytes.length > HEX_LIMIT) changes.count('binary-large', (n) => `${plural(n, 'binary value')} larger than ${HEX_LIMIT} bytes written as a placeholder with the size.`);
  else changes.count('binary-hex', (n) => `${plural(n, 'binary value')} written as hexadecimal text (0x…).`);
  return binaryText(bytes);
}

/** JSON for nested values (lists, structs, maps): big integers as numbers, dates as ISO text, bytes as hex. */
export function jsonText(value: unknown): string {
  return JSON.stringify(value, function (key, v) {
    const raw = (this as Record<string, unknown>)[key];
    if (typeof v === 'bigint') return `${v}n`;
    if (raw instanceof Date) return Number.isNaN(raw.getTime()) ? null : isoText(raw, dateShape(raw, 'datetime'));
    if (raw instanceof Uint8Array) return binaryText(raw);
    if (v instanceof Map) return Object.fromEntries(v);
    return v;
  }).replace(/"(-?\d+)n"/g, '$1');
}

/** Counts what a writer had to change, and says so in one note each. */
export class Changes {
  private counts = new Map<string, number>();
  private texts = new Map<string, (count: number) => string>();

  count(key: string, text: (count: number) => string): void {
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
    this.texts.set(key, text);
  }

  notes(): string[] {
    return [...this.counts].map(([key, count]) => this.texts.get(key)!(count));
  }
}

export const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
