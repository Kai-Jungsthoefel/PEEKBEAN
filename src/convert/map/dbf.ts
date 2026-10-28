// SPDX-License-Identifier: GPL-3.0-or-later
// The dBASE III table of a shapefile, in UTF-8 (the .cpg file says so). Field names have at most 10 ASCII characters
// and are unique; each attribute gets the narrowest type that holds all its values: logical, date, numeric or text.

export interface DbfResult {
  data: Uint8Array;
  /** Attributes whose field name had to change: [attribute, field]. */
  renamed: [string, string][];
  /** Attributes left out beyond the 255 fields dBASE allows. */
  dropped: string[];
  /** Text values cut to 254 bytes. */
  cut: number;
}

interface Field {
  name: string;
  type: 'C' | 'N' | 'L' | 'D';
  length: number;
  decimals: number;
  write(value: unknown, out: Uint8Array, at: number): void;
}

const MAX_FIELDS = 255;
const MAX_TEXT = 254;
/** Widest numeric field; GDAL writes real numbers 24 wide as well. */
const MAX_NUMBER = 24;
const DATE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const encoder = new TextEncoder();

const TRANSLITERATION: Record<string, string> = { ä: 'ae', ö: 'oe', ü: 'ue', Ä: 'Ae', Ö: 'Oe', Ü: 'Ue', ß: 'ss', æ: 'ae', Æ: 'AE', ø: 'o', Ø: 'O', œ: 'oe', Œ: 'OE', ł: 'l', Ł: 'L' };

/** A field name of letters, digits and underscores, starting with a letter, at most 10 characters. */
function fieldName(attribute: string): string {
  let name = attribute
    .replace(/[äöüÄÖÜßæÆøØœŒłŁ]/g, (c) => TRANSLITERATION[c])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_]+/g, '_')
    .replace(/^_+(?=.)/, '');
  if (!name || name === '_') name = 'FIELD';
  if (!/^[A-Za-z]/.test(name)) name = `F${name}`;
  return name.slice(0, 10);
}

function uniqueField(base: string, used: Set<string>): string {
  let name = base;
  for (let n = 2; used.has(name.toUpperCase()); n++) name = `${base.slice(0, 10 - String(n).length - 1)}_${n}`;
  used.add(name.toUpperCase());
  return name;
}

/** A number in plain digits, as dBASE wants it; null for those too large for that. */
function plain(n: number): string | null {
  const text = String(n);
  if (!/e/i.test(text)) return text;
  return Math.abs(n) < 1 ? n.toFixed(20).replace(/\.?0+$/, '') : null;
}

function writeAscii(text: string, out: Uint8Array, at: number): void {
  for (let i = 0; i < text.length; i++) out[at + i] = text.charCodeAt(i);
}

/** Bytes of the UTF-8 text, cut at a character boundary to fit `max`. */
function utf8(text: string, max: number): { bytes: Uint8Array; cut: boolean } {
  const bytes = encoder.encode(text);
  if (bytes.length <= max) return { bytes, cut: false };
  let end = max;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return { bytes: bytes.subarray(0, end), cut: true };
}

