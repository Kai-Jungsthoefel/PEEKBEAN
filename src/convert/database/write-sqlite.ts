// SPDX-License-Identifier: GPL-3.0-or-later
// A new SQLite database with sql.js (MIT): one table per source table with the column types mapped to SQLite's, the
// rows inserted in one transaction per block. Binary values are kept whole; dates become ISO 8601 text, the form
// SQLite's date functions read.
import { loadSqlJs, quoteIdentifier } from './sqljs';
import { Changes, dateShape, exactDecimal, isoText, plural, type Progress, type SourceDatabase, type SourceTable, type Value } from './source';

/** Names unique without regard to case, as SQLite compares them; "sqlite_" starts only SQLite's own tables. */
function uniqueName(name: string, used: Set<string>, fallback: string): string {
  let base = name.trim() || fallback;
  if (/^sqlite_/i.test(base)) base = `_${base}`;
  let candidate = base;
  for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${base}_${n}`;
  used.add(candidate.toLowerCase());
  return candidate;
}

function bindable(value: Value, kind: SourceTable['columns'][number]['kind'], changes: Changes): unknown {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : isoText(value, dateShape(value, kind));
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && kind === 'decimal') {
    const number = exactDecimal(value);
    if (number !== null) return number;
    // A DECIMAL column turns the text into a double, keeping 15 significant digits.
    changes.count('decimal', (n) => `${plural(n, 'decimal')} with more than 15 digits rounded to 15; SQLite has no exact decimal type.`);
  }
  return value;
}

export async function writeSqlite(source: SourceDatabase, progress: Progress): Promise<{ data: Uint8Array; notes: string[] }> {
  const SQL = await loadSqlJs();
  const db = new SQL.Database();
  const changes = new Changes();
  const notes: string[] = [];
  const tableNames = new Set<string>();
  const total = source.tables.reduce((sum, t) => sum + t.rowCount, 0) || 1;
  let done = 0;
  let keys = 0;
  try {
    for (const [index, table] of source.tables.entries()) {
      const label = `Table ${index + 1} of ${source.tables.length}: ${table.name}`;
      const name = uniqueName(table.name, tableNames, 'table');
      if (name !== table.name) notes.push(`Table “${table.name}” is named “${name}”.`);
      const columnNames = new Set<string>();
      const columns = table.columns.map((c, i) => ({ ...c, name: uniqueName(c.name, columnNames, `column${i + 1}`) }));
      const start = done;
      const write = async (key: number[]) => {
        done = start;
        progress(label, done / total);
        // A single INTEGER key becomes SQLite's row id.
        const rowid = key.length === 1 && /^INTEGER$/i.test(columns[key[0]].sqlType) ? key[0] : -1;
        const definitions = columns.map((c, i) => `${quoteIdentifier(c.name)}${i === rowid ? ' INTEGER PRIMARY KEY' : c.sqlType ? ` ${c.sqlType}` : ''}`);
        if (key.length && rowid < 0) definitions.push(`PRIMARY KEY (${key.map((i) => quoteIdentifier(columns[i].name)).join(', ')})`);
        db.run(`CREATE TABLE ${quoteIdentifier(name)} (${definitions.join(', ')})`);
        if (columns.length === 0) return;
        const insert = db.prepare(`INSERT INTO ${quoteIdentifier(name)} VALUES (${columns.map(() => '?').join(', ')})`);
        try {
          for await (const block of table.rows()) {
            db.run('BEGIN');
            try {
              for (const row of block) insert.run(row.map((v, i) => bindable(v, columns[i].kind, changes)));
              db.run('COMMIT');
            } catch (error) {
              db.run('ROLLBACK');
              throw error;
            }
            done += block.length;
            progress(label, done / total);
          }
        } finally {
          insert.free();
        }
      };
      const key = (table.primaryKey ?? []).map((k) => table.columns.findIndex((c) => c.name === k)).filter((i) => i >= 0);
      try {
        await write(key);
        if (key.length) keys++;
      } catch (error) {
        // A key the reader only assumed (Access AutoNumber) whose values are not unique: the table goes without it.
        if (!key.length || !/UNIQUE constraint|datatype mismatch/i.test(String(error))) throw error;
        db.run(`DROP TABLE ${quoteIdentifier(name)}`);
        await write([]);
      }
    }
    // Only the Access reader names keys, and only AutoNumber columns.
    if (keys) notes.push('AutoNumber columns became the primary key; other indexes and relations are not kept.');
    progress('Writing the SQLite file …');
    return { data: db.export(), notes: [...notes, ...changes.notes()] };
  } finally {
    db.close();
  }
}
