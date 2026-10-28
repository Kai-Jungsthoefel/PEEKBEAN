// SPDX-License-Identifier: GPL-3.0-or-later
// Access databases (.mdb, .accdb) through mdb-reader (MIT), as in the Access viewer. mdb-reader expects Node's Buffer
// as a global, from the "buffer" package (MIT). System tables (MSys*) and linked tables are left out; mdb-reader does
// not read queries, forms, relations or indexes.
import { Buffer } from 'buffer';
import type { Column } from 'mdb-reader';
import { BLOCK, plural, type ColumnKind, type SourceColumn, type SourceDatabase, type SourceTable, type Value } from './source';

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

/** Thrown when the database needs a password that was not given or is wrong. */
export class WrongPassword extends Error {
  name = 'WrongPassword';
}

const KINDS: Record<string, ColumnKind> = {
  boolean: 'boolean', byte: 'integer', integer: 'integer', long: 'integer', bigint: 'integer', currency: 'decimal', numeric: 'decimal',
  float: 'real', double: 'real', datetime: 'datetime', datetimextended: 'datetime', text: 'text', memo: 'text', repid: 'text',
  binary: 'binary', ole: 'binary', complex: 'text',
};

function sqlType(column: Column, unicodeText: boolean): string {
  switch (column.type) {
    case 'boolean': return 'BOOLEAN';
    case 'byte': return 'TINYINT';
    case 'integer': return 'SMALLINT';
    case 'long': return 'INTEGER';
    case 'bigint': return 'BIGINT';
    case 'currency': return 'DECIMAL(19, 4)';
    case 'numeric': return `DECIMAL(${column.precision ?? 18}, ${column.scale ?? 0})`;
    case 'float':
    case 'double': return 'REAL';
    case 'datetime':
    case 'datetimextended': return 'DATETIME';
    case 'text': return `VARCHAR(${unicodeText ? column.size / 2 : column.size})`;
    case 'binary':
    case 'ole': return 'BLOB';
    default: return 'TEXT';
  }
}

/** Date/Time Extended comes as text "2026.09.01 14:30:05.123456700"; the converter keeps milliseconds. */
function extendedDate(text: string): Date | string {
  const m = /^(\d{4})\.(\d\d)\.(\d\d) (\d\d):(\d\d):(\d\d)(?:\.(\d+))?$/.exec(text);
  if (!m) return text;
  const date = new Date(0);
  date.setUTCFullYear(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  date.setUTCHours(Number(m[4]), Number(m[5]), Number(m[6]), Math.floor(Number(`0.${m[7] ?? '0'}`) * 1000));
  return date;
}

/** One function per column turns what mdb-reader gives into a plain value. */
function converter(column: Column): (value: unknown) => Value {
  switch (column.type) {
    // Single precision: the digits it holds, not those of the double it became.
    case 'float': return (v) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(7)) : (v as Value));
    case 'datetimextended': return (v) => (typeof v === 'string' ? extendedDate(v) : (v as Value));
    case 'repid': return (v) => (typeof v === 'string' ? `{${v.toUpperCase()}}` : (v as Value));
    // Attachment fields: the file names; the files themselves stay in the database.
    case 'complex':
      return (v) => (Array.isArray(v) ? v.map((a: { name?: string }) => a?.name ?? '').join('; ') : v === null || v === undefined ? null : String(v));
    default: return (v) => (v === undefined ? null : (v as Value));
  }
}

export async function readAccess(file: Blob, password: string | undefined): Promise<SourceDatabase> {
  // Loaded only now, after the Buffer global exists.
  const { default: Reader } = await import('mdb-reader');
  const bytes = Buffer.from(await file.arrayBuffer());
  let reader: InstanceType<typeof Reader>;
  try {
    reader = new Reader(bytes, { password });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/wrong password/i.test(message)) throw new WrongPassword('Wrong password.');
    throw new Error(/page type|unknown jet|unsupported/i.test(message) ? `This is not an Access database, or it is damaged (${message}).` : message);
  }
  // Jet 3 (Access 97) stores text one byte per character, later versions two.
  const unicodeText = bytes[0x14] >= 1;
  const notes: string[] = [];
  const tables: SourceTable[] = [];
  let attachments = false;
  for (const name of reader.getTableNames()) {
    let table: ReturnType<typeof reader.getTable>;
    let definitions: Column[];
    try {
      table = reader.getTable(name);
      definitions = table.getColumns();
    } catch (error) {
      notes.push(`Table “${name}” could not be read and is left out: ${error instanceof Error ? error.message : error}`);
      continue;
    }
    const columns: SourceColumn[] = definitions.map((c) => ({ name: c.name, kind: KINDS[c.type] ?? 'any', sqlType: sqlType(c, unicodeText) }));
    const convert = definitions.map(converter);
    if (definitions.some((c) => c.type === 'complex')) attachments = true;
    const names = definitions.map((c) => c.name);
    const rowCount = table.rowCount;
    // mdb-reader does not read indexes. An AutoNumber column is the key in nearly every table; the SQLite writer drops
    // the key again should its values not be unique.
    const auto = definitions.find((c) => c.autoLong);
    tables.push({
      name,
      columns,
      rowCount,
      primaryKey: auto ? [auto.name] : undefined,
      async *rows() {
        // Each read walks the data pages from the start, so the blocks grow with the table to keep the walks few.
        const block = Math.min(50_000, Math.max(BLOCK, Math.ceil(rowCount / 20)));
        for (let start = 0; start < rowCount; start += block) {
          const records = table.getData({ rowOffset: start, rowLimit: block });
          if (records.length === 0) break;
          yield records.map((record) => names.map((n, i) => convert[i](record[n])));
        }
      },
    });
  }
  const linked = reader.getTableNames({ normalTables: false, linkedTables: true });
  if (linked.length) notes.push(`${plural(linked.length, 'linked table')} left out; ${linked.length === 1 ? 'its data lives' : 'their data live'} in another database.`);
  if (attachments) notes.push('Attachment fields keep only the names of their files.');
  notes.push('Queries, forms, reports, macros and relations are not kept.');
  return { tables, notes, close: () => {} };
}
