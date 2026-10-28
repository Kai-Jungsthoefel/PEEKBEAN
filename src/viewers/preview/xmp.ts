// SPDX-License-Identifier: GPL-3.0-or-later
// XMP packets in design files: InDesign and Illustrator put base64 JPEG thumbnails (xmpGImg:image) into them, InDesign
// also page previews, the page count and size, the fonts and the linked files. InDesign documents are opaque
// databases otherwise; the packet is found by scanning the file in chunks.
import { formatDate, formatNumber, row, section, type MetaSection } from '../../metadata/model';
import { findPicture, hasSignature } from './images';
import type { PreviewImage, PreviewList, PreviewResult } from './types';
import { decodeEntities, elements, textOf, type XmlElement } from './xml';

const CHUNK = 8 * 1024 * 1024;
const MAX_PACKET = 32 * 1024 * 1024;

async function latin1(file: File, start: number, end: number): Promise<string> {
  return new TextDecoder('latin1').decode(await file.slice(start, end).arrayBuffer());
}

/** XMP packets of a file, in file order. */
export async function xmpPackets(file: File, max = 12): Promise<string[]> {
  const packets: string[] = [];
  const open = /<x:x[am]pmeta\b/;
  let offset = 0;
  while (offset < file.size && packets.length < max) {
    const text = await latin1(file, offset, Math.min(file.size, offset + CHUNK));
    const found = open.exec(text);
    if (!found) {
      if (offset + CHUNK >= file.size) break;
      offset += CHUNK - 32;
      continue;
    }
    const start = offset + found.index;
    let end = -1;
    for (let at = start; at < file.size && at - start < MAX_PACKET && end < 0; at += CHUNK - 32) {
      const piece = await latin1(file, at, Math.min(file.size, at + CHUNK));
      const close = /<\/x:x[am]pmeta>/.exec(piece);
      if (close) end = at + close.index + close[0].length;
    }
    if (end < 0) break;
    packets.push(new TextDecoder().decode(await file.slice(start, end).arrayBuffer()));
    offset = end;
  }
  return packets;
}

/** An element with its attributes as a small document of its own, for value(). */
function wrap(element: XmlElement): string {
  const attrs = Object.entries(element.attrs).map(([k, v]) => ` ${k}="${v.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
  return `<x${attrs}>${element.inner}</x>`;
}

/** A property as element (<ns:Name>…</ns:Name>, language alternatives included) or as attribute (ns:Name="…"). */
function value(xml: string, name: string): string {
  const element = textOf(xml, name);
  if (element) return element;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attribute = new RegExp(`\\s${escaped}\\s*=\\s*"([^"]*)"`).exec(xml);
  return attribute ? decodeEntities(attribute[1]).trim() : '';
}

function thumbnails(xml: string, label: (index: number, item: string) => string): PreviewImage[] {
  const images: PreviewImage[] = [];
  elements(xml, 'li').forEach((item, i) => {
    const data = value(wrap(item), 'xmpGImg:image');
    if (!data) return;
    try {
      const bytes = Uint8Array.from(atob(data.replace(/[^A-Za-z0-9+/=]/g, '')), (c) => c.charCodeAt(0));
      const picture = findPicture(bytes);
      if (picture) images.push({ ...picture, label: label(i, wrap(item)) });
    } catch {
      // Not base64: skip the item.
    }
  });
  return images;
}

/** Previews in a packet: the document thumbnail, then InDesign's page previews. */
function packetImages(xml: string): PreviewImage[] {
  const main = elements(xml, 'xmp:Thumbnails').flatMap((t) => thumbnails(t.inner, () => 'Preview'));
  const pages = elements(xml, 'xmp:PageInfo').flatMap((p) =>
    thumbnails(p.inner, (i, item) => {
      const number = value(item, 'xmpTPg:PageNumber');
      return `Page ${number || i + 1}`;
    }),
  );
  return [...main, ...pages];
}

