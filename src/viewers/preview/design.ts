// SPDX-License-Identifier: GPL-3.0-or-later
// Design files whose content OPSIS cannot draw but which carry a preview: Paint.NET (PNG in the XML header), Affinity
// (PNG record the header points to; PhotoCraft's notes), Figma local copies (thumbnail.png in a ZIP), and EPS files
// with a TIFF or WMF preview in their DOS binary header.
import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader, configure } from '@zip.js/zip.js';
import * as UTIF from 'utif2';
import { formatDate, formatNumber, row, section, type MetaRow, type MetaSection } from '../../metadata/model';
import { findPicture, hasSignature, rgbaToPng } from './images';
import type { PreviewImage, PreviewResult } from './types';
import { attributes, decodeEntities } from './xml';
import { readXmp, xmpSections } from './xmp';

configure({ useWebWorkers: false, useCompressionStream: true });

const sections = (list: (MetaSection | null)[]) => list.filter((s): s is MetaSection => !!s);

function base64(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/=]/g, '');
  const binary = atob(clean);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Paint.NET: "PDN3", a 24-bit header length, an XML header with size, layer count and a base64 PNG thumbnail. */
export async function readPdn(file: File): Promise<PreviewResult> {
  const head = new Uint8Array(await file.slice(0, 7).arrayBuffer());
  const length = head[4] | (head[5] << 8) | (head[6] << 16);
  const xml = new TextDecoder().decode(await file.slice(7, 7 + length).arrayBuffer());
  const image = attributes(/<pdnImage\b[^>]*>/.exec(xml)?.[0] ?? '');
  const thumb = /<thumb\b[^>]*\bpng="([^"]*)"/.exec(xml)?.[1];
  const picture = thumb ? findPicture(base64(thumb)) : null;
  const layers = Number(image.layers);
  return {
    kind: 'Paint.NET image',
    images: picture ? [picture] : [],
    limits: 'This is the small preview picture Paint.NET saved in the file. The layers themselves are not shown yet. Save the image as PNG in Paint.NET for the full picture.',
    sections: sections([
      section('Image', [
        row('Size', image.width && image.height ? `${image.width} × ${image.height} px` : ''),
        row('Layers', layers ? formatNumber(layers, 0) : ''),
        row('Saved with', image.savedWithVersion ? `Paint.NET ${image.savedWithVersion}` : ''),
      ]),
    ]),
    lists: [],
  };
}

const AFFINITY_KINDS: Record<string, string> = { afphoto: 'Affinity Photo document', afdesign: 'Affinity Designer document', afpub: 'Affinity Publisher document', af: 'Affinity document' };

export function isAffinity(head: Uint8Array): boolean {
  return hasSignature(head, [0x00, 0xff, 0x4b, 0x41]);
}

/** Affinity: the header's word at 24 points to a "Thmb" record holding exactly one PNG. */
export async function readAffinity(file: File, extension: string): Promise<PreviewResult> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const view = new DataView(head.buffer);
  const version = view.getUint16(4, true);
  const at = Number(view.getBigUint64(24, true));
  let picture: PreviewImage | null = null;
  if (at > 0 && at + 29 < file.size) {
    const record = new Uint8Array(await file.slice(at, at + 29).arrayBuffer());
    const rv = new DataView(record.buffer);
    const length = rv.getUint32(24, true);
    if (hasSignature(record, 'Thmb', 4) && length > 0 && length < 16 * 1024 * 1024) {
      picture = findPicture(new Uint8Array(await file.slice(at + rv.getUint32(16, true), at + rv.getUint32(16, true) + length).arrayBuffer()));
    }
  }
  return {
    kind: AFFINITY_KINDS[extension] ?? 'Affinity document',
    images: picture ? [picture] : [],
    limits: 'This is the preview picture Affinity saved in the file. The document itself cannot be shown: Affinity files are a closed format. Export it as PDF or PNG in Affinity to view it here.',
    // Container version 8 for Affinity 1 and 2, 12 for the unified Affinity app (2025).
    sections: sections([section('Document', [row('File format', version >= 12 ? `Affinity (unified app), version ${version}` : version ? `Affinity 1 or 2, version ${version}` : '')])]),
    lists: [],
  };
}

const FIGMA_KINDS: Record<string, string> = { 'fig-kiwi': 'Figma design', 'fig-jam.': 'FigJam board', 'fig-deck': 'Figma Slides deck' };

