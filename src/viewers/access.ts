// SPDX-License-Identifier: GPL-3.0-or-later
// Access databases (.mdb, .accdb, Access 97 to 365) via mdb-reader (MIT) in a worker: tables on the left, records on
// the right, read as they scroll into view. Saved queries, forms and reports are not shown; nothing is written back.
import { h } from '../core/dom';
import { icon } from '../core/icons';
import type { ViewerContext } from '../core/types';
import type { AccessRequest, AccessResponse, AccessTable } from '../workers/access.worker';
import { bytesLabel, createTableView, infoTable, NULL_CELL, type TableColumn, type TableView } from './datatable';
import type { GridCell } from './grid';

type Column = AccessTable['columns'][number];
type Attachment = { name: string; data: Uint8Array };

const VERSIONS: Record<number, string> = {
  0: 'Access 97 (Jet 3)',
  1: 'Access 2000–2003 (Jet 4)',
  2: 'Access 2007 (ACE 12)',
  3: 'Access 2010 (ACE 14)',
  4: 'Access 2013 (ACE 15)',
  5: 'Access 2016 (ACE 16)',
  6: 'Access 2019 or later (ACE 17)',
};

const TYPES: Record<string, string> = {
  boolean: 'Yes/No', byte: 'Byte', integer: 'Integer', long: 'Long Integer', bigint: 'Large Number', currency: 'Currency',
  float: 'Single', double: 'Double', numeric: 'Decimal', datetime: 'Date/Time', datetimextended: 'Date/Time Extended',
  text: 'Text', memo: 'Memo (Long Text)', binary: 'Binary', ole: 'OLE Object', repid: 'Replication ID', complex: 'Attachment',
};
const NUMERIC = new Set(['byte', 'integer', 'long', 'bigint', 'currency', 'float', 'double', 'numeric']);

/** Access keeps times of day as dates on December 30, 1899; dates and times are local, stored without a zone. */
function dateTimeText(date: Date): string {
  if (Number.isNaN(date.getTime())) return 'Invalid date';
  const timeOnly = date.getUTCFullYear() === 1899 && date.getUTCMonth() === 11 && date.getUTCDate() === 30;
  const midnight = !date.getUTCHours() && !date.getUTCMinutes() && !date.getUTCSeconds();
  if (timeOnly) return date.toLocaleTimeString('en-US', { timeZone: 'UTC' });
  return midnight ? date.toLocaleDateString('en-US', { timeZone: 'UTC' }) : date.toLocaleString('en-US', { timeZone: 'UTC' });
}

