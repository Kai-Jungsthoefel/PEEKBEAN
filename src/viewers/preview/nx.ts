// SPDX-License-Identifier: GPL-3.0-or-later
// Siemens NX parts in the SPLMSSTR container: a directory of named streams after the header and a second one near the
// end of the file (cadmpeg's format notes, CC-BY-4.0). Previews are JPEGs under /Root/images, attributes are XML.
import { formatDate, row, section, type MetaSection } from '../../metadata/model';
import { findPicture, indexOf } from './images';
import type { PreviewImage, PreviewList, PreviewResult } from './types';
import { elements, xmlFrom } from './xml';

interface NxStream {
  path: string;
  offset: number;
  size: number;
}

function directory(data: Uint8Array, view: DataView, at: number, tag: string): NxStream[] {
  if (at + tag.length + 4 > data.length || String.fromCharCode(...data.subarray(at, at + tag.length)) !== tag) return [];
  const streams: NxStream[] = [];
  const count = Math.min(view.getUint32(at + tag.length, true), 100_000);
  let p = at + tag.length + 4;
  for (let i = 0; i < count && p + 4 <= data.length; i++) {
    const length = view.getUint32(p, true);
    if (length > 1024 || p + 4 + length + 16 > data.length) break;
    const path = new TextDecoder('latin1').decode(data.subarray(p + 4, p + 4 + length));
    const offset = Number(view.getBigUint64(p + 4 + length, true));
    const size = Number(view.getBigUint64(p + 12 + length, true));
    if (!path.endsWith('/') && size > 0 && offset + size <= data.length) streams.push({ path, offset, size });
    p += 4 + length + 16;
  }
  return streams;
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function readNx(data: Uint8Array, fileName: string): Promise<PreviewResult> {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const footer = view.getUint32(0x11, true) + view.getUint16(0x15, true) * 2 ** 32;
  const streams = [...directory(data, view, indexOf(data, 'HEADER', 0x10, 0x40), 'HEADER'), ...(footer < data.length ? directory(data, view, footer, 'FOOTER') : [])];
  const read = async (path: string): Promise<Uint8Array | null> => {
    const s = streams.find((x) => x.path === path);
    if (!s) return null;
    const bytes = data.subarray(s.offset, s.offset + s.size);
    // Streams are zlib members unless they already start with their own signature.
    return bytes[0] === 0x78 ? inflate(bytes).catch(() => bytes) : bytes;
  };

  const images: PreviewImage[] = [];
  for (const s of streams.filter((x) => x.path.startsWith('/Root/images/'))) {
    const picture = findPicture((await read(s.path)) ?? new Uint8Array());
    if (!picture) continue;
    const name = s.path.slice(s.path.lastIndexOf('/') + 1);
    images.push({ ...picture, label: name === 'preview' ? 'Preview' : name.replace(/#(\d+)$/, ' $1') });
  }

  const attributes = elements(xmlFrom((await read('/Root/part/attrs')) ?? new Uint8Array()), 'Attribute').map((a) => a.attrs);
  const userAttributes = attributes.filter((a) => a.title && !a.title.startsWith('NX_'));
  const arrangements = elements(xmlFrom((await read('/Root/part/arrangements')) ?? new Uint8Array()), 'Arrangement').map((a) => a.attrs);
  const times = elements(xmlFrom((await read('/Root/qafmetadata')) ?? new Uint8Array()), 'modifyTime')
    .map((t) => new Date(t.inner.trim()))
    .filter((d) => !Number.isNaN(d.getTime()))
    .sort((a, b) => b.getTime() - a.getTime());

  // Assemblies name their components' part files in the external references.
  const references = new Set<string>();
  for (const path of ['/Root/FastLoad/ExternalReferences', '/Root/UG_PART/ExternalReferences']) {
    const bytes = await read(path);
    if (!bytes) continue;
    for (const m of new TextDecoder('latin1').decode(bytes).matchAll(/[\x20-\x7e]{1,260}?\.prt(?![a-z0-9])/gi)) references.add(m[0].replace(/^[^A-Za-z0-9\\/.:_-]+/, ''));
  }
  // A part names itself there too.
  const own = fileName.toLowerCase();
  for (const name of references) if (name.toLowerCase().split(/[\\/]/).pop() === own) references.delete(name);
  const lists: PreviewList[] = references.size ? [{ title: 'Referenced parts', nodes: [...references].map((name) => ({ name })) }] : [];

  return {
    kind: references.size ? 'NX assembly' : 'NX part',
    images,
    limits: 'This is the preview picture NX saved in the file. The 3D model cannot be shown: NX part files are a closed format. Export the part as STEP in NX to view it here in 3D.',
    sections: [
      section('Model', [
        row('Arrangements', arrangements.map((a) => `${a.Name}${a.Default === 'YES' ? ' (default)' : ''}`).join(', ')),
        row('Material', attributes.find((a) => a.title === 'NX_Material' || a.title === 'Material')?.value ?? ''),
        row('Last saved', times[0] ? formatDate(times[0]) : ''),
      ]),
      section(
        'Attributes',
        userAttributes.map((a) => ({ label: a.title, value: a.utf8value ?? a.value ?? '' })).filter((r) => r.value),
      ),
    ].filter((s): s is MetaSection => !!s),
    lists,
  };
}
