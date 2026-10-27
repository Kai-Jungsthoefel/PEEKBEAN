// SPDX-License-Identifier: GPL-3.0-or-later
// Access databases (.mdb, .accdb) with mdb-reader (MIT), off the main thread. mdb-reader expects Node's Buffer as a
// global, from the "buffer" package (MIT); it stays inside this worker. The database is a copy in memory.
import { Buffer } from 'buffer';
import type MDBReader from 'mdb-reader';
import type { Column, Table } from 'mdb-reader';

export type AccessRequest =
  | { kind: 'open'; file: Blob; password?: string }
  | { kind: 'rows'; table: string; start: number; end: number };

export interface AccessTable {
  name: string;
  rowCount: number;
  columns: Column[];
  linked: boolean;
  /** Why the table definition could not be read. */
  error?: string;
}

export type AccessResponse =
  | { ok: true; kind: 'open'; version: number; ace: boolean; created: Date | null; passwordSet: boolean; tables: AccessTable[] }
  | { ok: true; kind: 'rows'; rows: unknown[][] }
  | { ok: false; error: string; wrongPassword?: boolean };

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;

let reader: MDBReader | null = null;
const tables = new Map<string, Table>();
const post = (response: AccessResponse) => (self as unknown as Worker).postMessage(response);

self.onmessage = async (event: MessageEvent<AccessRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'open') {
      // Loaded only now, after the Buffer global exists.
      const { default: Reader } = await import('mdb-reader');
      const bytes = Buffer.from(await request.file.arrayBuffer());
      try {
        reader = new Reader(bytes, { password: request.password });
      } catch (error) {
        if (error instanceof Error && /wrong password/i.test(error.message)) {
          post({ ok: false, error: 'Wrong password.', wrongPassword: true });
          return;
        }
        throw error;
      }
      const list: AccessTable[] = reader.getTableNames().map((name) => {
        try {
          const table = reader!.getTable(name);
          tables.set(name, table);
          return { name, rowCount: table.rowCount, columns: table.getColumns(), linked: false };
        } catch (error) {
          return { name, rowCount: 0, columns: [], linked: false, error: error instanceof Error ? error.message : String(error) };
        }
      });
      for (const name of reader.getTableNames({ normalTables: false, linkedTables: true })) list.push({ name, rowCount: 0, columns: [], linked: true });
      post({
        ok: true,
        kind: 'open',
        version: bytes[0x14],
        ace: bytes.toString('latin1', 4, 19) === 'Standard ACE DB',
        created: reader.getCreationDate(),
        passwordSet: reader.getPassword() !== null || Boolean(request.password),
        tables: list,
      });
    } else {
      const table = tables.get(request.table);
      if (!table) throw new Error(`There is no table “${request.table}”.`);
      const names = table.getColumnNames();
      const rows = table.getData({ rowOffset: request.start, rowLimit: request.end - request.start });
      post({ ok: true, kind: 'rows', rows: rows.map((row) => names.map((n) => row[n])) });
    }
  } catch (error) {
    post({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
