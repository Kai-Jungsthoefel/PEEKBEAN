// SPDX-License-Identifier: GPL-3.0-or-later
// Parquet through hyparquet and hyparquet-compressors (MIT), read one row group at a time straight from the file;
// Arrow IPC files and streams and Feather v2 through apache-arrow (Apache-2.0), which needs the whole file in memory.
// Either is one table named after the file. Nested values (lists, structs, maps) become JSON text.
import type { DataType, Field } from 'apache-arrow';
import type { SchemaTree } from 'hyparquet';
import { lz4Frame } from '../../viewers/columnar';
import { BLOCK, jsonText, timeOfDay, type SourceColumn, type SourceDatabase, type Value } from './source';

interface ColumnReader {
  column: SourceColumn;
  convert(value: unknown): Value;
  /** Timestamps that the file marks as UTC instants. */
  utc?: boolean;
  nested?: boolean;
}

const json = (name: string): ColumnReader => ({
  column: { name, kind: 'text', sqlType: 'TEXT' },
  convert: (v) => (v === null || v === undefined ? null : jsonText(v)),
  nested: true,
});
const same = (v: unknown) => (v === undefined ? null : (v as Value));
const float32 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(7)) : same(v));
const date = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v : new Date(Number(v)));

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** Byte arrays without a type are often text written by old tools: text when they decode cleanly. */
function bytesOrText(v: unknown): Value {
  if (!(v instanceof Uint8Array)) return same(v);
  try {
    const text = utf8.decode(v);
    if (!/[\x00-\x08\x0e-\x1f\x7f]/.test(text)) return text;
  } catch {
    // not UTF-8
  }
  return v;
}

// ---- Parquet --------------------------------------------------------------------------------------------------------

const PER_SECOND: Record<string, number> = { MILLIS: 1000, MICROS: 1_000_000, NANOS: 1_000_000_000 };

function parquetColumn(node: SchemaTree): ColumnReader {
  const el = node.element;
  const { name, type } = el;
  const logical = el.logical_type;
  const converted = el.converted_type;
  if (!type || el.repetition_type === 'REPEATED' || node.children.length) return json(name);
  if (logical?.type === 'GEOMETRY' || logical?.type === 'GEOGRAPHY' || logical?.type === 'JSON' || converted === 'JSON') return json(name);
  const column = (kind: SourceColumn['kind'], sqlType: string, convert: (v: unknown) => Value = same, utc?: boolean): ColumnReader => ({ column: { name, kind, sqlType }, convert, utc });
  if (type === 'BOOLEAN') return column('boolean', 'BOOLEAN');
  if (logical?.type === 'DATE' || converted === 'DATE') return column('date', 'DATE', date);
  if (logical?.type === 'TIMESTAMP') return column('timestamp', 'TIMESTAMP', date, logical.isAdjustedToUTC);
  // Old timestamp annotations and INT96 (Impala, Spark) are UTC instants.
  if (converted === 'TIMESTAMP_MILLIS' || converted === 'TIMESTAMP_MICROS' || type === 'INT96') return column('timestamp', 'TIMESTAMP', date, true);
  if (logical?.type === 'TIME' || converted === 'TIME_MILLIS' || converted === 'TIME_MICROS') {
    const perSecond = PER_SECOND[logical?.type === 'TIME' ? logical.unit : converted === 'TIME_MILLIS' ? 'MILLIS' : 'MICROS'];
    return column('time', 'TIME', (v) => (typeof v === 'number' || typeof v === 'bigint' ? timeOfDay(v, perSecond) : same(v)));
  }
  if (logical?.type === 'DECIMAL' || converted === 'DECIMAL') {
    // hyparquet hands decimals over as doubles; rounding to the scale removes the binary noise of the division.
    const scale = (logical?.type === 'DECIMAL' ? logical.scale : el.scale) ?? 0;
    const precision = (logical?.type === 'DECIMAL' ? logical.precision : el.precision) ?? 18;
    return column('decimal', `DECIMAL(${precision}, ${scale})`, (v) => (typeof v === 'number' && Number.isFinite(v) && scale <= 100 ? Number(v.toFixed(scale)) : same(v)));
  }
  if (type === 'INT32' || type === 'INT64') return column('integer', type === 'INT64' ? 'BIGINT' : 'INTEGER');
  if (type === 'FLOAT') return column('real', 'REAL', float32);
  if (type === 'DOUBLE' || logical?.type === 'FLOAT16') return column('real', 'REAL');
  if (logical?.type === 'STRING' || logical?.type === 'UUID' || converted === 'UTF8') return column('text', 'TEXT');
  if (logical?.type === 'ENUM' || converted === 'ENUM') return column('text', 'TEXT', (v) => (v instanceof Uint8Array ? new TextDecoder().decode(v) : same(v)));
  // Untyped byte arrays may be text or binary, value by value; the SQLite column gets no declared type.
  return type === 'BYTE_ARRAY' ? column('any', '', bytesOrText) : column('binary', 'BLOB');
}

