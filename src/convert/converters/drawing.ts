// SPDX-License-Identifier: GPL-3.0-or-later
// DWG and HP-GL plot files to DXF. DWG goes through acadrust in the DWG worker, this time with everything it can
// write rather than only what the viewer draws; HP-GL through the plot converter the HPGL viewer uses.
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';
import type { DwgRequest, DwgResponse } from '../../workers/dwg.worker';

const DXF_TYPE = 'image/vnd.dxf';

async function convertDwg(file: File, progress: ConvertContext['progress']): Promise<ConvertResult> {
  progress('Loading the DWG reader …');
  const buffer = await file.arrayBuffer();
  const worker = new Worker(new URL('../../workers/dwg.worker.ts', import.meta.url), { type: 'module' });
  progress('Reading and converting DWG …');
  const response = await new Promise<DwgResponse>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<DwgResponse>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || 'The DWG converter could not be loaded.'));
    worker.postMessage({ kind: 'convert', buffer } satisfies DwgRequest, [buffer]);
  }).finally(() => worker.terminate());
  if (!response.ok) throw new Error(`The DWG file could not be read: ${response.error}`);
  if (response.kind !== 'converted') throw new Error('The DWG converter gave an unexpected answer.');
  return { files: [new File([response.dxf as Uint8Array<ArrayBuffer>], resultName(file.name, 'dxf'), { type: DXF_TYPE })], notes: response.warnings };
}

export async function convert({ file, viewer, progress }: ConvertContext): Promise<ConvertResult> {
  if (viewer === 'dwg') return convertDwg(file, progress);
  progress('Reading plot file …');
  const { convertHpgl } = await import('../../viewers/hpgl/convert');
  const result = convertHpgl(new Uint8Array(await file.arrayBuffer()));
  // Gnuplot scripts are .plt files as well.
  if (!result.isHpgl) throw new Error('This file contains no HP-GL plot instructions.');
  return { files: [new File([result.dxf], resultName(file.name, 'dxf'), { type: DXF_TYPE })], notes: result.warnings };
}
