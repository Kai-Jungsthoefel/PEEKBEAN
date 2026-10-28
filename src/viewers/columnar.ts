// SPDX-License-Identifier: GPL-3.0-or-later
// Column-oriented tables: Apache Parquet via hyparquet and hyparquet-compressors (MIT), Arrow IPC files and streams
// and Feather v2 via apache-arrow (Apache-2.0). Parquet is read from the file in ranges, only the rows in view; Arrow
// needs the whole file in memory. Each library loads only when such a file is opened.
import type { DataType, Field, Table } from 'apache-arrow';
import type { FileMetaData, SchemaElement, SchemaTree } from 'hyparquet';
import { startsWith } from '../core/bytes';
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import { bytesLabel, createTableView, infoTable, isoDateTime, jsonText, NULL_CELL, type TableColumn, type TableSource } from './datatable';
import type { GridCell } from './grid';

const pad = (n: number | bigint, width = 2) => String(n).padStart(width, '0');
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const sizeText = (bytes: number) =>
  bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`;

/** A point in time with its stored precision (Date keeps only milliseconds); shown ISO-like in UTC. */
class Instant {
  constructor(readonly nanos: bigint, readonly digits: number) {}
  toString(): string {
    const second = this.nanos / 1_000_000_000n - (this.nanos % 1_000_000_000n < 0n ? 1n : 0n);
    const fraction = this.nanos - second * 1_000_000_000n;
    const date = new Date(Number(second) * 1000);
    if (Number.isNaN(date.getTime())) return `${this.nanos} ns since 1970`;
    return `${isoDateTime(date)}${fraction ? `.${pad(fraction, 9).slice(0, this.digits)}` : ''}`;
  }
  toJSON(): string {
    return this.toString();
  }
}

/** A calendar day without a time. */
class Day {
  constructor(readonly date: Date) {}
  toString(): string {
    return isoDateTime(this.date, false);
  }
  toJSON(): string {
    return this.toString();
  }
}

/** An exact decimal number as text (Arrow decimals are 128 or 256 bit wide). */
class DecimalValue {
  constructor(readonly digits: string) {}
  toString(): string {
    return this.digits;
  }
  toJSON(): string {
    return this.digits;
  }
}

/** Values shown as they are, not as JSON. */
const isScalar = (value: unknown) =>
  value instanceof Uint8Array || value instanceof Instant || value instanceof Day || value instanceof DecimalValue || value instanceof Date;

/** Time of day from a count of `unit` (s, ms, µs, ns) since midnight. */
function timeOfDay(value: number | bigint, perSecond: number): string {
  const total = BigInt(value);
  const seconds = total / BigInt(perSecond);
  const fraction = total % BigInt(perSecond);
  const text = `${pad(seconds / 3600n)}:${pad((seconds / 60n) % 60n)}:${pad(seconds % 60n)}`;
  return fraction ? `${text}.${pad(fraction, String(perSecond).length - 1)}` : text;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
/** Unannotated byte arrays are often text written by old tools: show them as text when they decode cleanly. */
function bytesOrText(bytes: Uint8Array): string {
  if (bytes.length <= 4096) {
    try {
      const text = utf8.decode(bytes);
      if (!/[\x00-\x08\x0e-\x1f\x7f]/.test(text)) return text;
    } catch {
      // not UTF-8
    }
  }
  return bytesLabel(bytes.length);
}

interface ColumnFormat {
  /** Places after the decimal point for decimals that arrive as numbers. */
  scale?: number;
  /** Byte arrays without a type annotation, maybe text. */
  maybeText?: boolean;
  /** Single precision floats: show the digits they hold, not those of the double they became. */
  float32?: boolean;
}

function valueCell(value: unknown, format: ColumnFormat): GridCell {
  if (value === null || value === undefined) return NULL_CELL;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { text: String(value), numeric: true };
    return { text: format.scale !== undefined ? value.toFixed(format.scale) : format.float32 ? String(Number(value.toPrecision(7))) : String(value), numeric: true };
  }
  if (typeof value === 'bigint') return { text: String(value), numeric: true };
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (value instanceof DecimalValue) return { text: value.digits, numeric: true };
  if (value instanceof Instant || value instanceof Day) return value.toString();
  if (value instanceof Date) return isoDateTime(value);
  if (value instanceof Uint8Array) return format.maybeText ? bytesOrText(value) : bytesLabel(value.length);
  return jsonText(value);
}

function tableColumn(name: string, tip: string, format: ColumnFormat, width: number): TableColumn {
  return {
    name,
    tip,
    width,
    cell: (value) => valueCell(value, format),
    detail: (value) => {
      if (value !== null && typeof value === 'object' && !isScalar(value)) return jsonText(value, 2);
      const cell = valueCell(value, format);
      return typeof cell === 'string' ? cell : cell.text;
    },
    files: (value) => (value instanceof Uint8Array && valueCell(value, format) === bytesLabel(value.length) ? [{ name: `${name}.bin`, data: value }] : []),
  };
}

/** Key/value metadata; long JSON values (pandas, Spark, Arrow schemas) fold away. */
function metadataList(entries: [string, string][]): HTMLElement {
  const list = h('dl', { class: 'dt-kv' });
  for (const [key, value] of entries) {
    let content: Node = document.createTextNode(value);
    if (value.length > 120) {
      let pretty = value;
      let kind = `${value.length.toLocaleString('en-US')} characters`;
      try {
        pretty = JSON.stringify(JSON.parse(value), null, 2);
        kind = `JSON, ${kind}`;
      } catch {
        if (/^[A-Za-z0-9+/=\s]+$/.test(value)) kind = `Base64, ${kind}`;
      }
      content = h('details', {}, h('summary', {}, kind), h('pre', {}, pretty));
    }
    list.append(h('dt', {}, key), h('dd', {}, content));
  }
  return list;
}

function factsList(pairs: [string, string | null | undefined][]): HTMLElement {
  const list = h('dl', { class: 'dt-kv' });
  for (const [label, value] of pairs) if (value) list.append(h('dt', {}, label), h('dd', {}, value));
  return list;
}

const section = (title: string, ...content: Node[]) => h('section', { class: 'dt-section' }, h('h3', {}, title), ...content);

interface Opened {
  kind: string;
  source: TableSource;
  facts: string;
  schema: HTMLElement;
}

// ---- Parquet ------------------------------------------------------------------------------------------------------

function parquetLeafType(el: SchemaElement): string {
  const lt = el.logical_type;
  if (lt) {
    switch (lt.type) {
      case 'DECIMAL':
        return `DECIMAL(${lt.precision}, ${lt.scale})`;
      case 'TIMESTAMP':
      case 'TIME':
        return `${lt.type}(${lt.unit}${lt.isAdjustedToUTC ? ', UTC' : ''})`;
      case 'INTEGER':
        return `${lt.isSigned ? 'INT' : 'UINT'}${lt.bitWidth}`;
      default:
        return lt.type;
    }
  }
  if (el.converted_type === 'DECIMAL') return `DECIMAL(${el.precision}, ${el.scale})`;
  if (el.converted_type === 'UTF8') return 'STRING';
  if (el.converted_type) return el.converted_type;
  if (el.type === 'FIXED_LEN_BYTE_ARRAY') return `FIXED_LEN_BYTE_ARRAY(${el.type_length})`;
  return el.type ?? 'GROUP';
}

/** Readable type of a schema node, nested types included: LIST<STRING>, STRUCT<a: INT32, …>, MAP<K, V>. */
function parquetType(node: SchemaTree): string {
  const el = node.element;
  const kind = el.logical_type?.type ?? el.converted_type;
  let type: string;
  if (kind === 'LIST' && node.children.length === 1) {
    const repeated = node.children[0];
    // Lists wrap the element in a repeated group; old writers repeat the element (or a struct of it) directly.
    const wrapper = !repeated.element.type && repeated.children.length === 1 && repeated.element.name !== 'array' && !repeated.element.name.endsWith('_tuple');
    const element = wrapper ? parquetType(repeated.children[0]) : repeated.element.type ? parquetLeafType(repeated.element) : parquetStruct(repeated);
    type = `LIST<${element}>`;
  } else if ((kind === 'MAP' || kind === 'MAP_KEY_VALUE') && node.children.length === 1 && node.children[0].children.length === 2) {
    const [key, value] = node.children[0].children;
    type = `MAP<${parquetType(key)}, ${parquetType(value)}>`;
  } else if (!el.type) {
    type = parquetStruct(node);
  } else {
    type = parquetLeafType(el);
  }
  return el.repetition_type === 'REPEATED' && kind !== 'LIST' ? `${type}[]` : type;
}
const parquetStruct = (node: SchemaTree) => `STRUCT<${node.children.map((c) => `${c.element.name}: ${parquetType(c)}`).join(', ')}>`;

async function openParquet(file: File, progress: ViewerContext['progress']): Promise<Opened> {
  progress('Loading the Parquet reader …');
  const [{ parquetMetadataAsync, parquetRead, parquetSchema }, { compressors }] = await Promise.all([import('hyparquet'), import('hyparquet-compressors')]);
  const buffer = { byteLength: file.size, slice: (start: number, end?: number) => file.slice(start, end).arrayBuffer() };
  const parsers = {
    timestampFromMilliseconds: (v: bigint) => new Instant(v * 1_000_000n, 3),
    timestampFromMicroseconds: (v: bigint) => new Instant(v * 1000n, 6),
    timestampFromNanoseconds: (v: bigint) => new Instant(v, 9),
    dateFromDays: (days: number) => new Day(new Date(days * 86400000)),
  };
  progress('Reading the file footer …');
  let metadata: FileMetaData;
  try {
    metadata = await parquetMetadataAsync(buffer, { parsers });
  } catch (error) {
    throw new Error(`The Parquet footer could not be read; the file is damaged or incomplete (${error instanceof Error ? error.message : error}).`);
  }
  const tree = parquetSchema(metadata);
  const top = tree.children;
  // Some old writers left the total at 0; the row groups know better.
  const rowCount = Number(metadata.num_rows) || metadata.row_groups.reduce((sum, g) => sum + Number(g.num_rows), 0);

  const columns = top.map((node) => {
    const el = node.element;
    const decimal = el.logical_type?.type === 'DECIMAL' ? el.logical_type.scale : el.converted_type === 'DECIMAL' ? el.scale : undefined;
    const plainBytes = el.type === 'BYTE_ARRAY' && !el.logical_type && !el.converted_type;
    const type = parquetType(node);
    const optional = el.repetition_type !== 'REQUIRED';
    const leaf = Boolean(el.type) && el.repetition_type !== 'REPEATED';
    const width = !leaf ? 220 : /^(BOOLEAN)$/.test(type) ? 80 : /^(INT|UINT|FLOAT|DOUBLE|DECIMAL)/.test(type) ? 110 : /TIMESTAMP/.test(type) ? 190 : /^DATE$/.test(type) ? 110 : 160;
    return tableColumn(el.name, `${type}${optional ? ', nullable' : ', required'}`, { scale: decimal ?? undefined, maybeText: plainBytes, float32: el.type === 'FLOAT' }, width);
  });

  // Leaf columns with their sizes and null counts summed over all row groups.
  const leaves = new Map<string, { codec: Set<string>; compressed: number; uncompressed: number; nulls: number | null; encodings: Set<string> }>();
  for (const group of metadata.row_groups) {
    for (const chunk of group.columns) {
      const meta = chunk.meta_data;
      if (!meta) continue;
      const key = meta.path_in_schema.join('.');
      const entry = leaves.get(key) ?? { codec: new Set(), compressed: 0, uncompressed: 0, nulls: 0, encodings: new Set() };
      entry.codec.add(meta.codec);
      entry.compressed += Number(meta.total_compressed_size);
      entry.uncompressed += Number(meta.total_uncompressed_size);
      const nulls = meta.statistics?.null_count;
      entry.nulls = entry.nulls === null || nulls === undefined ? null : entry.nulls + Number(nulls);
      for (const e of meta.encodings) entry.encodings.add(e);
      leaves.set(key, entry);
    }
  }
  const codecs = new Set([...leaves.values()].flatMap((l) => [...l.codec]));
  const compressed = [...leaves.values()].reduce((sum, l) => sum + l.compressed, 0);
  const uncompressed = [...leaves.values()].reduce((sum, l) => sum + l.uncompressed, 0);

  // Schema rows: every node, indented by depth; sizes for leaves.
  const schemaRows: (string | Node | null)[][] = [];
  const walk = (node: SchemaTree, depth: number) => {
    const el = node.element;
    const leaf = leaves.get(node.path.join('.'));
    schemaRows.push([
      h('span', { class: 'dt-indent', style: `--depth:${depth}` }, el.name),
      h('span', { class: 'dt-type' }, parquetType(node)),
      el.type ? (el.type === 'FIXED_LEN_BYTE_ARRAY' ? `${el.type}(${el.type_length})` : el.type) : 'group',
      el.repetition_type === 'REQUIRED' ? 'no' : el.repetition_type === 'REPEATED' ? 'repeated' : 'yes',
      leaf ? [...leaf.codec].join(', ') : '',
      leaf ? `${sizeText(leaf.compressed)} / ${sizeText(leaf.uncompressed)}` : '',
      leaf && leaf.nulls !== null ? leaf.nulls.toLocaleString('en-US') : '',
    ]);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const node of top) walk(node, 0);

  const schema = h(
    'div',
    { class: 'dt-scroll' },
    h(
      'div',
      { class: 'dt-page' },
      section(
        'File',
        factsList([
          ['Format', `Apache Parquet, format version ${metadata.version}`],
          ['Rows', rowCount.toLocaleString('en-US')],
          ['Columns', `${top.length.toLocaleString('en-US')} (${leaves.size.toLocaleString('en-US')} stored)`],
          ['Row groups', metadata.row_groups.length.toLocaleString('en-US')],
          ['Compression', [...codecs].join(', ') || 'none'],
          ['Data size', `${sizeText(compressed)} compressed, ${sizeText(uncompressed)} uncompressed`],
          ['Created by', metadata.created_by],
        ]),
      ),
      section('Columns', infoTable(['Column', 'Type', 'Physical type', 'Nullable', 'Compression', 'Size (compressed / raw)', 'Nulls'], schemaRows)),
      metadata.row_groups.length
        ? section(
            'Row groups',
            infoTable(
              ['#', 'Rows', 'Compressed', 'Uncompressed'],
              metadata.row_groups.map((g, i) => [
                String(i + 1),
                Number(g.num_rows).toLocaleString('en-US'),
                sizeText(g.columns.reduce((s, c) => s + Number(c.meta_data?.total_compressed_size ?? 0), 0)),
                sizeText(Number(g.total_byte_size)),
              ]),
            ),
          )
        : h('span'),
      metadata.key_value_metadata?.length
        ? section('Key/value metadata', metadataList(metadata.key_value_metadata.map((kv) => [kv.key, kv.value ?? ''])))
        : h('span'),
    ),
  );

  return {
    kind: 'Parquet',
    facts: `${plural(rowCount, 'row')} · ${plural(top.length, 'column')} · ${plural(metadata.row_groups.length, 'row group')}${codecs.size ? ` · ${[...codecs].join(', ')}` : ''}`,
    schema,
    source: {
      rowCount,
      columns,
      read: (start, end) =>
        new Promise((resolve, reject) => {
          parquetRead({ file: buffer, metadata, rowStart: start, rowEnd: end, compressors, parsers, utf8: false, useOffsetIndex: true, rowFormat: 'array', onComplete: resolve }).catch(reject);
        }),
    },
  };
}

// ---- Arrow ----------------------------------------------------------------------------------------------------------

/** LZ4 frames as Arrow writes compressed buffers (blocks may refer back into earlier blocks). */
export function lz4Frame(input: Uint8Array): Uint8Array {
  const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
  let out = new Uint8Array(Math.max(1024, input.length * 4));
  let o = 0;
  const ensure = (n: number) => {
    if (o + n <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, o + n));
    bigger.set(out.subarray(0, o));
    out = bigger;
  };
  let p = 0;
  while (p + 4 <= input.length) {
    const magic = view.getUint32(p, true);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      p += 8 + view.getUint32(p + 4, true);
      continue;
    }
    if (magic !== 0x184d2204) throw new Error('Invalid LZ4 frame.');
    const flags = input[p + 4];
    p += 7 + (flags & 0x08 ? 8 : 0) + (flags & 0x01 ? 4 : 0);
    for (;;) {
      const size = view.getUint32(p, true);
      p += 4;
      if (size === 0) break;
      const length = size & 0x7fffffff;
      const end = p + length;
      if (size & 0x80000000) {
        ensure(length);
        out.set(input.subarray(p, end), o);
        o += length;
      } else {
        while (p < end) {
          const token = input[p++];
          let literals = token >> 4;
          if (literals === 15) for (let b = 255; b === 255; ) literals += b = input[p++];
          ensure(literals);
          out.set(input.subarray(p, p + literals), o);
          o += literals;
          p += literals;
          if (p >= end) break;
          const offset = input[p] | (input[p + 1] << 8);
          p += 2;
          let match = (token & 15) + 4;
          if ((token & 15) === 15) for (let b = 255; b === 255; ) match += b = input[p++];
          if (!offset || offset > o) throw new Error('Invalid LZ4 data.');
          ensure(match);
          for (let i = 0; i < match; i++, o++) out[o] = out[o - offset];
        }
      }
      p = end + (flags & 0x10 ? 4 : 0);
    }
    if (flags & 0x04) p += 4;
  }
  return out.slice(0, o);
}

const TIME_UNITS = ['s', 'ms', 'µs', 'ns'];
const PER_SECOND = [1, 1000, 1_000_000, 1_000_000_000];

function arrowTypeText(arrow: typeof import('apache-arrow'), type: DataType): string {
  const { DataType: T } = arrow;
  if (T.isDecimal(type)) return `Decimal${type.bitWidth}(${type.precision}, ${type.scale})`;
  if (T.isList(type) || T.isLargeList(type)) return `List<${arrowTypeText(arrow, type.children[0].type)}>`;
  if (T.isFixedSizeList(type)) return `FixedSizeList[${type.listSize}]<${arrowTypeText(arrow, type.children[0].type)}>`;
  if (T.isStruct(type)) return `Struct<${type.children.map((f) => `${f.name}: ${arrowTypeText(arrow, f.type)}`).join(', ')}>`;
  if (T.isMap(type)) return `Map<${type.children[0].type.children.map((f) => arrowTypeText(arrow, f.type)).join(', ')}>`;
  if (T.isDictionary(type)) return `Dictionary<${arrowTypeText(arrow, type.dictionary)}>`;
  return String(type);
}

/** Decimal digits with the point put in: "1234", scale 2 → "12.34". */
function scaled(digits: string, scale: number): string {
  if (scale <= 0) return digits + '0'.repeat(-scale);
  const negative = digits.startsWith('-');
  const abs = (negative ? digits.slice(1) : digits).padStart(scale + 1, '0');
  return `${negative ? '-' : ''}${abs.slice(0, -scale)}.${abs.slice(-scale)}`;
}

/** Arrow values to plain values the table can show: nested types recursively, dates and times with their precision. */
function arrowValue(arrow: typeof import('apache-arrow'), type: DataType, value: unknown): unknown {
  const { DataType: T } = arrow;
  if (value === null || value === undefined) return null;
  if (T.isTimestamp(type)) return new Instant(BigInt(Math.round(Number(value) * 1000)) * 1000n, [0, 3, 6, 9][type.unit]);
  if (T.isDate(type)) return new Day(new Date(Number(value)));
  if (T.isTime(type)) return timeOfDay(value as number | bigint, PER_SECOND[type.unit]);
  if (T.isDuration(type)) return `${value} ${TIME_UNITS[type.unit]}`;
  if (T.isDecimal(type)) return new DecimalValue(scaled(String(value), type.scale));
  if (T.isDictionary(type)) return arrowValue(arrow, type.dictionary, value);
  if (T.isList(type) || T.isLargeList(type) || T.isFixedSizeList(type)) return [...(value as Iterable<unknown>)].map((v) => arrowValue(arrow, type.children[0].type, v));
  if (T.isStruct(type)) {
    const row = value as Record<string, unknown>;
    return Object.fromEntries(type.children.map((f) => [f.name, arrowValue(arrow, f.type, row[f.name])]));
  }
  if (T.isMap(type)) {
    const [keyField, valueField] = type.children[0].type.children;
    return Object.fromEntries([...(value as Iterable<[unknown, unknown]>)].map(([k, v]) => [String(arrowValue(arrow, keyField.type, k)), arrowValue(arrow, valueField.type, v)]));
  }
  if (T.isInterval(type)) return Array.from(value as ArrayLike<number>);
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) return Array.from(value as unknown as ArrayLike<number>);
  return value;
}

async function openArrow(file: File, progress: ViewerContext['progress']): Promise<Opened> {
  progress('Loading the Arrow reader …');
  const arrow = await import('apache-arrow');
  const { decompressZstd } = await import('hyparquet-compressors');
  const used = new Set<string>();
  arrow.compressionRegistry.set(arrow.CompressionType.LZ4_FRAME, { decode: (data) => (used.add('LZ4'), lz4Frame(data)) });
  arrow.compressionRegistry.set(arrow.CompressionType.ZSTD, { decode: (data) => (used.add('ZSTD'), decompressZstd(data).slice()) });
  progress('Reading the file …');
  const bytes = new Uint8Array(await file.arrayBuffer());
  let table: Table;
  try {
    table = arrow.tableFromIPC(bytes);
  } catch (error) {
    throw new Error(`The Arrow data could not be read; the file is damaged or not in Arrow IPC format (${error instanceof Error ? error.message : error}).`);
  }
  const isFile = startsWith(bytes, 'ARROW1');
  const fields: Field[] = table.schema.fields;
  const vectors = fields.map((_, i) => table.getChildAt(i)!);

  const columns = fields.map((f) => {
    const { DataType: T } = arrow;
    const type = arrowTypeText(arrow, f.type);
    const nested = T.isList(f.type) || T.isLargeList(f.type) || T.isStruct(f.type) || T.isMap(f.type) || T.isFixedSizeList(f.type);
    const width = nested ? 220 : T.isBool(f.type) ? 80 : T.isInt(f.type) || T.isFloat(f.type) || T.isDecimal(f.type) ? 110 : T.isTimestamp(f.type) ? 190 : T.isDate(f.type) ? 110 : 160;
    const float32 = T.isFloat(f.type) && f.type.precision !== arrow.Precision.DOUBLE;
    return tableColumn(f.name, `${type}${f.nullable ? ', nullable' : ', required'}`, { float32 }, width);
  });

  const schema = h(
    'div',
    { class: 'dt-scroll' },
    h(
      'div',
      { class: 'dt-page' },
      section(
        'File',
        factsList([
          ['Format', isFile ? 'Arrow IPC file (Feather version 2)' : 'Arrow IPC stream'],
          ['Rows', table.numRows.toLocaleString('en-US')],
          ['Columns', fields.length.toLocaleString('en-US')],
          ['Record batches', table.batches.length.toLocaleString('en-US')],
          ['Compression', used.size ? [...used].join(', ') : 'none'],
          ['Metadata version', `V${table.schema.metadataVersion + 1}`],
        ]),
      ),
      section(
        'Columns',
        infoTable(
          ['#', 'Column', 'Type', 'Nullable', 'Field metadata'],
          fields.map((f, i) => [String(i + 1), f.name, h('span', { class: 'dt-type' }, arrowTypeText(arrow, f.type)), f.nullable ? 'yes' : 'no', f.metadata.size ? metadataList([...f.metadata]) : '']),
        ),
      ),
      table.schema.metadata.size ? section('Schema metadata', metadataList([...table.schema.metadata])) : h('span'),
    ),
  );

  return {
    kind: isFile ? 'Arrow' : 'Arrow stream',
    facts: `${plural(table.numRows, 'row')} · ${plural(fields.length, 'column')}${used.size ? ` · ${[...used].join(', ')}` : ''}`,
    schema,
    source: {
      rowCount: table.numRows,
      columns,
      read: async (start, end) => {
        const rows: unknown[][] = [];
        for (let r = start; r < end; r++) rows.push(vectors.map((v, c) => arrowValue(arrow, fields[c].type, v.get(r))));
        return rows;
      },
    },
  };
}

// ---- Viewer ---------------------------------------------------------------------------------------------------------

export async function mount({ file, container, toolbar, progress, openFile }: ViewerContext) {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  let opened: Opened;
  if (startsWith(head, 'PAR1')) opened = await openParquet(file, progress);
  else if (startsWith(head, 'FEA1')) throw new Error('This is a Feather file of version 1, which is not supported. Current pandas and pyarrow write version 2.');
  else if (startsWith(head, 'PARE')) throw new Error('This Parquet file is encrypted; it cannot be read without its keys.');
  else opened = await openArrow(file, progress);

  const records = h('button', { type: 'button', role: 'radio', onclick: () => show('records') }, 'Data');
  const schemaButton = h('button', { type: 'button', role: 'radio', onclick: () => show('schema') }, 'Schema');
  // The table keeps its loaded rows and scroll position while the schema is shown.
  const view = createTableView(opened.source, openFile);
  const body = h('div', { class: 'dt-body' }, view.element, opened.schema);
  container.classList.add('dt-view');
  container.append(
    h('div', { class: 'db-main' },
      h('div', { class: 'dt-head' }, h('span', { class: 'c2' }, opened.facts), h('span', { class: 'grow' }), h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'View' }, records, schemaButton)),
      body),
  );
  toolbar.append(h('span', { class: 'meta' }, opened.kind));

  function show(mode: 'records' | 'schema'): void {
    records.setAttribute('aria-checked', String(mode === 'records'));
    schemaButton.setAttribute('aria-checked', String(mode === 'schema'));
    view.element.hidden = mode !== 'records';
    opened.schema.hidden = mode !== 'schema';
  }
  show('records');

  return { destroy: () => view.destroy() };
}
