// SPDX-License-Identifier: GPL-3.0-or-later
// Blender .blend files: a header, then data blocks up to ENDB; gzip-compressed before Blender 3.0, zstd since (fzstd,
// MIT). The TEST block holds the preview Blender draws on saving; ID blocks (objects, meshes, materials …) start with
// their name; an image packed into the file follows its IM block as a DATA block with the original file's bytes.
// Blender 5.0 changed the header ("BLENDER17-01v0500") and uses 64-bit block headers. The file is scanned as a
// stream, so large files never sit in memory whole.
import { Decompress } from 'fzstd';
import { formatBytes } from '../../core/bytes';
import { formatNumber, row, section, type MetaSection } from '../../metadata/model';
import { hasSignature, rgbaToPng } from './images';
import type { PreviewGallery, PreviewImage, PreviewList, PreviewResult } from './types';

/** ID codes worth counting, by block code. */
const COUNTED: Record<string, string> = { OB: 'Objects', ME: 'Meshes', MA: 'Materials', IM: 'Images', GR: 'Collections', CA: 'Cameras', LA: 'Lights', AC: 'Actions', NT: 'Node groups', CU: 'Curves', CV: 'Curves', TX: 'Textures', WO: 'Worlds' };
const LISTED: Record<string, string> = { OB: 'Objects', MA: 'Materials', GR: 'Collections' };
const LIST_LIMIT = 500;
/** Packed images are kept up to this size each, and up to the total over all. */
const PACKED_LIMIT = 64 * 1024 * 1024;
const PACKED_TOTAL = 256 * 1024 * 1024;
/** Images Blender makes itself and never saves. */
const INTERNAL_IMAGES = new Set(['Render Result', 'Viewer Node']);

/** Formats of packed images, with a name for the tile; the image viewer opens all of them. */
const PICTURE_TYPES: [string | number[], string, string][] = [
  [[0x89, 0x50, 0x4e, 0x47], 'image/png', 'PNG'],
  [[0xff, 0xd8, 0xff], 'image/jpeg', 'JPEG'],
  ['GIF8', 'image/gif', 'GIF'],
  ['BM', 'image/bmp', 'BMP'],
  [[0x76, 0x2f, 0x31, 0x01], 'image/x-exr', 'OpenEXR'],
  ['#?RADIANCE', 'image/vnd.radiance', 'Radiance HDR'],
  ['II*\0', 'image/tiff', 'TIFF'],
  ['MM\0*', 'image/tiff', 'TIFF'],
];

export function blendCompression(head: Uint8Array): 'none' | 'gzip' | 'zstd' | null {
  if (head[0] === 0x1f && head[1] === 0x8b) return 'gzip';
  if (head[0] === 0x28 && head[1] === 0xb5 && head[2] === 0x2f && head[3] === 0xfd) return 'zstd';
  return String.fromCharCode(...head.subarray(0, 7)) === 'BLENDER' ? 'none' : null;
}

interface BlendImage {
  name: string;
  /** File path of an external image, as Blender stores it ("//textures/wood.png"). */
  path: string;
  data?: Uint8Array;
  type?: string;
  /** Name of the format for the tile. */
  format?: string;
  size?: number;
}

interface Scan {
  version: string;
  thumbnail: { width: number; height: number; pixels: Uint8Array } | null;
  scenes: { name: string; start: number; end: number }[];
  ids: Map<string, string[]>;
  counts: Map<string, number>;
  libraries: string[];
  images: BlendImage[];
}

/** Streaming block scanner: keeps only the bytes of the block it is looking at. */
class BlockScanner {
  readonly scan: Scan = { version: '', thumbnail: null, scenes: [], ids: new Map(), counts: new Map(), libraries: [], images: [] };
  done = false;
  private buffer: Uint8Array = new Uint8Array(12);
  private filled = 0;
  private need = 12;
  private skip = 0;
  private mode: 'file' | 'block-head' | 'block' = 'file';
  private pointer = 8;
  private littleEndian = true;
  private large = false;
  private block = { code: '', length: 0, count: 1 };
  /** The last ID block seen: data blocks after it belong to it. */
  private owner = '';
  private packed = 0;

  push(chunk: Uint8Array): void {
    let p = 0;
    while (p < chunk.length && !this.done) {
      if (this.skip > 0) {
        const n = Math.min(this.skip, chunk.length - p);
        this.skip -= n;
        p += n;
        continue;
      }
      if (this.buffer.length !== this.need) {
        const next = new Uint8Array(this.need);
        next.set(this.buffer.subarray(0, this.filled));
        this.buffer = next;
      }
      const take = Math.min(this.need - this.filled, chunk.length - p);
      this.buffer.set(chunk.subarray(p, p + take), this.filled);
      this.filled += take;
      p += take;
      if (this.filled < this.need) break;
      const bytes = this.buffer;
      this.buffer = new Uint8Array(0);
      this.filled = 0;
      this.handle(bytes);
    }
  }

