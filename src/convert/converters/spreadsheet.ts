// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionOf } from '../../core/bytes';
import type { SheetConvertRequest, SheetConvertResponse } from '../../workers/sheet-convert.worker';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

const MIME: Record<string, string> = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
  xlsb: 'application/vnd.ms-excel.sheet.binary.macroEnabled.12',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  fods: 'application/vnd.oasis.opendocument.spreadsheet',
  html: 'text/html',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  json: 'application/json',
  md: 'text/markdown',
};

/** Names in the note on several files: "One CSV file for each …". */
const LABELS: Record<string, string> = { csv: 'CSV', tsv: 'TSV', json: 'JSON', md: 'Markdown' };

export async function convert({ file, target, options, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading spreadsheet …');
  const buffer = await file.arrayBuffer();
  const request: SheetConvertRequest = {
    buffer,
    text: ['csv', 'tsv'].includes(extensionOf(file.name)),
    target: target as SheetConvertRequest['target'],
    name: file.name,
    separator: options.separator,
    bom: options.encoding === 'bom',
  };
  const worker = new Worker(new URL('../../workers/sheet-convert.worker.ts', import.meta.url), { type: 'module' });
  const response = await new Promise<SheetConvertResponse>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<SheetConvertResponse>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || 'The spreadsheet converter could not be loaded.'));
    worker.postMessage(request, [buffer]);
  }).finally(() => worker.terminate());

  if (!response.ok) throw new Error(response.error);
  if ('workbook' in response) {
    return { files: [new File([response.workbook as Uint8Array<ArrayBuffer>], resultName(file.name, target), { type: MIME[target] })], notes: [] };
  }
  const several = response.sheets.length > 1;
  return {
    files: response.sheets.map((sheet) => new File([sheet.data as Uint8Array<ArrayBuffer>], resultName(file.name, target, several ? `- ${sheet.name}` : ''), { type: MIME[target] })),
    notes: [...(several ? [`One ${LABELS[target]} file for each of the ${response.sheets.length} sheets.`] : []), ...response.notes],
  };
}
