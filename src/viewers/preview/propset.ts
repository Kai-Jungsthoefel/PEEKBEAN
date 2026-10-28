// SPDX-License-Identifier: GPL-3.0-or-later
// OLE property set streams ([MS-OLEPS]): the "\x05SummaryInformation" kind of stream that Office, SolidWorks, Inventor
// and Solid Edge use for document properties. A stream holds one or two sets, each a list of typed values by ID;
// user-defined sets name their IDs in a dictionary (ID 0).
import { formatDate, formatNumber, type MetaRow } from '../../metadata/model';

export type PropertyValue = string | number | boolean | Date | Uint8Array | ClipboardData;

/** VT_CF: a picture in a clipboard format (Windows: metafile, DIB, EMF; some applications store PNG). */
export interface ClipboardData {
  format: number;
  data: Uint8Array;
}

export interface PropertySet {
  /** Lower-case GUID without braces. */
  fmtid: string;
  values: Map<number, PropertyValue>;
  /** Names of user-defined properties by ID. */
  names: Map<number, string>;
}

const FILETIME_EPOCH = 11_644_473_600_000;

function guid(bytes: Uint8Array, offset: number): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 16);
  const hex = (n: number, digits: number) => n.toString(16).padStart(digits, '0');
  const tail = Array.from(bytes.subarray(offset + 8, offset + 16), (b) => hex(b, 2)).join('');
  return `${hex(view.getUint32(0, true), 8)}-${hex(view.getUint16(4, true), 4)}-${hex(view.getUint16(6, true), 4)}-${tail.slice(0, 4)}-${tail.slice(4)}`;
}

function decoderFor(codepage: number): TextDecoder {
  const labels: Record<number, string> = { 65001: 'utf-8', 1200: 'utf-16le', 1252: 'windows-1252', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1250: 'windows-1250', 1251: 'windows-1251' };
  try {
    return new TextDecoder(labels[codepage] ?? 'windows-1252');
  } catch {
    return new TextDecoder('windows-1252');
  }
}

export function readPropertySets(stream: Uint8Array): PropertySet[] {
  const view = new DataView(stream.buffer, stream.byteOffset, stream.byteLength);
  if (stream.length < 48 || view.getUint16(0, true) !== 0xfffe) return [];
  const sets: PropertySet[] = [];
  const setCount = Math.min(view.getUint32(24, true), 4);
  for (let s = 0; s < setCount; s++) {
    const fmtid = guid(stream, 28 + s * 20);
    const base = view.getUint32(44 + s * 20, true);
    if (base + 8 > stream.length) continue;
    try {
      sets.push({ fmtid, ...readSet(stream, view, base) });
    } catch {
      // A damaged set: keep the others.
    }
  }
  return sets;
}

function readSet(stream: Uint8Array, view: DataView, base: number): Omit<PropertySet, 'fmtid'> {
  const size = view.getUint32(base, true);
  const end = Math.min(stream.length, base + size);
  const count = Math.min(view.getUint32(base + 4, true), 4096);
  const offsets: [number, number][] = [];
  for (let i = 0; i < count && base + 16 + i * 8 <= end; i++) offsets.push([view.getUint32(base + 8 + i * 8, true), base + view.getUint32(base + 12 + i * 8, true)]);
  // The code page (ID 1) decides how 8-bit strings are encoded.
  const codepageAt = offsets.find(([id]) => id === 1)?.[1];
  const codepage = codepageAt !== undefined && codepageAt + 6 <= end ? view.getUint16(codepageAt + 4, true) : 1252;
  const decoder = decoderFor(codepage);
  const values = new Map<number, PropertyValue>();
  const names = new Map<number, string>();
  for (const [id, at] of offsets) {
    if (at + 4 > end) continue;
    if (id === 0) {
      readDictionary(stream, view, at, end, codepage, decoder, names);
      continue;
    }
    const value = readValue(stream, view, at, end, codepage, decoder);
    if (value !== undefined) values.set(id, value);
  }
  return { values, names };
}

function readDictionary(stream: Uint8Array, view: DataView, at: number, end: number, codepage: number, decoder: TextDecoder, names: Map<number, string>): void {
  const count = Math.min(view.getUint32(at, true), 4096);
  let p = at + 4;
  for (let i = 0; i < count && p + 8 <= end; i++) {
    const id = view.getUint32(p, true);
    const length = view.getUint32(p + 4, true);
    p += 8;
    if (codepage === 1200) {
      const bytes = Math.min(length * 2, end - p);
      names.set(id, new TextDecoder('utf-16le').decode(stream.subarray(p, p + bytes)).replace(/\0+$/, ''));
      // Unicode names are padded to a multiple of four bytes.
      p += bytes + ((4 - (bytes % 4)) % 4);
    } else {
      const bytes = Math.min(length, end - p);
      names.set(id, decoder.decode(stream.subarray(p, p + bytes)).replace(/\0+$/, ''));
      p += bytes;
    }
  }
}