  private headSize(): number {
    return this.large ? 32 : 16 + this.pointer;
  }

  private handle(bytes: Uint8Array): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (this.mode === 'file') {
      const text = String.fromCharCode(...bytes);
      if (!text.startsWith('BLENDER')) throw new Error('This is not a Blender file.');
      // Blender 5: "BLENDER" + header size "17" + "-" + format "01" + "v" + version "0500".
      if (/^BLENDER\d\d-/.test(text)) {
        if (bytes.length < 17) {
          this.buffer = bytes;
          this.filled = bytes.length;
          this.need = 17;
          return;
        }
        this.large = true;
        this.pointer = 8;
        const v = text.slice(13, 17);
        this.scan.version = `${Number(v.slice(0, 2))}.${Number(v.slice(2))}`;
      } else {
        this.pointer = text[7] === '-' ? 8 : 4;
        this.littleEndian = text[8] === 'v';
        const v = text.slice(9, 12);
        this.scan.version = `${Number(v[0])}.${Number(v.slice(1))}`;
      }
      this.mode = 'block-head';
      this.need = this.headSize();
      return;
    }
    if (this.mode === 'block-head') {
      const le = this.littleEndian;
      const code = String.fromCharCode(...bytes.subarray(0, 4)).replace(/\0+$/, '');
      const length = this.large ? Number(view.getBigInt64(16, true)) : view.getInt32(4, le);
      const count = this.large ? Number(view.getBigInt64(24, true)) : view.getInt32(12 + this.pointer, le);
      if (code === 'ENDB' || length < 0) {
        this.done = true;
        return;
      }
      if (/^[A-Z]{2}$/.test(code)) this.owner = code;
      this.block = { code, length, count: Math.max(1, count) };
      const keep = this.keep(code, length);
      if (keep > 0) {
        this.mode = 'block';
        this.need = keep;
      } else {
        this.skip = length;
        this.need = this.headSize();
      }
      return;
    }
    this.read(this.block.code, bytes, this.block);
    this.skip = this.block.length - bytes.length;
    this.mode = 'block-head';
    this.need = this.headSize();
  }

  private keep(code: string, length: number): number {
    if (code === 'TEST' || code === 'REND') return Math.min(length, 4 * 1024 * 1024);
    if (code === 'LI' || code === 'IM') return Math.min(length, 4096);
    if (/^[A-Z]{2}$/.test(code)) return Math.min(length, 512);
    // Data of an image: the packed file, if any, is one of these blocks.
    const image = this.scan.images[this.scan.images.length - 1];
    if (code === 'DATA' && this.owner === 'IM' && image && !image.data && length > 16) {
      return length <= PACKED_LIMIT && this.packed + length <= PACKED_TOTAL ? length : 16;
    }
    return 0;
  }

  private read(code: string, bytes: Uint8Array, block: { length: number; count: number }): void {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const le = this.littleEndian;
    if (code === 'TEST' && !this.scan.thumbnail && bytes.length >= 8) {
      const width = view.getInt32(0, le);
      const height = view.getInt32(4, le);
      if (width > 0 && height > 0 && width <= 1024 && height <= 1024 && 8 + width * height * 4 <= bytes.length) {
        this.scan.thumbnail = { width, height, pixels: bytes.slice(8, 8 + width * height * 4) };
      }
      return;
    }
    if (code === 'REND') {
      // One record per scene: start frame, end frame, scene name (64 bytes, longer since Blender 5).
      const size = Math.floor(bytes.length / block.count);
      for (let p = 0; size > 8 && p + size <= bytes.length; p += size) {
        const name = new TextDecoder().decode(bytes.subarray(p + 8, p + size)).replace(/\0[\s\S]*$/, '');
        this.scan.scenes.push({ name, start: view.getInt32(p, le), end: view.getInt32(p + 4, le) });
      }
      return;
    }
    if (code === 'DATA') {
      const image = this.scan.images[this.scan.images.length - 1];
      const type = PICTURE_TYPES.find(([signature]) => hasSignature(bytes, signature));
      if (!image || !type) return;
      image.type = type[1];
      image.format = type[2];
      image.size = block.length;
      // Too large to keep: the tile names the format only.
      if (bytes.length === block.length) {
        image.data = bytes;
        this.packed += bytes.length;
      }
      return;
    }
    this.scan.counts.set(code, (this.scan.counts.get(code) ?? 0) + 1);
    const name = idName(code, bytes);
    if (code === 'LI') {
      // The library's file path follows its ID, relative ("//textures.blend") or absolute.
      const path = /(?:\/\/|[A-Za-z]:[\\/]|\/)[\x20-\x7e]*?\.blend\d*/.exec(new TextDecoder('latin1').decode(bytes))?.[0];
      if (path) this.scan.libraries.push(path);
      return;
    }
    if (code === 'IM' && name) {
      // The file path follows the ID; generated images have none.
      const path = /(?:\/\/|[A-Za-z]:[\\/]|\/)[^\0]*?\.[A-Za-z0-9]{2,5}(?=\0)/.exec(new TextDecoder().decode(bytes.subarray(80)))?.[0] ?? '';
      this.scan.images.push({ name, path });
      return;
    }
    if (!name || !(code in LISTED)) return;
    const list = this.scan.ids.get(code) ?? [];
    if (list.length < LIST_LIMIT) list.push(name);
    this.scan.ids.set(code, list);
  }
}

