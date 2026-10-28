// SPDX-License-Identifier: GPL-3.0-or-later
// Access, SQLite, Parquet and Arrow files to XLSX (one sheet per table), CSV (one file per table) or SQLite. The work
// happens in the database worker; this side asks for the password of a protected Access database, as the viewer does.
import type { DatabaseConvertRequest, DatabaseConvertResponse } from '../../workers/database-convert.worker';
import { baseName, resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

const MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  sqlite: 'application/vnd.sqlite3',
};

function run(request: DatabaseConvertRequest, progress: ConvertContext['progress']): Promise<Exclude<DatabaseConvertResponse, { kind: 'progress' }>> {
  const worker = new Worker(new URL('../../workers/database-convert.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Exclude<DatabaseConvertResponse, { kind: 'progress' }>>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<DatabaseConvertResponse>) => {
      if (event.data.kind === 'progress') progress(event.data.message, event.data.fraction);
      else resolve(event.data);
    };
    worker.onerror = (event) => reject(new Error(event.message || 'The database converter could not be loaded.'));
    worker.postMessage(request);
  }).finally(() => worker.terminate());
}

export async function convert({ file, viewer, target, options, progress }: ConvertContext): Promise<ConvertResult> {
  // GeoPackage, MBTiles and other SQLite files already are SQLite.
  if (viewer === 'sqlite' && target === 'sqlite') {
    return { files: [new File([file], resultName(file.name, 'sqlite'), { type: MIME.sqlite })], notes: ['The file already is a SQLite database; it is saved unchanged.'] };
  }
  const request: DatabaseConvertRequest = {
    file,
    viewer,
    target: target as DatabaseConvertRequest['target'],
    name: baseName(file.name),
    separator: options.separator ?? ',',
    bom: options.encoding !== 'plain',
  };
  for (;;) {
    const response = await run(request, progress);
    if (response.kind === 'done') {
      const several = response.files.length > 1;
      const files = response.files.map(({ table, data }) =>
        new File([data as BlobPart], resultName(file.name, target, several ? `- ${table}` : ''), { type: MIME[target] }),
      );
      const notes = several ? [`One CSV file for each of the ${files.length} tables.`] : [];
      return { files, notes: [...notes, ...response.notes] };
    }
    if (!response.wrongPassword) throw new Error(response.error);
    const input = window.prompt(request.password === undefined ? `“${file.name}” is protected by a password. Password:` : 'Wrong password. Please try again:');
    if (input === null) throw new Error('The database cannot be opened without its password.');
    request.password = input;
  }
}