/** Figma local copies: a ZIP with canvas.fig (the design in Figma's binary schema), meta.json and thumbnail.png. */
export async function readFigma(file: File): Promise<PreviewResult> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const limits = 'This is the preview picture Figma saved in the file. The design itself cannot be shown: Figma files are a closed format. Export frames as PDF, SVG or PNG in Figma to view them here.';
  if (!hasSignature(head, 'PK')) {
    const kind = FIGMA_KINDS[String.fromCharCode(...head)] ?? 'Figma file';
    return { kind, images: [], limits: `${limits} Older Figma files like this one carry no preview picture.`, sections: [], lists: [] };
  }
  const zip = new ZipReader(new BlobReader(file));
  try {
    const entries = await zip.getEntries();
    const entry = (name: string) => entries.find((e) => e.filename === name && !e.directory);
    const thumb = entry('thumbnail.png');
    const bytes = thumb && 'getData' in thumb ? await thumb.getData!(new Uint8ArrayWriter()) : null;
    const picture = bytes ? findPicture(bytes) : null;
    const metaEntry = entry('meta.json');
    let meta: Record<string, unknown> = {};
    try {
      meta = metaEntry && 'getData' in metaEntry ? JSON.parse(await metaEntry.getData!(new TextWriter())) : {};
    } catch {
      meta = {};
    }
    const canvas = entry('canvas.fig');
    const canvasHead = canvas && 'getData' in canvas ? (await canvas.getData!(new Uint8ArrayWriter())).subarray(0, 8) : new Uint8Array();
    const exported = typeof meta.exported_at === 'string' ? new Date(meta.exported_at) : null;
    const images = entries.filter((e) => e.filename.startsWith('images/') && !e.directory).length;
    return {
      kind: FIGMA_KINDS[String.fromCharCode(...canvasHead)] ?? 'Figma design',
      images: picture ? [picture] : [],
      limits,
      sections: sections([
        section('Design', [
          row('Name', typeof meta.file_name === 'string' ? meta.file_name : ''),
          row('Saved', exported && !Number.isNaN(exported.getTime()) ? formatDate(exported) : ''),
          row('Embedded images', images ? formatNumber(images, 0) : ''),
        ]),
      ]),
      lists: [],
    };
  } finally {
    await zip.close();
  }
}

const DOS_EPS = [0xc5, 0xd0, 0xd3, 0xc6];

export function isPostScript(head: Uint8Array): boolean {
  return hasSignature(head, DOS_EPS) || hasSignature(head, '%!PS');
}

/** DSC comments of a PostScript program ("%%Title: …"). */
function dscRows(text: string): MetaRow[] {
  const dsc = (name: string) => decodeEntities(new RegExp(`^%%${name}:\\s*(.*)$`, 'm').exec(text)?.[1]?.trim().replace(/^\((.*)\)$/, '$1') ?? '');
  const box = dsc('HiResBoundingBox') || dsc('BoundingBox');
  const numbers = box.split(/\s+/).map(Number);
  const size = numbers.length === 4 && numbers.every(Number.isFinite) ? `${formatNumber(((numbers[2] - numbers[0]) / 72) * 25.4, 1)} × ${formatNumber(((numbers[3] - numbers[1]) / 72) * 25.4, 1)} mm` : '';
  return [
    row('Title', dsc('Title')),
    row('Creator', dsc('Creator')),
    row('For', dsc('For')),
    row('Created', dsc('CreationDate')),
    row('Size', size),
    row('Pages', dsc('Pages').replace(/^\(atend\)$/, '')),
  ].filter((r): r is MetaRow => !!r);
}

/** EPS and PostScript-based Illustrator files: the TIFF or WMF preview of DOS EPS files, or an XMP thumbnail. */
export async function readPostScript(file: File, extension: string): Promise<PreviewResult> {
  const head = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const view = new DataView(head.buffer);
  const images: PreviewImage[] = [];
  let psStart = 0;
  let psEnd = file.size;
  if (hasSignature(head, DOS_EPS)) {
    psStart = view.getUint32(4, true);
    psEnd = psStart + view.getUint32(8, true);
    const [wmfAt, wmfLength, tiffAt, tiffLength] = [view.getUint32(12, true), view.getUint32(16, true), view.getUint32(20, true), view.getUint32(24, true)];
    if (tiffAt && tiffLength) {
      const tiff = await file.slice(tiffAt, tiffAt + tiffLength).arrayBuffer();
      try {
        const ifd = UTIF.decode(tiff).find((d) => d['t256'] !== undefined);
        if (ifd) {
          UTIF.decodeImage(tiff, ifd);
          const rgba = UTIF.toRGBA8(ifd);
          images.push({ label: 'Preview', type: 'image/png', bytes: await rgbaToPng(ifd.width, ifd.height, rgba) });
        }
      } catch {
        // A damaged TIFF preview: the WMF may still work.
      }
    }
    if (!images.length && wmfAt && wmfLength) images.push({ label: 'Preview', type: 'image/wmf', bytes: new Uint8Array(await file.slice(wmfAt, wmfAt + wmfLength).arrayBuffer()) });
  }
  const text = new TextDecoder('latin1').decode(await file.slice(psStart, Math.min(psEnd, psStart + 256 * 1024)).arrayBuffer());
  const xmp = await readXmp(file);
  if (!images.length && xmp?.images.length) images.push(...xmp.images);
  const illustrator = extension === 'ai' || /%%Creator:.*Illustrator/i.test(text);
  return {
    kind: illustrator ? 'Illustrator file' : 'Encapsulated PostScript',
    images,
    limits: illustrator
      ? 'This Illustrator file has no PDF part, so only its preview picture can be shown. Save it in Illustrator with "Create PDF Compatible File" turned on to view it here completely.'
      : 'This is the preview picture the EPS file carries. The PostScript drawing itself is not rendered. Convert the file to PDF to view it here completely.',
    sections: sections([section('Document', dscRows(text)), ...(xmp ? xmpSections(xmp.xml) : [])]),
    lists: [],
  };
}
