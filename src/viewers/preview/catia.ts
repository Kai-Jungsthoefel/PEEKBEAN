// SPDX-License-Identifier: GPL-3.0-or-later
// CATIA V5 documents (V5_CFV2 container). The preview is a JPEG in the "CATSummaryInformation" segment, a FINJPL block
// of type 0x01010003, next to the versions that created and last saved the file (cadmpeg's format notes, CC-BY-4.0).
import { row, section, type MetaSection } from '../../metadata/model';
import { findPicture, indexOf } from './images';
import type { PreviewResult } from './types';

const KINDS: Record<string, string> = { catpart: 'CATIA part', catproduct: 'CATIA product', catdrawing: 'CATIA drawing', catshape: 'CATIA shape', catprocess: 'CATIA process' };
const SEGMENT = 'FINJPL  ';
const SUMMARY_TYPE = 0x01010003;

export function readCatia(data: Uint8Array, extension: string): PreviewResult {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let image = null;
  let summaryText = '';
  for (let at = indexOf(data, SEGMENT); at >= 0 && at + 12 <= data.length; at = indexOf(data, SEGMENT, at + SEGMENT.length)) {
    if (view.getUint32(at + 8) !== SUMMARY_TYPE) continue;
    const next = indexOf(data, SEGMENT, at + SEGMENT.length);
    const end = next < 0 ? data.length : next;
    image ??= findPicture(data, at, end);
    summaryText ||= new TextDecoder('latin1').decode(data.subarray(at, Math.min(end, at + 64 * 1024)));
    if (image) break;
  }

  // "<Version>5/<Version><Release>21/<Release><ServicePack>0/<ServicePack>" after each label.
  const version = (label: string) => {
    const m = new RegExp(`${label}[\\s\\S]{0,40}?<Version>(\\d+)/<Version><Release>(\\d+)/<Release><ServicePack>(\\d+)/<ServicePack>(?:<BuildDate>([^/<]*)/<BuildDate>)?`).exec(summaryText);
    return m ? `CATIA V${m[1]} R${m[2]} SP${m[3]}${m[4] ? ` (build ${m[4]})` : ''}` : '';
  };

  return {
    kind: KINDS[extension] ?? 'CATIA V5 document',
    images: image ? [image] : [],
    limits: 'This is the preview picture CATIA saved in the file. The 3D model cannot be shown: CATIA files are a closed format. Save the model as STEP in CATIA to view it here in 3D.',
    sections: [section('Document', [row('Created with', version('FirstStreamed')), row('Last saved with', version('LastSaveVersion'))])].filter((s): s is MetaSection => !!s),
    lists: [],
  };
}