function readValue(stream: Uint8Array, view: DataView, at: number, end: number, codepage: number, decoder: TextDecoder): PropertyValue | undefined {
  const type = view.getUint16(at, true);
  const p = at + 4;
  const fits = (n: number) => p + n <= end;
  switch (type) {
    case 2: // VT_I2
      return fits(2) ? view.getInt16(p, true) : undefined;
    case 3: // VT_I4
    case 22: // VT_INT
      return fits(4) ? view.getInt32(p, true) : undefined;
    case 18: // VT_UI2
      return fits(2) ? view.getUint16(p, true) : undefined;
    case 19: // VT_UI4
    case 23: // VT_UINT
      return fits(4) ? view.getUint32(p, true) : undefined;
    case 20: // VT_I8
      return fits(8) ? Number(view.getBigInt64(p, true)) : undefined;
    case 21: // VT_UI8
      return fits(8) ? Number(view.getBigUint64(p, true)) : undefined;
    case 4: // VT_R4
      return fits(4) ? view.getFloat32(p, true) : undefined;
    case 5: // VT_R8
      return fits(8) ? view.getFloat64(p, true) : undefined;
    case 7: // VT_DATE: days since 30 December 1899
      return fits(8) ? new Date(Date.UTC(1899, 11, 30) + view.getFloat64(p, true) * 86_400_000) : undefined;
    case 11: // VT_BOOL
      return fits(2) ? view.getInt16(p, true) !== 0 : undefined;
    case 30: { // VT_LPSTR, in the set's code page
      if (!fits(4)) return undefined;
      const length = Math.min(view.getUint32(p, true), end - p - 4);
      const bytes = stream.subarray(p + 4, p + 4 + length);
      return (codepage === 1200 ? new TextDecoder('utf-16le') : decoder).decode(bytes).replace(/\0+$/, '');
    }
    case 31: { // VT_LPWSTR
      if (!fits(4)) return undefined;
      const length = Math.min(view.getUint32(p, true) * 2, end - p - 4);
      return new TextDecoder('utf-16le').decode(stream.subarray(p + 4, p + 4 + length)).replace(/\0+$/, '');
    }
    case 64: { // VT_FILETIME: 100 ns intervals since 1601; small values are durations (editing time)
      if (!fits(8)) return undefined;
      const ticks = view.getUint32(p, true) + view.getUint32(p + 4, true) * 2 ** 32;
      if (!ticks) return undefined;
      const ms = ticks / 10_000;
      return ms > FILETIME_EPOCH ? new Date(ms - FILETIME_EPOCH) : ms / 1000;
    }
    case 65: { // VT_BLOB
      if (!fits(4)) return undefined;
      const length = Math.min(view.getUint32(p, true), end - p - 4);
      return stream.subarray(p + 4, p + 4 + length);
    }
    case 71: { // VT_CF: size (including the format field), format, data
      if (!fits(8)) return undefined;
      const length = Math.min(view.getUint32(p, true), end - p - 4);
      return { format: view.getInt32(p + 4, true), data: stream.subarray(p + 8, p + 4 + length) };
    }
    default:
      return undefined;
  }
}

/** Well-known sets: Office summary information, document summary information and its user-defined section. */
export const SUMMARY_INFORMATION = 'f29f85e0-4ff9-1068-ab91-08002b27b3d9';
export const DOCUMENT_SUMMARY = 'd5cdd502-2e9c-101b-9397-08002b2cf9ae';
export const USER_DEFINED = 'd5cdd505-2e9c-101b-9397-08002b2cf9ae';

/** Labels of the standard summary properties that are worth showing. */
export const SUMMARY_LABELS: Record<number, string> = {
  2: 'Title',
  3: 'Subject',
  4: 'Author',
  5: 'Keywords',
  6: 'Comments',
  8: 'Last saved by',
  9: 'Revision',
  12: 'Created',
  13: 'Last saved',
  18: 'Application',
};

export const DOCUMENT_SUMMARY_LABELS: Record<number, string> = {
  2: 'Category',
  14: 'Manager',
  15: 'Company',
};

/** A value as text for the properties list; pictures, blobs and dates before 1981 (unset fields) give "". */
export function propertyText(value: PropertyValue | undefined): string {
  if (value === undefined || value instanceof Uint8Array || (typeof value === 'object' && !(value instanceof Date))) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime()) || value.getUTCFullYear() < 1981) return '';
    // Date-only fields (Inventor's creation date) are stored as midnight UTC.
    const midnight = value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;
    return midnight ? value.toLocaleDateString('en-US', { dateStyle: 'medium', timeZone: 'UTC' }) : formatDate(value);
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return formatNumber(value, 4);
  return value.replace(/\0+$/, '').trim();
}

/** Rows for the IDs in `labels`, in that order; `overrides` turn coded values into text. */
export function labelledRows(set: PropertySet | undefined, labels: Record<number, string>, overrides: Record<number, (v: PropertyValue) => string> = {}): MetaRow[] {
  if (!set) return [];
  const rows: MetaRow[] = [];
  for (const [id, label] of Object.entries(labels)) {
    const value = set.values.get(Number(id));
    const text = value === undefined ? '' : (overrides[Number(id)]?.(value) ?? propertyText(value));
    if (text) rows.push({ label, value: text });
  }
  return rows;
}

/** Rows for the properties a set names itself (user-defined properties, Solid Edge sets). */
export function namedRows(set: PropertySet | undefined, skip: RegExp = /^$/): MetaRow[] {
  if (!set) return [];
  const rows: MetaRow[] = [];
  for (const [id, name] of set.names) {
    if (id === 255 || skip.test(name)) continue;
    const text = propertyText(set.values.get(id));
    if (text) rows.push({ label: name, value: text });
  }
  return rows;
}