/** Currency comes as a decimal string with four places: group the thousands, keep at least two places. */
function currencyText(value: string): string {
  const [whole, fraction = ''] = value.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${fraction.replace(/0+$/, '').padEnd(2, '0')}`;
}

function typeText(column: Column, unicodeText: boolean): string {
  const name = TYPES[column.type] ?? column.type;
  if (column.autoLong) return 'AutoNumber (Long Integer)';
  if (column.autoUUID) return 'AutoNumber (Replication ID)';
  if (column.type === 'text') return `${name} (${unicodeText ? column.size / 2 : column.size})`;
  if (column.type === 'numeric' && column.precision !== undefined) return `${name} (${column.precision}, ${column.scale ?? 0})`;
  return name;
}

function tableColumn(column: Column, unicodeText: boolean): TableColumn {
  const numeric = NUMERIC.has(column.type);
  const attachments = (value: unknown) => (Array.isArray(value) ? (value as Attachment[]) : []);
  const cell = (value: unknown): GridCell => {
    if (value === null || value === undefined) return NULL_CELL;
    if (value instanceof Date) return dateTimeText(value);
    if (value instanceof Uint8Array) return bytesLabel(value.length);
    if (typeof value === 'boolean') return value ? 'Yes' : 'No';
    if (column.type === 'complex') {
      const list = attachments(value);
      return `[${list.length} ${list.length === 1 ? 'attachment' : 'attachments'}${list.length ? `: ${list.map((a) => a.name).join(', ')}` : ''}]`;
    }
    if (column.type === 'repid' && typeof value === 'string') return `{${value.toUpperCase()}}`;
    if (column.type === 'currency' && typeof value === 'string') return { text: currencyText(value), numeric: true };
    if (column.type === 'float' && typeof value === 'number') return { text: String(Number(value.toPrecision(7))), numeric: true };
    return numeric ? { text: String(value), numeric: true } : String(value);
  };
  return {
    name: column.name,
    tip: typeText(column, unicodeText),
    width: column.type === 'boolean' ? 72 : column.type === 'memo' ? 260 : column.type === 'text' ? Math.min(240, Math.max(120, column.size * 4)) : numeric ? 110 : 150,
    cell,
    files: (value) => {
      if (value instanceof Uint8Array) {
        const inner = embeddedFile(value);
        return [inner ? { name: `${column.name}.${inner.extension}`, data: inner.data } : { name: `${column.name}.bin`, data: value }];
      }
      return attachments(value).filter((a) => a.data instanceof Uint8Array).map((a) => ({ name: a.name || 'attachment', data: a.data }));
    },
  };
}

const FILE_SIGNATURES: [string, number[]][] = [
  ['pdf', [0x25, 0x50, 0x44, 0x46, 0x2d]],
  ['png', [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  ['jpg', [0xff, 0xd8, 0xff]],
  ['gif', [0x47, 0x49, 0x46, 0x38]],
  ['tif', [0x49, 0x49, 0x2a, 0x00]],
  ['doc', [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]],
  ['zip', [0x50, 0x4b, 0x03, 0x04]],
];

/**
 * OLE objects wrap the inserted file in an OLE header (class name, package name …). A known file signature near the
 * start marks where the file begins; whatever follows it (an OLE trailer) does not disturb the viewers.
 */
function embeddedFile(bytes: Uint8Array): { data: Uint8Array; extension: string } | null {
  const limit = Math.min(bytes.length, 4096);
  for (let offset = 0; offset < limit; offset++) {
    for (const [extension, signature] of FILE_SIGNATURES) {
      if (signature.every((b, i) => bytes[offset + i] === b)) return { data: bytes.subarray(offset), extension };
    }
    // Paintbrush pictures are Windows bitmaps; their header gives the size, which must fit.
    if (bytes[offset] === 0x42 && bytes[offset + 1] === 0x4d && offset + 6 <= bytes.length) {
      const size = bytes[offset + 2] | (bytes[offset + 3] << 8) | (bytes[offset + 4] << 16) | (bytes[offset + 5] << 24);
      if (size > 54 && offset + size <= bytes.length) return { data: bytes.subarray(offset, offset + size), extension: 'bmp' };
    }
  }
  return null;
}

export async function mount({ file, container, toolbar, progress, openFile }: ViewerContext) {
  progress('Opening database …');
  const worker = new Worker(new URL('../workers/access.worker.ts', import.meta.url), { type: 'module' });
  // One request at a time, answered in order.
  let queue: Promise<unknown> = Promise.resolve();
  const call = (request: AccessRequest) => {
    const next = queue.then(
      () =>
        new Promise<AccessResponse>((resolve, reject) => {
          worker.onmessage = (e: MessageEvent<AccessResponse>) => resolve(e.data);
          worker.onerror = (e) => reject(new Error(e.message || 'The database module could not be loaded.'));
          worker.postMessage(request);
        }),
    );
    queue = next.catch(() => {});
    return next;
  };

  let opened: Extract<AccessResponse, { kind: 'open' }>;
  try {
    let password: string | undefined;
    for (;;) {
      const response = await call({ kind: 'open', file, password });
      if (response.ok && response.kind === 'open') {
        opened = response;
        break;
      }
      if (!response.ok && response.wrongPassword) {
        const input = window.prompt(password === undefined ? `“${file.name}” is protected by a password. Password:` : 'Wrong password. Please try again:');
        if (input === null) throw new Error('The database cannot be opened without its password.');
        password = input;
        continue;
      }
      const message = response.ok ? 'Unexpected answer from the database module.' : response.error;
      throw new Error(/page type|unknown jet|unsupported/i.test(message) ? `This is not an Access database, or it is damaged (${message}).` : message);
    }
  } catch (error) {
    worker.terminate();
    throw error;
  }

  const unicodeText = opened.version >= 1;
  const tables = opened.tables;
  const list = h('nav', { class: 'db-tables' });
  const title = h('b', {});
  const counts = h('span', { class: 'c2' });
  const records = h('button', { type: 'button', role: 'radio', onclick: () => show('records') }, 'Data');
  const columns = h('button', { type: 'button', role: 'radio', onclick: () => show('columns') }, 'Columns');
  const body = h('div', { class: 'dt-body' });
  container.classList.add('db-view', 'dt-view');
  container.append(list, h('div', { class: 'db-main' }, h('div', { class: 'dt-head' }, title, counts, h('span', { class: 'grow' }), h('div', { class: 'seg', role: 'radiogroup', 'aria-label': 'View' }, records, columns)), body));

  let current: AccessTable | null = null;
  let mode: 'records' | 'columns' = 'records';
  let view: TableView | null = null;

  function show(next: 'records' | 'columns'): void {
    mode = next;
    records.setAttribute('aria-checked', String(mode === 'records'));
    columns.setAttribute('aria-checked', String(mode === 'columns'));
    view?.destroy();
    view = null;
    body.replaceChildren();
    const table = current;
    if (!table) return;
    if (table.error) {
      body.append(h('p', { class: 'dt-empty' }, `This table could not be read: ${table.error}`));
    } else if (mode === 'columns') {
      body.append(
        h('div', { class: 'dt-scroll' },
          h('div', { class: 'dt-page' },
            h('section', { class: 'dt-section' },
              h('h3', {}, `Columns of ${table.name}`),
              infoTable(
                ['#', 'Column', 'Type', 'Stored size'],
                table.columns.map((c, i) => [String(i + 1), c.name, typeText(c, unicodeText), c.size ? `${c.size} ${c.size === 1 ? 'byte' : 'bytes'}` : '']),
              )))),
      );
    } else {
      const name = table.name;
      view = createTableView(
        {
          rowCount: table.rowCount,
          columns: table.columns.map((c) => tableColumn(c, unicodeText)),
          read: async (start, end) => {
            const r = await call({ kind: 'rows', table: name, start, end });
            if (!r.ok) throw new Error(r.error);
            if (r.kind !== 'rows') throw new Error('Unexpected answer from the database module.');
            return r.rows;
          },
        },
        openFile,
      );
      body.append(view.element);
    }
  }

  function select(table: AccessTable, button: HTMLElement): void {
    for (const b of list.querySelectorAll('.db-table')) b.classList.toggle('on', b === button);
    current = table;
    title.textContent = table.name;
    counts.textContent = `${table.rowCount.toLocaleString('en-US')} ${table.rowCount === 1 ? 'row' : 'rows'} · ${table.columns.length} ${table.columns.length === 1 ? 'column' : 'columns'}`;
    show(mode);
  }

  const local = tables.filter((t) => !t.linked);
  const linked = tables.filter((t) => t.linked);
  const buttons = local.map((t) => {
    const button: HTMLButtonElement = h('button', { type: 'button', class: 'db-table', title: t.name, onclick: () => select(t, button) },
      icon('table', 14), h('span', {}, t.name), h('small', { class: 'dt-count' }, t.rowCount.toLocaleString('en-US')));
    return button;
  });
  list.append(h('div', { class: 'db-tables-hd' }, 'Tables'), ...buttons);
  if (linked.length) {
    list.append(
      h('div', { class: 'db-tables-hd dt-sub' }, 'Linked tables'),
      ...linked.map((t) => h('div', { class: 'db-table dt-linked', title: `${t.name}: the data of a linked table lives in another database.` }, icon('link', 14), h('span', {}, t.name))),
    );
  }

  const created = opened.created ? `created ${opened.created.toLocaleDateString('en-US', { timeZone: 'UTC', dateStyle: 'medium' })}` : '';
  toolbar.append(
    h('span', { class: 'meta', title: [VERSIONS[opened.version] ?? `Unknown version ${opened.version}`, created].filter(Boolean).join(', ') },
      `${VERSIONS[opened.version] ?? (opened.ace ? 'Access (ACE)' : 'Access (Jet)')} · ${local.length} ${local.length === 1 ? 'table' : 'tables'}`),
  );
  if (opened.passwordSet) toolbar.append(h('span', { class: 'meta', title: 'The database has a password.' }, 'Password-protected'));

  if (buttons.length) select(local[0], buttons[0]);
  else body.append(h('p', { class: 'dt-empty' }, 'The database contains no tables.'));

  return {
    destroy: () => {
      view?.destroy();
      worker.terminate();
    },
  };
}
