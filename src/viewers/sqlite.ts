// SPDX-License-Identifier: GPL-3.0-or-later
// SQLite databases via sql.js (MIT). The database is a copy in memory; nothing is written back.
import initSqlJs from 'sql.js';
import wasmUrl from 'sql.js/dist/sql-wasm.wasm?url';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import type { ViewerContext } from '../core/types';
import { createGrid, type Grid, type GridCell } from './grid';

const MAX_ROWS = 100_000;

const quoteIdentifier = (name: string) => `"${name.replace(/"/g, '""')}"`;

function cellOf(value: unknown): GridCell {
  if (value === null) return { text: 'NULL' };
  if (value instanceof Uint8Array) return `[BLOB, ${value.length} bytes]`;
  if (typeof value === 'number') return { text: String(value), numeric: true };
  return String(value);
}

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  progress('Opening database …');
  const SQL = await initSqlJs({ locateFile: () => wasmUrl });
  const db = new SQL.Database(new Uint8Array(await file.arrayBuffer()));

  const objects = db.exec("SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name")[0];
  const tables = (objects?.values ?? []).map(([name, type]) => ({ name: String(name), type: String(type) }));

  const query = h('input', { class: 'sql-input', spellcheck: false, placeholder: 'SELECT …', title: 'SQL query, Enter runs it' });
  const runButton = h('button', { type: 'button', class: 'btn sm', onclick: () => run(query.value) }, 'Run');
  const message = h('div', { class: 'sql-message' });
  const gridHost = h('div', { class: 'grid-host' });
  const list = h('nav', { class: 'db-tables' });
  container.classList.add('db-view');
  container.append(list, h('div', { class: 'db-main' }, h('div', { class: 'sql-bar' }, query, runButton), message, gridHost));

  let grid: Grid | null = null;
  function run(sql: string): void {
    grid?.destroy();
    grid = null;
    gridHost.replaceChildren();
    message.textContent = '';
    message.className = 'sql-message';
    let statement;
    try {
      statement = db.prepare(sql);
      const columns = statement.getColumnNames();
      const rows: GridCell[][] = [];
      while (rows.length < MAX_ROWS && statement.step()) rows.push(statement.get().map(cellOf));
      const more = rows.length === MAX_ROWS && statement.step();
      grid = createGrid({ rows, columnCount: columns.length, columnTitles: columns, columnWidths: columns.map(() => 140) });
      gridHost.append(grid.element);
      message.textContent = `${rows.length.toLocaleString('en-US')}${more ? '+' : ''} rows${more ? ` (showing the first ${MAX_ROWS.toLocaleString('en-US')})` : ''}`;
    } catch (error) {
      message.textContent = error instanceof Error ? error.message : String(error);
      message.classList.add('error');
    } finally {
      statement?.free();
    }
  }
  query.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') run(query.value);
  });

  const select = (name: string, button: HTMLElement) => {
    for (const b of list.children) b.classList.toggle('on', b === button);
    query.value = `SELECT * FROM ${quoteIdentifier(name)}`;
    run(query.value);
  };
  list.append(
    h('div', { class: 'db-tables-hd' }, 'Tables and views'),
    ...tables.map((t) => {
      const button: HTMLButtonElement = h('button', { type: 'button', class: 'db-table', title: t.name, onclick: () => select(t.name, button) },
        icon(t.type === 'view' ? 'layers' : 'table', 14), h('span', {}, t.name));
      return button;
    }),
  );
  toolbar.append(h('span', { class: 'meta' }, `${tables.length} tables/views`));
  if (tables.length) select(tables[0].name, list.children[1] as HTMLElement);
  else message.textContent = 'The database contains no tables.';

  return {
    destroy: () => {
      grid?.destroy();
      db.close();
    },
  };
}
