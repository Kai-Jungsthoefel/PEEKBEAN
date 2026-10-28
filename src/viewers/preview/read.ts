// SPDX-License-Identifier: GPL-3.0-or-later
// Picks the reader for a file whose content OPSIS cannot draw but whose preview picture and properties it can show:
// CAD files of closed formats, Blender files and design documents. Runs in a worker.
import { extensionOf, startsWith } from '../../core/bytes';
import { blendCompression, readBlender } from './blender';
import { isCfb } from './cfb';
import { readCatia } from './catia';
import { isCreo, readCreo } from './creo';
import { isAffinity, isPostScript, readAffinity, readFigma, readPdn, readPostScript } from './design';
import { readNx } from './nx';
import { readOle } from './ole';
import { readSolidWorks } from './solidworks';
import { isSwContainer, readSwRecord, swRecords } from './swcontainer';
import type { PreviewResult } from './types';
import { isInDesign, readInDesign } from './xmp';

export async function readPreview(file: File, progress: (fraction: number) => void): Promise<PreviewResult> {
  const extension = extensionOf(file.name);
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const blend = blendCompression(head);
  if (blend === 'none' || (blend && extension.startsWith('blend'))) return readBlender(file, progress);
  if (startsWith(head, 'PDN3')) return readPdn(file);
  if (isAffinity(head)) return readAffinity(file, extension);
  if (isInDesign(head)) return readInDesign(file, extension);
  if (extension === 'fig' || startsWith(head, 'fig-')) return readFigma(file);
  if (isPostScript(head) || ['eps', 'epsf', 'ai'].includes(extension)) return readPostScript(file, extension);

  // The CAD formats are read whole.
  const data = new Uint8Array(await file.arrayBuffer());
  if (isCfb(head)) return readOle(data, extension, file.name);
  if (startsWith(head, 'SPLMSSTR')) return readNx(data, file.name);
  if (startsWith(head, 'V5_CFV2\0')) return readCatia(data, extension);
  if (isCreo(head)) return readCreo(data);
  if (isSwContainer(head) && ['sldprt', 'sldasm', 'slddrw'].includes(extension)) {
    const records = swRecords(data);
    return readSolidWorks(
      {
        names: records.map((r) => r.name),
        read: async (name) => {
          const record = records.find((r) => r.name === name);
          return record ? readSwRecord(data, record).catch(() => null) : null;
        },
      },
      extension,
    );
  }
  throw new Error('This file holds no preview picture or properties that OPSIS can read.');
}