async function readParquet(file: Blob, name: string): Promise<SourceDatabase> {
  const [{ parquetMetadataAsync, parquetRead, parquetSchema }, { compressors }] = await Promise.all([import('hyparquet'), import('hyparquet-compressors')]);
  const buffer = { byteLength: file.size, slice: (start: number, end?: number) => file.slice(start, end).arrayBuffer() };
  let metadata: Awaited<ReturnType<typeof parquetMetadataAsync>>;
  try {
    metadata = await parquetMetadataAsync(buffer);
  } catch (error) {
    throw new Error(`The Parquet footer could not be read; the file is damaged or incomplete (${error instanceof Error ? error.message : error}).`);
  }
  const readers = parquetSchema(metadata).children.map(parquetColumn);
  const groups = metadata.row_groups.map((g) => Number(g.num_rows));
  const rowCount = Number(metadata.num_rows) || groups.reduce((sum, n) => sum + n, 0);
  return {
    tables: [
      {
        name,
        columns: readers.map((r) => r.column),
        rowCount,
        async *rows() {
          let start = 0;
          for (const size of groups) {
            const end = start + size;
            const rows = await new Promise<unknown[][]>((resolve, reject) => {
              parquetRead({ file: buffer, metadata, rowStart: start, rowEnd: end, compressors, utf8: false, rowFormat: 'array', onComplete: resolve }).catch(reject);
            });
            for (let i = 0; i < rows.length; i += BLOCK) yield rows.slice(i, i + BLOCK).map((row) => readers.map((r, c) => r.convert(row[c])));
            start = end;
          }
        },
      },
    ],
    notes: columnNotes(readers),
    close: () => {},
  };
}

// ---- Arrow ----------------------------------------------------------------------------------------------------------

type Arrow = typeof import('apache-arrow');
const ARROW_PER_SECOND = [1, 1000, 1_000_000, 1_000_000_000];
const TIME_UNITS = ['s', 'ms', 'µs', 'ns'];