export async function readXmp(file: File): Promise<{ xml: string; images: PreviewImage[] } | null> {
  const packets = await xmpPackets(file);
  // The document's own packet carries the thumbnails; placed images bring packets of their own.
  const own = packets.find((p) => /xmpGImg:image/.test(p)) ?? packets.find((p) => /xmpTPg:NPages|CreatorTool/.test(p)) ?? packets[0];
  return own ? { xml: own, images: packetImages(own) } : null;
}

export function xmpSections(xml: string): MetaSection[] {
  const date = (text: string) => {
    const d = new Date(text);
    return text && !Number.isNaN(d.getTime()) ? formatDate(d) : '';
  };
  const size = elements(xml, 'xmpTPg:MaxPageSize')[0];
  const dimension = (name: string) => (size ? value(wrap(size), name) : '');
  const [w, h] = [Number(dimension('stDim:w')), Number(dimension('stDim:h'))];
  const sizeText = w > 0 && h > 0 ? `${formatNumber(w, 2)} × ${formatNumber(h, 2)} ${dimension('stDim:unit')}`.trim() : '';
  const pages = Number(value(xml, 'xmpTPg:NPages'));
  return [
    section('Document', [
      row('Title', value(xml, 'dc:title')),
      row('Creator', elements(xml, 'dc:creator').map((c) => textOf(`<x>${c.inner}</x>`, 'x')).join(', ')),
      row('Application', value(xml, 'xmp:CreatorTool')),
      row('Created', date(value(xml, 'xmp:CreateDate'))),
      row('Modified', date(value(xml, 'xmp:ModifyDate'))),
      row('Pages', pages ? formatNumber(pages, 0) : ''),
      row('Largest page', sizeText),
    ]),
  ].filter((s): s is MetaSection => !!s);
}

export function xmpLists(xml: string): PreviewList[] {
  const lists: PreviewList[] = [];
  const fonts = elements(xml, 'xmpTPg:Fonts').flatMap((f) =>
    elements(f.inner, 'li').map((li) => {
      const item = wrap(li);
      return { name: value(item, 'stFnt:fontName') || value(item, 'stFnt:fontFamily'), detail: [value(item, 'stFnt:fontType'), value(item, 'stFnt:fontFileName')].filter(Boolean).join(' · ') };
    }),
  );
  if (fonts.length) lists.push({ title: 'Fonts', nodes: fonts.filter((f) => f.name) });
  const linked = new Set<string>();
  for (const block of [...elements(xml, 'xmpMM:Manifest'), ...elements(xml, 'xmpMM:Ingredients')]) {
    for (const m of block.inner.matchAll(/stRef:filePath(?:="([^"]*)"|>([^<]*)<)/g)) linked.add(decodeEntities(m[1] ?? m[2] ?? '').trim());
  }
  linked.delete('');
  if (linked.size) {
    lists.push({
      title: 'Linked files',
      nodes: [...linked].map((path) => {
        // file:///C:/Links/a%20b.jpg → C:/Links/a b.jpg; file:///Users/… keeps its leading slash.
        let clean = path.replace(/^file:(\/\/(localhost)?)?/, '').replace(/^\/([A-Za-z]:)/, '$1');
        try {
          clean = decodeURIComponent(clean);
        } catch {
          // Not percent-encoded after all.
        }
        const slash = Math.max(clean.lastIndexOf('/'), clean.lastIndexOf('\\'));
        return slash < 0 ? { name: clean } : { name: clean.slice(slash + 1), detail: clean.slice(0, slash) };
      }),
    });
  }
  return lists;
}

const INDESIGN = [0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d];

export function isInDesign(head: Uint8Array): boolean {
  return hasSignature(head, INDESIGN);
}

export async function readInDesign(file: File, extension: string): Promise<PreviewResult> {
  const xmp = await readXmp(file);
  return {
    kind: extension === 'indt' ? 'InDesign template' : 'InDesign document',
    images: xmp?.images ?? [],
    limits:
      'These are the preview pictures InDesign saved in the file (only when "Always Save Preview Images with Documents" is on). The layout itself cannot be shown: InDesign files are a closed format. Export it as PDF in InDesign to view it here.',
    sections: xmp ? xmpSections(xmp.xml) : [],
    lists: xmp ? xmpLists(xmp.xml) : [],
  };
}