function analyze(name: string, values: unknown[], counter: { cut: number }): Field {
  let kind: 'none' | 'bool' | 'number' | 'date' | 'text' = 'none';
  for (const value of values) {
    if (value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value))) continue;
    const type = typeof value === 'boolean' ? 'bool' : typeof value === 'number' ? 'number' : typeof value === 'string' && DATE.test(value) ? 'date' : 'text';
    kind = kind === 'none' || kind === type ? type : 'text';
    if (kind === 'text') break;
  }
  const isNull = (v: unknown) => v === null || v === undefined || (typeof v === 'number' && !Number.isFinite(v));

  if (kind === 'bool') {
    return { name, type: 'L', length: 1, decimals: 0, write: (v, out, at) => writeAscii(isNull(v) ? '?' : v ? 'T' : 'F', out, at) };
  }
  if (kind === 'date') {
    return { name, type: 'D', length: 8, decimals: 0, write: (v, out, at) => !isNull(v) && writeAscii(String(v).replace(/-/g, ''), out, at) };
  }
  if (kind === 'number') {
    let whole = 1;
    let decimals = 0;
    let fits = true;
    for (const value of values) {
      if (isNull(value)) continue;
      const text = plain(value as number);
      if (text === null) {
        fits = false;
        break;
      }
      const [int, fraction = ''] = text.split('.');
      whole = Math.max(whole, int.length);
      decimals = Math.max(decimals, Math.min(15, fraction.length));
    }
    if (fits && whole <= MAX_NUMBER) {
      if (whole + (decimals ? decimals + 1 : 0) > MAX_NUMBER) decimals = Math.max(0, MAX_NUMBER - whole - 1);
      const length = whole + (decimals ? decimals + 1 : 0);
      return {
        name,
        type: 'N',
        length,
        decimals,
        write: (v, out, at) => {
          if (isNull(v)) return;
          let text = (v as number).toFixed(decimals);
          // Rounding can add a digit in front (9.96 to one decimal is 10.0).
          if (text.length > length) text = (v as number).toExponential(Math.max(0, length - 7));
          writeAscii(text.padStart(length), out, at);
        },
      };
    }
  }
  // Text, and whatever does not fit another type, written as text.
  const encoded = values.map((v) => (isNull(v) ? null : utf8(typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v), MAX_TEXT)));
  let length = kind === 'none' ? 10 : 1;
  for (const e of encoded) {
    if (!e) continue;
    length = Math.max(length, e.bytes.length);
    if (e.cut) counter.cut++;
  }
  let row = 0;
  return {
    name,
    type: 'C',
    length,
    decimals: 0,
    // Called once per record in order, so the encoded values are taken one after the other.
    write: (_v, out, at) => {
      const e = encoded[row++];
      if (e) out.set(e.bytes, at);
    },
  };
}

/** A table with a record for each row; `columns` are attribute names, in the order the fields should have. */
export function writeDbf(columns: string[], rows: Record<string, unknown>[]): DbfResult {
  const used = new Set<string>();
  const renamed: [string, string][] = [];
  const counter = { cut: 0 };
  const kept = columns.slice(0, MAX_FIELDS);
  const fields = kept.map((column) => {
    const name = uniqueField(fieldName(column), used);
    if (name !== column) renamed.push([column, name]);
    return analyze(name, rows.map((r) => r[column]), counter);
  });
  // dBASE needs at least one field; GDAL adds one the same way.
  if (!fields.length) {
    fields.push({ name: 'FID', type: 'N', length: 10, decimals: 0, write: (v, out, at) => writeAscii(String(v).padStart(10), out, at) });
  }

  const headerLength = 32 + 32 * fields.length + 1;
  const recordLength = 1 + fields.reduce((sum, f) => sum + f.length, 0);
  const data = new Uint8Array(headerLength + rows.length * recordLength + 1);
  const view = new DataView(data.buffer);
  const today = new Date();
  data[0] = 0x03;
  data.set([today.getFullYear() - 1900, today.getMonth() + 1, today.getDate()], 1);
  view.setUint32(4, rows.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  fields.forEach((field, i) => {
    const at = 32 + 32 * i;
    writeAscii(field.name, data, at);
    data[at + 11] = field.type.charCodeAt(0);
    data[at + 16] = field.length;
    data[at + 17] = field.decimals;
  });
  data[headerLength - 1] = 0x0d;
  data.fill(0x20, headerLength, headerLength + rows.length * recordLength);
  rows.forEach((row, r) => {
    let at = headerLength + r * recordLength + 1;
    for (const [i, field] of fields.entries()) {
      field.write(kept.length ? row[kept[i]] : r + 1, data, at);
      at += field.length;
    }
  });
  data[data.length - 1] = 0x1a;
  return { data, renamed, dropped: columns.slice(MAX_FIELDS), cut: counter.cut };
}
