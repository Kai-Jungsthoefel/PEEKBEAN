// SPDX-License-Identifier: GPL-3.0-or-later
// One CSV file per table (RFC 4180): a header row with the column names, fields quoted where needed, dates in
// ISO 8601, binary values as hexadecimal or a placeholder. Each block of rows is encoded right away, so the text of
// a table never exists as one string.
import { binaryCell, Changes, dateShape, isoText, trimDecimal, type ColumnKind, type Progress, type SourceDatabase, type Value } from './source';

export interface CsvFile {
  table: string;
  data: Blob;
}

function field(value: Value, kind: ColumnKind, changes: Changes): string {
  if (value === null) return '';
  if (typeof value === 'string') return kind === 'decimal' ? trimDecimal(value) : value;
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : isoText(value, dateShape(value, kind));
  return binaryCell(value, changes);
}

export async function writeCsv(db: SourceDatabase, separator: string, bom: boolean, progress: Progress): Promise<{ files: CsvFile[]; notes: string[] }> {
  const encoder = new TextEncoder();
  const special = new RegExp(`["\\r\\n${separator === '\t' ? '\\t' : separator}]`);
  const quote = (text: string) => (special.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
  const changes = new Changes();
  const total = db.tables.reduce((sum, t) => sum + t.rowCount, 0) || 1;
  let done = 0;
  const files: CsvFile[] = [];
  for (const [index, table] of db.tables.entries()) {
    const label = `Table ${index + 1} of ${db.tables.length}: ${table.name}`;
    progress(label, done / total);
    const kinds = table.columns.map((c) => c.kind);
    const parts: BlobPart[] = [encoder.encode(`${bom ? '﻿' : ''}${table.columns.map((c) => quote(c.name)).join(separator)}\r\n`)];
    for await (const block of table.rows()) {
      let text = '';
      for (const row of block) text += `${row.map((v, i) => quote(field(v, kinds[i], changes))).join(separator)}\r\n`;
      parts.push(encoder.encode(text));
      done += block.length;
      progress(label, done / total);
    }
    files.push({ table: table.name, data: new Blob(parts, { type: 'text/csv' }) });
  }
  return { files, notes: changes.notes() };
}
