// SPDX-License-Identifier: GPL-3.0-or-later
// PTC Creo (Pro/ENGINEER) models: a "#UGC" text header, then a table of contents of named sections. The preview is
// the JPEG in section THMB_IMG_MAIN, sometimes compressed with Unix compress (cadmpeg's format notes, CC-BY-4.0).
import { row, section, type MetaSection } from '../../metadata/model';
import { findPicture, indexOf } from './images';
import { isCompress, uncompress } from './lzw';
import type { PreviewImage, PreviewResult } from './types';

const KINDS: Record<string, string> = {
  PART: 'Creo part',
  ASSEMBLY: 'Creo assembly',
  DRAWING: 'Creo drawing',
  DWGFORM: 'Creo drawing format',
  LAYOUT: 'Creo layout',
  MANUFACTURE: 'Creo manufacturing model',
  SECTION: 'Creo sketch',
  DIAGRAM: 'Creo diagram',
  REPORT: 'Creo report',
  MARKUP: 'Creo markup',
};

export function isCreo(head: Uint8Array): boolean {
  return indexOf(head, '#UGC:', 0, 6) === 0;
}

/** The thumbnail section: from a table-of-contents row if one validates, else by its header. */
function thumbnail(data: Uint8Array, text: string): PreviewImage | null {
  const base = text.indexOf('#-END_OF_UGC_HEADER\n');
  if (base >= 0) {
    for (const m of text.matchAll(/(?:^|[\n#])THMB_IMG_MAIN ([0-9a-f]+) ([0-9a-f]+) ([0-9a-f]+)/g)) {
      const start = base + 20 + parseInt(m[1], 16);
      const header = '#THMB_IMG_MAIN\n';
      if (text.slice(start, start + header.length) !== header) continue;
      let payload = data.subarray(start + header.length, start + parseInt(m[2], 16));
      if (isCompress(payload)) {
        try {
          payload = uncompress(payload, 64 * 1024 * 1024);
        } catch {
          continue;
        }
      }
      const picture = findPicture(payload);
      if (picture) return picture;
    }
  }
  const at = text.indexOf('#THMB_IMG_MAIN\n');
  if (at < 0) return null;
  const rest = data.subarray(at + 15);
  return findPicture(isCompress(rest) ? uncompress(rest.subarray(0, 4 * 1024 * 1024), 64 * 1024 * 1024) : rest, 0, 4 * 1024 * 1024);
}

export function readCreo(data: Uint8Array): PreviewResult {
  // The header and the tables of contents are ASCII; latin1 keeps byte offsets equal to string offsets.
  const text = new TextDecoder('latin1').decode(data);
  const type = /^#UGC:\d+ (\w+)/.exec(text)?.[1] ?? '';
  const banner = /\n#((?:Creo|Pro\/ENGINEER|Wildfire)[^\n]*)/.exec(text.slice(0, 64 * 1024))?.[1] ?? '';
  const product = /^(Creo|Pro\/ENGINEER|Wildfire)\s+(?:TM\s+)?(?:Parametric\s+)?([\d.]+)/.exec(banner.replace(/\s+/g, ' '));
  const build = /\s([A-Z]\d{3})\s*$/.exec(banner)?.[1] ?? '';
  // "CMNM 00apiston.prt": the name with its length as three hex digits in front.
  const name = /#- CMNM ([0-9a-f]{3})(\S+)/.exec(text.slice(0, 16 * 1024));
  const picture = thumbnail(data, text);
  return {
    kind: KINDS[type] ?? 'Creo model',
    images: picture ? [picture] : [],
    limits: 'This is the preview picture Creo saved in the file. The 3D model cannot be shown: Creo files are a closed format. Export the model as STEP in Creo to view it here in 3D.',
    sections: [
      section('Model', [
        row('Model name', name ? name[2].slice(0, parseInt(name[1], 16) || undefined) : ''),
        row('Saved with', product ? `${product[1]} ${product[2]}${build ? ` (${build})` : ''}` : banner.split('(c)')[0].trim()),
      ]),
    ].filter((s): s is MetaSection => !!s),
    lists: [],
  };
}