/** Decimal digits with the point put in: "1234", scale 2 → "12.34". */
function scaled(digits: string, scale: number): string {
  if (scale <= 0) return digits + '0'.repeat(-scale);
  const negative = digits.startsWith('-');
  const abs = (negative ? digits.slice(1) : digits).padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${abs.slice(0, -scale)}.${abs.slice(-scale)}`;
}

/** Nested Arrow values as plain values for JSON: lists, structs and maps recursively, dates as dates. */
function arrowPlain(arrow: Arrow, type: DataType, value: unknown): unknown {
  const { DataType: T } = arrow;
  if (value === null || value === undefined) return null;
  if (T.isTimestamp(type) || T.isDate(type)) return new Date(Number(value));
  if (T.isTime(type)) return timeOfDay(value as number | bigint, ARROW_PER_SECOND[type.unit]);
  if (T.isDecimal(type)) return Number(scaled(String(value), type.scale));
  if (T.isDictionary(type)) return arrowPlain(arrow, type.dictionary, value);
  if (T.isList(type) || T.isLargeList(type) || T.isFixedSizeList(type)) return [...(value as Iterable<unknown>)].map((v) => arrowPlain(arrow, type.children[0].type, v));
  if (T.isStruct(type)) {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(type.children.map((f) => [f.name, arrowPlain(arrow, f.type, row[f.name])]));
  }
  if (T.isMap(type)) {
    const [key, item] = type.children[0].type.children;
    return Object.fromEntries([...(value as Iterable<[unknown, unknown]>)].map(([k, v]) => [String(arrowPlain(arrow, key.type, k)), arrowPlain(arrow, item.type, v)]));
  }
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) return Array.from(value as unknown as ArrayLike<number>);
  return value;
}

function arrowColumn(arrow: Arrow, field: Field, type: DataType = field.type): ColumnReader {
  const { DataType: T, Precision, DateUnit } = arrow;
  const { name } = field;
  const column = (kind: SourceColumn['kind'], sqlType: string, convert: (v: unknown) => Value = same, utc?: boolean): ColumnReader => ({ column: { name, kind, sqlType }, convert, utc });
  if (T.isDictionary(type)) return arrowColumn(arrow, field, type.dictionary);
  if (T.isNull(type)) return column('any', '', () => null);
  if (T.isBool(type)) return column('boolean', 'BOOLEAN');
  if (T.isInt(type)) return column('integer', type.bitWidth === 64 ? 'BIGINT' : 'INTEGER');
  if (T.isFloat(type)) return column('real', 'REAL', type.precision === Precision.SINGLE ? float32 : same);
  if (T.isDecimal(type)) {
    const { scale, precision } = type;
    return column('decimal', `DECIMAL(${precision}, ${scale})`, (v) => (v === null || v === undefined ? null : scaled(String(v), scale)));
  }
  if (T.isUtf8(type) || T.isLargeUtf8(type) || T.isUtf8View(type)) return column('text', 'TEXT');
  if (T.isBinary(type) || T.isLargeBinary(type) || T.isFixedSizeBinary(type) || T.isBinaryView(type)) return column('binary', 'BLOB');
  if (T.isDate(type)) return type.unit === DateUnit.DAY ? column('date', 'DATE', date) : column('datetime', 'DATETIME', date);
  if (T.isTimestamp(type)) return column('timestamp', 'TIMESTAMP', date, Boolean(type.timezone));
  if (T.isTime(type)) return column('time', 'TIME', (v) => (v === null || v === undefined ? null : timeOfDay(v as number | bigint, ARROW_PER_SECOND[type.unit])));
  if (T.isDuration(type)) return column('text', 'TEXT', (v) => (v === null || v === undefined ? null : `${v} ${TIME_UNITS[type.unit]}`));
  return { ...json(name), convert: (v) => (v === null || v === undefined ? null : jsonText(arrowPlain(arrow, type, v))) };
}

async function readArrow(file: Blob, name: string): Promise<SourceDatabase> {
  const arrow = await import('apache-arrow');
  const { decompressZstd } = await import('hyparquet-compressors');
  arrow.compressionRegistry.set(arrow.CompressionType.LZ4_FRAME, { decode: lz4Frame });
  arrow.compressionRegistry.set(arrow.CompressionType.ZSTD, { decode: (data) => decompressZstd(data).slice() });
  let table: InstanceType<typeof arrow.Table>;
  try {
    table = arrow.tableFromIPC(new Uint8Array(await file.arrayBuffer()));
  } catch (error) {
    throw new Error(`The Arrow data could not be read; the file is damaged or not in Arrow IPC format (${error instanceof Error ? error.message : error}).`);
  }
  const fields = table.schema.fields;
  const readers = fields.map((f) => arrowColumn(arrow, f));
  return {
    tables: [
      {
        name,
        columns: readers.map((r) => r.column),
        rowCount: table.numRows,
        async *rows() {
          for (const batch of table.batches) {
            const vectors = fields.map((_, i) => batch.getChildAt(i)!);
            for (let start = 0; start < batch.numRows; start += BLOCK) {
              const end = Math.min(batch.numRows, start + BLOCK);
              const rows: Value[][] = [];
              for (let r = start; r < end; r++) rows.push(readers.map((reader, c) => reader.convert(vectors[c].get(r))));
              yield rows;
            }
          }
        },
      },
    ],
    notes: columnNotes(readers),
    close: () => {},
  };
}

function columnNotes(readers: ColumnReader[]): string[] {
  const notes: string[] = [];
  if (readers.some((r) => r.utc)) notes.push('Timestamps are given in UTC.');
  if (readers.some((r) => r.nested)) notes.push('Nested values (lists, structs, maps) are written as JSON text.');
  return notes;
}

/** Parquet or Arrow, told apart by the first bytes as in the viewer. */
export async function readColumnar(file: Blob, name: string): Promise<SourceDatabase> {
  const head = new TextDecoder('latin1').decode(await file.slice(0, 4).arrayBuffer());
  if (head === 'PAR1') return readParquet(file, name);
  if (head === 'FEA1') throw new Error('This is a Feather file of version 1, which is not supported. Current pandas and pyarrow write version 2.');
  if (head === 'PARE') throw new Error('This Parquet file is encrypted; it cannot be read without its keys.');
  return readArrow(file, name);
}
