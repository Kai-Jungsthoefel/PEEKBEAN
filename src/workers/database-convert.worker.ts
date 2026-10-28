// SPDX-License-Identifier: GPL-3.0-or-later
// Converts databases off the main thread: Access (mdb-reader), SQLite (sql.js), Parquet (hyparquet) and Arrow
// (apache-arrow) to an XLSX workbook with one sheet per table, one CSV file per table, or a new SQLite database.
// Readers and writers live in convert/database/ and load only when a conversion needs them; rows go from the one to
// the other in blocks.
import type { SourceDatabase } from '../convert/database/source';

export interface DatabaseConvertRequest {
  file: File;
  /** Viewer that detected the file: access, sqlite or columnar. */
  viewer: string;
  target: 'xlsx' | 'csv' | 'sqlite';
  /** Table name for formats with a single table (Parquet, Arrow): the file name without extension. */
  name: string;
  separator: string;
  /** Starts CSV files with a byte order mark, so Excel reads them as UTF-8. */
  bom: boolean;
  password?: string;
}

export type DatabaseConvertResponse =
  | { kind: 'progress'; message: string; fraction?: number }
  | { kind: 'done'; files: { table: string; data: Blob | Uint8Array }[]; notes: string[] }
  | { kind: 'error'; error: string; wrongPassword?: boolean };

const post = (response: DatabaseConvertResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(response, transfer);

/** At most a few progress messages per second; the page redraws for each. */
let last = 0;
function progress(message: string, fraction?: number): void {
  const now = performance.now();
  if (fraction !== undefined && fraction > 0 && fraction < 1 && now - last < 150) return;
  last = now;
  post({ kind: 'progress', message, fraction: fraction === undefined ? undefined : Math.min(1, fraction) });
}

async function open({ file, viewer, name, password }: DatabaseConvertRequest): Promise<SourceDatabase> {
  if (viewer === 'access') return (await import('../convert/database/read-access')).readAccess(file, password);
  if (viewer === 'sqlite') return (await import('../convert/database/read-sqlite')).readSqlite(file);
  if (viewer === 'columnar') return (await import('../convert/database/read-columnar')).readColumnar(file, name);
  throw new Error('This kind of file cannot be converted as a database.');
}

self.onmessage = async (event: MessageEvent<DatabaseConvertRequest>) => {
  const request = event.data;
  try {
    progress('Opening the database …');
    const db = await open(request);
    try {
      if (db.tables.length === 0) throw new Error(['The database contains no tables.', ...db.notes].join(' '));
      if (request.target === 'csv') {
        const { writeCsv } = await import('../convert/database/write-csv');
        const { files, notes } = await writeCsv(db, request.separator, request.bom, progress);
        post({ kind: 'done', files, notes: [...notes, ...db.notes] });
      } else {
        const { data, notes } =
          request.target === 'xlsx'
            ? await (await import('../convert/database/write-xlsx')).writeXlsx(db, progress)
            : await (await import('../convert/database/write-sqlite')).writeSqlite(db, progress);
        post({ kind: 'done', files: [{ table: '', data }], notes: [...notes, ...db.notes] }, [data.buffer]);
      }
    } finally {
      db.close();
    }
  } catch (error) {
    // From the Access reader: the database needs a password that was not given or is wrong.
    const wrongPassword = error instanceof Error && error.name === 'WrongPassword';
    post({ kind: 'error', error: error instanceof Error ? error.message : String(error), wrongPassword });
  }
};
