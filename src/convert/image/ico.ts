// SPDX-License-Identifier: GPL-3.0-or-later
// Windows icons: reading every picture of an ICO or CUR file and writing ICO files with PNG pictures, which Windows
// reads since Vista and browsers read as favicons.

export interface IconPicture {
  width: number;
  height: number;
  /** Bits per pixel the file states; 0 when it leaves that to the picture. */
  bits: number;
  /** The picture alone: a PNG, or an icon file with only this picture, which the browser decodes. */
  blob: Blob;
}

const ICO = [0, 0, 1, 0];
const CUR = [0, 0, 2, 0];

export function isIcon(bytes: Uint8Array): boolean {
  return [ICO, CUR].some((signature) => signature.every((b, i) => bytes[i] === b));
}

/** The pictures of an ICO or CUR file in the order of its directory; entries pointing outside the file are skipped. */
export function readIcon(bytes: Uint8Array): IconPicture[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint16(4, true);
  const pictures: IconPicture[] = [];
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    if (entry + 16 > bytes.length) break;
    const size = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    if (size === 0 || offset + size > bytes.length) continue;
    const data = bytes.subarray(offset, offset + size);
    const png = data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47;
    // A BMP picture states its bit count at byte 14 of its header.
    const bits = png ? 0 : new DataView(data.buffer, data.byteOffset, data.byteLength).getUint16(14, true);
    let blob = new Blob([data as Uint8Array<ArrayBuffer>], { type: 'image/png' });
    if (!png) {
      // In a CUR file planes and bit count hold the hotspot; as an icon they are 1 and the picture's bit count.
      const own = bytes.slice(entry, entry + 16);
      const fields = new DataView(own.buffer);
      fields.setUint16(4, 1, true);
      fields.setUint16(6, bits, true);
      blob = new Blob([iconFile([{ entry: own, data }])], { type: 'image/x-icon' });
    }
    pictures.push({ width: bytes[entry] || 256, height: bytes[entry + 1] || 256, bits, blob });
  }
  return pictures;
}

/** An ICO file of PNG pictures, each square with its side in pixels. */
export function writeIcon(pictures: { size: number; png: Uint8Array }[]): Uint8Array {
  return iconFile(
    pictures.map(({ size, png }) => {
      const entry = new Uint8Array(16);
      const view = new DataView(entry.buffer);
      // 0 stands for 256.
      entry[0] = entry[1] = size >= 256 ? 0 : size;
      view.setUint16(4, 1, true);
      view.setUint16(6, 32, true);
      return { entry, data: png };
    }),
  );
}

/** Header, directory and pictures; size and offset in each directory entry are filled in here. */
function iconFile(pictures: { entry: Uint8Array; data: Uint8Array }[]): Uint8Array<ArrayBuffer> {
  const total = 6 + pictures.length * 16 + pictures.reduce((sum, p) => sum + p.data.length, 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint16(2, 1, true);
  view.setUint16(4, pictures.length, true);
  let offset = 6 + pictures.length * 16;
  pictures.forEach(({ entry, data }, i) => {
    const at = 6 + i * 16;
    out.set(entry, at);
    view.setUint32(at + 8, data.length, true);
    view.setUint32(at + 12, offset, true);
    out.set(data, offset);
    offset += data.length;
  });
  return out;
}
