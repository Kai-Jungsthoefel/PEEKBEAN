// SPDX-License-Identifier: GPL-3.0-or-later
// Table of records read on demand, shared by the Access and Parquet/Arrow viewers: the grid asks for the rows in view,
// they are fetched in blocks; a bar above shows the selected value in full and opens binary values as files.
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { createGrid, type Grid, type GridCell } from './grid';

/** Browsers stop scrolling a single element at about 33 million pixels, i.e. 1.3 million rows of 24 px. */
const MAX_ROWS = 1_000_000;
const BLOCK = 500;

/** Style 0 of the grid: dimmed text for missing values. */
const STYLES = ['color:var(--tx3)'];
export const NULL_CELL: GridCell = { text: 'NULL', style: 0 };

export interface TableColumn {
  name: string;
  /** Header tooltip, e.g. the column's type. */
  tip: string;
  width: number;
  cell(value: unknown): GridCell;
  /** Full text for the value bar; defaults to the cell text. */
  detail?(value: unknown): string;
  /** Files inside a value (binary data, attachments), offered for opening. */
  files?(value: unknown): { name: string; data: Uint8Array }[];
}

export interface TableSource {
  rowCount: number;
  columns: TableColumn[];
  /** Rows [start, end) as one value per column. */
  read(start: number, end: number): Promise<unknown[][]>;
}

export interface TableView {
  element: HTMLElement;
  destroy(): void;
}

export const bytesLabel = (length: number) => `[binary, ${length.toLocaleString('en-US')} bytes]`;
const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** ISO-like date and time in UTC, e.g. 2026-09-01 14:30:05.250; milliseconds only when present. */
export function isoDateTime(date: Date, withTime = true): string {
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  const year = date.getUTCFullYear();
  const day = `${year < 0 ? '-' : ''}${pad(Math.abs(year), 4)}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
  if (!withTime) return day;
  const ms = date.getUTCMilliseconds();
  return `${day} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}${ms ? `.${pad(ms, 3)}` : ''}`;
}

/** JSON for nested values: BigInt as a number, bytes as a label, dates ISO-like. */
export function jsonText(value: unknown, indent?: number): string {
  return (
    JSON.stringify(
      value,
      function (key, v) {
        const raw = (this as Record<string, unknown>)[key];
        if (typeof v === 'bigint') return `${v}n`;
        if (raw instanceof Date) return isoDateTime(raw);
        if (raw instanceof Uint8Array) return bytesLabel(raw.length);
        if (v instanceof Map) return Object.fromEntries(v);
        return v;
      },
      indent,
    ) ?? 'undefined'
  ).replace(/"(-?\d+)n"/g, '$1');
}

/** Table with a header row, for schema and file information. */
export function infoTable(headers: string[], rows: (string | Node | null)[][], className = ''): HTMLElement {
  return h(
    'div',
    { class: 'dt-table-wrap' },
    h(
      'table',
      { class: `dt-info ${className}` },
      h('thead', {}, h('tr', {}, ...headers.map((t) => h('th', {}, t)))),
      h('tbody', {}, ...rows.map((r) => h('tr', {}, ...r.map((c) => h('td', {}, c ?? ''))))),
    ),
  );
}

export function createTableView(source: TableSource, openFile: (file: File) => void): TableView {
  const { columns } = source;
  const rowCount = Math.min(source.rowCount, MAX_ROWS);
  const cells: GridCell[][] = [];
  const values: unknown[][] = [];
  const requested = new Set<number>();
  let view = { first: 0, last: 0 };
  let queue: number[] = [];
  let busy = false;
  let destroyed = false;
  let grid: Grid | null = null;

  const status = h('div', { class: 'dt-status' });
  if (source.rowCount > MAX_ROWS) {
    status.textContent = `Showing the first ${MAX_ROWS.toLocaleString('en-US')} of ${source.rowCount.toLocaleString('en-US')} rows.`;
  }
  const barColumn = h('span', { class: 'dt-cell-col' });
  const barValue = h('span', { class: 'dt-cell-val c3' }, 'Select a cell to see its full value.');
  const barActions = h('span', { class: 'dt-cell-actions' });
  const bar = h('div', { class: 'dt-cell' }, barColumn, barValue, barActions);

  function select(row: number, column: number): void {
    const col = columns[column];
    const loaded = values[row];
    barActions.replaceChildren();
    barColumn.textContent = `${col.name} · row ${(row + 1).toLocaleString('en-US')}`;
    if (!loaded) {
      barValue.textContent = 'Loading …';
      barValue.className = 'dt-cell-val c3';
      return;
    }
    const value = loaded[column];
    const cell = col.cell(value);
    barValue.textContent = col.detail ? col.detail(value) : typeof cell === 'string' ? cell : cell.text;
    barValue.className = `dt-cell-val${value === null || value === undefined ? ' c3' : ''}`;
    for (const file of col.files?.(value) ?? []) {
      barActions.append(
        h('button', { type: 'button', class: 'btn sm', title: `Open ${file.name} in a new tab`, onclick: () => openFile(new File([file.data as Uint8Array<ArrayBuffer>], file.name)) },
          icon('external', 14), `Open ${file.name}`),
      );
    }
  }

  async function pump(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !destroyed) {
        // Rows that scrolled out of view meanwhile are skipped; they are asked for again when they come back.
        const block = queue.shift()!;
        const start = block * BLOCK;
        const end = Math.min(rowCount, start + BLOCK);
        if (end < view.first - BLOCK || start > view.last + BLOCK) {
          requested.delete(block);
          continue;
        }
        try {
          const rows = await source.read(start, end);
          if (destroyed) return;
          rows.forEach((row, i) => {
            values[start + i] = row;
            cells[start + i] = columns.map((c, j) => c.cell(row[j]));
          });
        } catch (error) {
          status.textContent = `Rows ${(start + 1).toLocaleString('en-US')}–${end.toLocaleString('en-US')} could not be read: ${error instanceof Error ? error.message : error}`;
          status.classList.add('error');
        }
        grid?.refresh();
      }
    } finally {
      busy = false;
    }
  }

  function onView(first: number, last: number): void {
    view = { first, last };
    const blocks: number[] = [];
    for (let b = Math.floor(first / BLOCK); b <= Math.floor(last / BLOCK); b++) if (!requested.has(b)) blocks.push(b);
    if (!blocks.length) return;
    for (const b of blocks) requested.add(b);
    // The newest view first; older requests stay queued behind it.
    queue = [...blocks, ...queue.filter((b) => !blocks.includes(b))];
    void pump();
  }

  grid = createGrid(
    {
      rows: cells,
      rowCount,
      onView,
      columnCount: columns.length,
      columnTitles: columns.map((c) => c.name),
      columnTips: columns.map((c) => `${c.name}\n${c.tip}`),
      columnWidths: columns.map((c) => c.width),
      styles: STYLES,
    },
    (_address, _cell, row, column) => select(row, column),
  );
  const element = h('div', { class: 'dt-table' }, status, bar, h('div', { class: 'grid-host' }, grid.element));
  if (!columns.length) element.prepend(h('p', { class: 'dt-empty' }, 'The table has no columns.'));
  else if (!rowCount) element.prepend(h('p', { class: 'dt-empty' }, 'The table is empty.'));
  return {
    element,
    destroy: () => {
      destroyed = true;
      grid?.destroy();
    },
  };
}
