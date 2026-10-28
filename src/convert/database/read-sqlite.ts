// SPDX-License-Identifier: GPL-3.0-or-later
// SQLite databases through sql.js (MIT), GeoPackage and MBTiles files included. Tables are read with SELECT *;
// views, virtual tables (full-text and spatial indexes, which sql.js may not even load) and their shadow tables are
// left out. Text in DATE/TIME columns that SQLite's date functions understand becomes a date.
import { loadSqlJs, quoteIdentifier } from './sqljs';
import { BLOCK, parseIsoText, plural, type ColumnKind, type SourceDatabase, type SourceTable, type Value } from './source';

function kindOf(declared: string): ColumnKind {
  const type = declared.toUpperCase();
  if (/DATE|TIMESTAMP/.test(type)) return type === 'DATE' ? 'date' : 'datetime';
  return /TIME/.test(type) ? 'time' : 'any';
}

function plain(value: unknown, dates: boolean): Value {
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value;
  if (dates && typeof value === 'string') return parseIsoText(value) ?? value;
  return value as Value;
}

export async function readSqlite(file: Blob): Promise<SourceDatabase> {
  const SQL = await loadSqlJs();
  const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));
  const notes: string[] = [];
  const tables: SourceTable[] = [];
  try {
    const objects = (db.exec("SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY rowid")[0]?.values ?? []).map(
      ([type, name, sql]) => ({ type: String(type), name: String(name), sql: String(sql ?? '') }),
    );
    const virtual = objects.filter((o) => o.type === 'table' && /^\s*CREATE\s+VIRTUAL\s+TABLE/i.test(o.sql)).map((o) => o.name);
    const shadow = (name: string) => virtual.some((v) => name.startsWith(`${v}_`));
    const views = objects.filter((o) => o.type === 'view').length;
    let skipped = 0;
    for (const { type, name } of objects) {
      if (type !== 'table') continue;
      if (virtual.includes(name) || shadow(name)) {
        skipped++;
        continue;
      }
      try {
        const declared = new Map((db.exec(`PRAGMA table_xinfo(${quoteIdentifier(name)})`)[0]?.values ?? []).map((r) => [String(r[1]), String(r[2] ?? '')]));
        const probe = db.prepare(`SELECT * FROM ${quoteIdentifier(name)}`);
        const names = probe.getColumnNames();
        probe.free();
        const columns = names.map((n) => ({ name: n, kind: kindOf(declared.get(n) ?? ''), sqlType: declared.get(n) ?? '' }));
        const dates = columns.map((c) => c.kind !== 'any');
        const rowCount = Number(db.exec(`SELECT COUNT(*) FROM ${quoteIdentifier(name)}`)[0].values[0][0]);
        tables.push({
          name,
          columns,
          rowCount,
          async *rows() {
            const statement = db.prepare(`SELECT * FROM ${quoteIdentifier(name)}`);
            try {
              let block: Value[][] = [];
              while (statement.step()) {
                block.push(statement.get(null, { useBigInt: true }).map((v, i) => plain(v, dates[i])));
                if (block.length === BLOCK) {
                  yield block;
                  block = [];
                }
              }
              if (block.length) yield block;
            } finally {
              statement.free();
            }
          },
        });
      } catch (error) {
        notes.push(`Table “${name}” could not be read and is left out: ${error instanceof Error ? error.message : error}`);
      }
    }
    if (views) notes.push(`${plural(views, 'view')} left out; views are saved queries, not data of their own.`);
    if (skipped) notes.push(`${plural(skipped, 'virtual or index table')} left out (full-text or spatial indexes).`);
  } catch (error) {
    db.close();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(/not a database|malformed/i.test(message) ? `This is not a SQLite database, or it is damaged (${message}).` : message);
  }
  return { tables, notes, close: () => db.close() };
}
