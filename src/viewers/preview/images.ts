// SPDX-License-Identifier: GPL-3.0-or-later
// Pictures embedded in design files: PNG and JPEG cut out of larger data, Windows DIBs turned into BMP files that
// browsers decode, raw RGBA thumbnails encoded as PNG.
import type { PreviewImage } from './types';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

export function indexOf(bytes: Uint8Array, pattern: ArrayLike<number> | string, from = 0, to = bytes.length): number {
  const needle = typeof pattern === 'string' ? Array.from(pattern, (c) => c.charCodeAt(0)) : Array.from(pattern);
  const first = needle[0];
  const last = Math.min(to, bytes.length) - needle.length;
  outer: for (let i = bytes.indexOf(first, from); i >= 0 && i <= last; i = bytes.indexOf(first, i + 1)) {
    for (let j = 1; j < needle.length; j++) if (bytes[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

export function hasSignature(bytes: Uint8Array, signature: ArrayLike<number> | string, at = 0): boolean {
  return indexOf(bytes, signature, at, at + (typeof signature === 'string' ? signature.length : signature.length)) === at;
}

/** A complete PNG at `start`, walking its chunks up to IEND; null if the chunk chain breaks. */
function pngAt(bytes: Uint8Array, start: number): Uint8Array | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let p = start + 8;
  while (p + 12 <= bytes.length) {
    const length = view.getUint32(p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return null;
    p += 12 + length;
    if (type === 'IEND') return p <= bytes.length ? bytes.subarray(start, p) : null;
  }
  return null;
}

/** A complete JPEG at `start`: header segments by their lengths, then the entropy-coded data up to the EOI marker. */
function jpegAt(bytes: Uint8Array, start: number): Uint8Array | null {
  let p = start + 2;
  while (p + 2 <= bytes.length) {
    if (bytes[p] !== 0xff) return null;
    const marker = bytes[p + 1];
    if (marker === 0xff) {
      p++;
      continue;
    }
    if (marker === 0xd9) return bytes.subarray(start, p + 2);
    if (marker >= 0xd0 && marker <= 0xd7) {
      p += 2;
      continue;
    }
    if (p + 4 > bytes.length) return null;
    const length = (bytes[p + 2] << 8) | bytes[p + 3];
    p += 2 + length;
    if (marker === 0xda) {
      // Scan data: a 0xFF is followed by 00 (stuffing) or a restart marker until the next real marker.
      for (; p + 1 < bytes.length; p++) {
        if (bytes[p] !== 0xff) continue;
        const next = bytes[p + 1];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) continue;
        break;
      }
    }
  }
  return null;
}

/** The first complete PNG or JPEG inside the data. */
export function findPicture(bytes: Uint8Array, from = 0, to = bytes.length): PreviewImage | null {
  for (let i = indexOf(bytes, PNG_SIGNATURE, from, to); i >= 0; i = indexOf(bytes, PNG_SIGNATURE, i + 1, to)) {
    const png = pngAt(bytes, i);
    if (png) return { label: 'Preview', type: 'image/png', bytes: png };
  }
  for (let i = indexOf(bytes, JPEG_SIGNATURE, from, to); i >= 0; i = indexOf(bytes, JPEG_SIGNATURE, i + 1, to)) {
    const jpeg = jpegAt(bytes, i);
    if (jpeg && jpeg.length > 200) return { label: 'Preview', type: 'image/jpeg', bytes: jpeg };
  }
  return null;
}

/** A device-independent bitmap (BITMAPINFOHEADER and pixels) with a BMP file header in front; null if implausible. */
export function dibToBmp(dib: Uint8Array): PreviewImage | null {
  if (dib.length < 16) return null;
  const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const headerSize = view.getUint32(0, true);
  if (![12, 40, 52, 56, 64, 108, 124].includes(headerSize) || headerSize > dib.length) return null;
  const core = headerSize === 12;
  const width = core ? view.getUint16(4, true) : view.getInt32(4, true);
  const height = Math.abs(core ? view.getInt16(6, true) : view.getInt32(8, true));
  const bits = view.getUint16(core ? 10 : 14, true);
  if (width <= 0 || width > 20000 || height <= 0 || height > 20000 || ![1, 4, 8, 16, 24, 32].includes(bits)) return null;
  const compression = core ? 0 : view.getUint32(16, true);
  const used = core ? 0 : view.getUint32(32, true);
  const palette = bits <= 8 ? (used || 1 << bits) * (core ? 3 : 4) : 0;
  // BI_BITFIELDS with the plain 40-byte header keeps its three masks after the header.
  const masks = headerSize === 40 && (compression === 3 || compression === 6) ? (compression === 3 ? 12 : 16) : 0;
  const bmp = new Uint8Array(14 + dib.length);
  const out = new DataView(bmp.buffer);
  bmp[0] = 0x42;
  bmp[1] = 0x4d;
  out.setUint32(2, bmp.length, true);
  out.setUint32(10, 14 + headerSize + masks + palette, true);
  bmp.set(dib, 14);
  return { label: 'Preview', type: 'image/bmp', bytes: bmp };
}

/**
 * A clipboard picture (VT_CF property): applications store PNG, a DIB, or a metafile in it. Windows data starts with
 * the clipboard format number (3 metafile, 8 DIB, 14 enhanced metafile), some writers leave it out.
 */
export function clipboardPicture(data: Uint8Array): PreviewImage | null {
  const picture = findPicture(data);
  if (picture) return picture;
  const direct = dibToBmp(data);
  if (direct) return direct;
  if (data.length < 12) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  switch (view.getUint32(0, true)) {
    case 8:
      return dibToBmp(data.subarray(4));
    case 3: // METAFILEPICT: mapping mode, extents and a handle, then the metafile records
      return { label: 'Preview', type: 'image/wmf', bytes: data.subarray(12) };
    case 14:
      return { label: 'Preview', type: 'image/emf', bytes: data.subarray(4) };
    default:
      return null;
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function deflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** RGBA pixels as a PNG file; `bottomUp` rows (OpenGL and BMP order) are flipped. Works in workers, no canvas needed. */
export async function rgbaToPng(width: number, height: number, rgba: Uint8Array, bottomUp = false): Promise<Uint8Array> {
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const source = bottomUp ? height - 1 - y : y;
    raw.set(rgba.subarray(source * stride, source * stride + stride), y * (stride + 1) + 1);
  }
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [Uint8Array.from(PNG_SIGNATURE), chunk('IHDR', header), chunk('IDAT', await deflate(raw)), chunk('IEND', new Uint8Array(0))];
  const png = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

/** Pixel size of a PNG or JPEG, for choosing the largest of several previews. */
export function pictureArea(image: PreviewImage): number {
  const b = image.bytes;
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (image.type === 'image/png' && b.length > 24) return view.getUint32(16) * view.getUint32(20);
  if (image.type === 'image/bmp' && b.length > 26) return Math.abs(view.getInt32(18, true) * view.getInt32(22, true));
  if (image.type === 'image/jpeg') {
    for (let p = 2; p + 9 < b.length; ) {
      const marker = b[p + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return view.getUint16(p + 5) * view.getUint16(p + 7);
      p += 2 + view.getUint16(p + 2);
    }
  }
  return b.length;
}
