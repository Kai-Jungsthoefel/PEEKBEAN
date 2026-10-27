// SPDX-License-Identifier: GPL-3.0-or-later
// The dBASE table of a shapefile: one record of attributes per shape. Text is decoded with the code page from the
// .cpg file, else from the header's language driver byte, else as UTF-8 if it is valid UTF-8, else Windows-1252.

/** Language driver IDs of dBASE headers and the code pages they stand for (only those browsers can decode). */
const LANGUAGE_DRIVERS: Record<number, string> = {
  0x03: 'windows-1252', 0x57: 'windows-1252', 0x58: 'windows-1252', 0x59: 'windows-1252', 0x65: 'ibm866',
  0x13: 'shift_jis', 0x4d: 'gbk', 0x4e: 'euc-kr', 0x4f: 'big5', 0x50: 'windows-874', 0x78: 'big5', 0x79: 'euc-kr',
  0x7a: 'gbk', 0x7b: 'shift_jis', 0x7c: 'windows-874', 0x7d: 'windows-1255', 0x7e: 'windows-1256',
  0xc8: 'windows-1250', 0xc9: 'windows-1251', 0xca: 'windows-1254', 0xcb: 'windows-1253', 0xcc: 'windows-1257',
};

/** The label of a .cpg file ("UTF-8", "1252", "ANSI 1251", "88591" …) as a TextDecoder label, or null. */
export function cpgEncoding(cpg: string): string | null {
  const value = cpg.trim().toLowerCase().replace(/^ansi\s*/, '').replace(/^cp/, '');
  if (!value) return null;
  if (/^(utf-?8|65001)$/.test(value)) return 'utf-8';
  if (/^125\d$/.test(value) || value === '874') return `windows-${value}`;
  if (value === '866') return 'ibm866';
  const iso = /^(?:iso-?)?8859-?(\d+)$/.exec(value);
  if (iso) return `iso-8859-${iso[1]}`;
  try {
    new TextDecoder(value);
    return value;
  } catch {
    return null;
  }
}

export interface DbfTable {
  fields: string[];
  records: Record<string, unknown>[];
  encoding: string;
}

export function readDbf(buffer: ArrayBuffer, cpg?: string): DbfTable {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  if (bytes.length < 32) throw new Error('The .dbf file is too short.');
  const count = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);

  const fields: { name: string; type: string; offset: number; length: number }[] = [];
  let offset = 1;
  for (let at = 32; at + 32 <= headerLength && bytes[at] !== 0x0d; at += 32) {
    const nameEnd = bytes.indexOf(0, at);
    const name = String.fromCharCode(...bytes.subarray(at, Math.min(at + 11, nameEnd < 0 ? at + 11 : nameEnd))).trim();
    const type = String.fromCharCode(bytes[at + 11]).toUpperCase();
    const length = bytes[at + 16];
    fields.push({ name: name || `FIELD${fields.length + 1}`, type, offset, length });
    offset += length;
  }

  // Duplicate names (truncated to 10 characters) would overwrite each other.
  const seen = new Map<string, number>();
  for (const field of fields) {
    const n = seen.get(field.name) ?? 0;
    seen.set(field.name, n + 1);
    if (n) field.name = `${field.name}_${n + 1}`;
  }

  const end = Math.min(bytes.length, headerLength + count * recordLength);
  let encoding = (cpg && cpgEncoding(cpg)) || LANGUAGE_DRIVERS[bytes[29]] || null;
  if (!encoding) {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(headerLength, end));
      encoding = 'utf-8';
    } catch {
      encoding = 'windows-1252';
    }
  }
  const decoder = new TextDecoder(encoding);
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to)).trim();

  const records: Record<string, unknown>[] = [];
  // Records marked as deleted ("*") are kept: the shapes still count them, record for record.
  for (let i = 0; i < count; i++) {
    const start = headerLength + i * recordLength;
    if (start >= bytes.length || bytes[start] === 0x1a) break;
    const record: Record<string, unknown> = {};
    for (const field of fields) {
      const from = start + field.offset;
      const to = Math.min(from + field.length, bytes.length);
      record[field.name] = value(field.type, from, to);
    }
    records.push(record);
  }

  function value(type: string, from: number, to: number): unknown {
    switch (type) {
      case 'N':
      case 'F': {
        const text = ascii(from, to);
        if (!text || /^[*?]+$/.test(text)) return null;
        const n = Number(text);
        return Number.isFinite(n) ? n : text;
      }
      case 'D': {
        const text = ascii(from, to);
        return /^\d{8}$/.test(text) && text !== '00000000' ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : null;
      }
      case 'L': {
        const c = String.fromCharCode(bytes[from]).toUpperCase();
        return 'TY'.includes(c) ? true : 'FN'.includes(c) ? false : null;
      }
      case 'I':
      case '+':
        return to - from >= 4 ? view.getInt32(from, true) : null;
      case 'O':
        return to - from >= 8 ? view.getFloat64(from, true) : null;
      case 'B':
        // Visual FoxPro stores doubles here; dBASE a memo block number, which needs the .dbt file.
        return to - from === 8 ? view.getFloat64(from, true) : null;
      case 'Y':
        return to - from >= 8 ? Number(view.getBigInt64(from, true)) / 10000 : null;
      case '@':
      case 'T': {
        if (to - from < 8) return null;
        const day = view.getInt32(from, true);
        const ms = view.getInt32(from + 4, true);
        // Julian day number 2440588 is 1970-01-01.
        return day ? new Date((day - 2440588) * 86400000 + ms).toISOString().replace('.000Z', 'Z') : null;
      }
      case 'M':
      case 'G':
      case 'P':
        // Memo, OLE and picture fields live in a separate .dbt/.fpt file.
        return null;
      default: {
        let stop = to;
        while (stop > from && (bytes[stop - 1] === 0x20 || bytes[stop - 1] === 0)) stop--;
        let begin = from;
        while (begin < stop && bytes[begin] === 0x20) begin++;
        return decoder.decode(bytes.subarray(begin, stop));
      }
    }
  }

  return { fields: fields.map((f) => f.name), records, encoding };
}