/** The ID name starts with the two-letter block code ("OBCube") a little after the start of the block. */
function idName(code: string, bytes: Uint8Array): string {
  const a = code.charCodeAt(0);
  const b = code.charCodeAt(1);
  for (let i = 0; i + 3 < Math.min(bytes.length, 200); i++) {
    if (bytes[i] !== a || bytes[i + 1] !== b || bytes[i + 2] < 0x20) continue;
    let end = i + 2;
    while (end < bytes.length && bytes[end] !== 0 && end - i < 260) end++;
    if (bytes[end] !== 0) continue;
    const name = new TextDecoder().decode(bytes.subarray(i + 2, end));
    if (!name.includes('�')) return name;
  }
  return '';
}

async function scanFile(file: File, progress: (fraction: number) => void): Promise<Scan> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  const compression = blendCompression(head);
  if (!compression) throw new Error('This is not a Blender file.');
  const scanner = new BlockScanner();
  const reader = file.stream().getReader();
  const zstd = compression === 'zstd' ? new Decompress((chunk) => scanner.push(chunk)) : null;
  const gunzip = compression === 'gzip' ? new DecompressionStream('gzip') : null;
  const gzipWriter = gunzip?.writable.getWriter();
  const gzipDone = gunzip
    ? (async () => {
        const out = gunzip.readable.getReader();
        for (;;) {
          const { value, done } = await out.read();
          if (done || scanner.done) break;
          scanner.push(value);
        }
      })()
    : null;
  let read = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || scanner.done) break;
      read += value.length;
      progress(read / file.size);
      if (zstd) zstd.push(value, false);
      else if (gzipWriter) await gzipWriter.write(value);
      else scanner.push(value);
    }
    if (zstd && !scanner.done) zstd.push(new Uint8Array(0), true);
  } finally {
    void reader.cancel().catch(() => {});
    if (gzipWriter) await gzipWriter.close().catch(() => {});
  }
  if (gzipDone) await gzipDone.catch(() => {});
  return scanner.scan;
}

function imageGallery(images: BlendImage[]): PreviewGallery | null {
  const items = images
    .filter((image) => !INTERNAL_IMAGES.has(image.name))
    .map((image) => {
      const picture: PreviewImage | undefined = image.data && image.type ? { label: image.name, type: image.type, bytes: image.data } : undefined;
      const detail = image.size !== undefined
        ? `Packed ${image.format ?? 'file'}, ${formatBytes(image.size)}${picture ? '' : ' (too large to show)'}`
        : image.path
          ? `External file: ${image.path}`
          : 'Generated in Blender';
      return { label: image.name, detail, image: picture };
    });
  return items.length ? { title: 'Images', items } : null;
}

export async function readBlender(file: File, progress: (fraction: number) => void): Promise<PreviewResult> {
  const scan = await scanFile(file, progress);
  const images: PreviewImage[] = [];
  if (scan.thumbnail) {
    const { width, height, pixels } = scan.thumbnail;
    // Blender stores the rows bottom-up.
    images.push({ label: 'Preview', type: 'image/png', bytes: await rgbaToPng(width, height, pixels, true) });
  }
  const count = (code: string) => (scan.counts.get(code) ?? 0) + (code === 'CU' ? (scan.counts.get('CV') ?? 0) : 0);
  const lists: PreviewList[] = Object.entries(LISTED)
    .filter(([code]) => scan.ids.get(code)?.length)
    .map(([code, title]) => ({ title, nodes: scan.ids.get(code)!.map((name) => ({ name })), total: count(code) }));
  if (scan.libraries.length) lists.push({ title: 'Linked libraries', nodes: scan.libraries.map((name) => ({ name })) });
  const gallery = imageGallery(scan.images);
  return {
    kind: 'Blender file',
    images,
    limits:
      'This is the preview picture Blender saved in the file, with the images packed into it and the objects and materials it contains. The scene itself is not shown: it needs Blender to evaluate modifiers and node setups. Export it as glTF (.glb) in Blender to view it here in 3D.',
    sections: [
      section('Blender file', [
        row('Saved with', scan.version ? `Blender ${scan.version}` : ''),
        row('Scenes', scan.scenes.map((s) => `${s.name} (frames ${s.start}–${s.end})`).join(', ')),
        ...Object.entries(COUNTED)
          .filter(([code]) => code !== 'CV')
          .map(([code, title]) => row(title, count(code) ? formatNumber(count(code), 0) : '')),
      ]),
    ].filter((s): s is MetaSection => !!s),
    lists,
    galleries: gallery ? [gallery] : [],
  };
}
