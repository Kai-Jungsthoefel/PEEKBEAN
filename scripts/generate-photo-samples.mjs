// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the photo samples: images/camera.dng, a small camera raw file (DNG 1.4: a Bayer mosaic of the sample motif
// with linearization table, white balance and color matrix, and the motif JPEG as full-size preview), and
// images/motif.jxl, the motif as lossless JPEG XL with transparency (encoded with libjxl from @jsquash/jxl). Everything is
// drawn from scratch or derived from images/motif.jpg, so the output can be published as CC0-1.0.
// Usage: node scripts/generate-photo-samples.mjs [file ...] (after npm install). With file names (relative to
// samples/), only those are written.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', 'samples');
const written = [];
const only = process.argv.slice(2).map((rel) => rel.replace(/\\/g, '/').replace(/^samples\//, ''));

function write(rel, data) {
  if (only.length && !only.includes(rel)) return;
  const file = path.join(ROOT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  written.push([rel, Buffer.byteLength(data)]);
}

/** The motif of the other image samples: warm gradient, a white disk with a dark ring, a translucent stripe left. */
function motif(x, y, w, h) {
  const dx = x - w * 0.62;
  const dy = y - h * 0.5;
  const inCircle = dx * dx + dy * dy < (h * 0.3) ** 2;
  const ring = Math.abs(Math.sqrt(dx * dx + dy * dy) - h * 0.3) < h * 0.02;
  if (ring) return [27, 30, 35, 255];
  if (inCircle) return [255, 255, 255, 255];
  const alpha = x < w * 0.08 ? 90 : 255;
  return [242, Math.round(90 + 110 * (x / w)), Math.round(40 + 160 * (y / h)), alpha];
}

// ---- DNG ----------------------------------------------------------------------------------------------------

const [BYTE, ASCII, SHORT, LONG, RATIONAL, UNDEFINED, SRATIONAL] = [1, 2, 3, 4, 5, 7, 10];

/**
 * One big-endian TIFF directory at `offset`: entries [tag, type, values], sorted by tag. Values that do not fit into
 * the entry follow the directory. Returns the bytes; `next` is the offset of the following directory (0 = none).
 */
function ifd(entries, offset, next = 0) {
  entries = [...entries].sort((a, b) => a[0] - b[0]);
  const head = Buffer.alloc(2 + entries.length * 12 + 4);
  head.writeUInt16BE(entries.length);
  const data = [];
  let dataOffset = offset + head.length;
  entries.forEach(([tag, type, value], i) => {
    let bytes;
    if (type === ASCII) bytes = Buffer.from(`${value}\0`, 'latin1');
    else if (type === BYTE || type === UNDEFINED) bytes = Buffer.from(value);
    else if (type === SHORT) {
      bytes = Buffer.alloc(value.length * 2);
      value.forEach((v, k) => bytes.writeUInt16BE(v, k * 2));
    } else if (type === LONG) {
      bytes = Buffer.alloc(value.length * 4);
      value.forEach((v, k) => bytes.writeUInt32BE(v, k * 4));
    } else {
      bytes = Buffer.alloc(value.length * 8);
      value.forEach(([n, d], k) => {
        if (type === SRATIONAL) bytes.writeInt32BE(n, k * 8);
        else bytes.writeUInt32BE(n, k * 8);
        bytes.writeUInt32BE(d, k * 8 + 4);
      });
    }
    const at = 2 + i * 12;
    head.writeUInt16BE(tag, at);
    head.writeUInt16BE(type, at + 2);
    head.writeUInt32BE(type === ASCII || type === BYTE || type === UNDEFINED ? bytes.length : value.length, at + 4);
    if (bytes.length <= 4) bytes.copy(head, at + 8);
    else {
      head.writeUInt32BE(dataOffset, at + 8);
      const padded = bytes.length & 1 ? Buffer.concat([bytes, Buffer.alloc(1)]) : bytes;
      data.push(padded);
      dataOffset += padded.length;
    }
  });
  head.writeUInt32BE(next, 2 + entries.length * 12);
  return Buffer.concat([head, ...data]);
}

/** Fixed-point rational with denominator 10000. */
const ratio = (v) => [Math.round(v * 10000), 10000];

/**
 * A DNG as phones write them: IFD0 is the full-size JPEG preview (YCbCr, one strip), a sub-IFD holds the raw data.
 * The "sensor" sees linear sRGB scaled by the white balance below, so the color matrix is the XYZ → linear sRGB one.
 */
function cameraDng() {
  const jpeg = readFileSync(path.join(ROOT, 'images', 'motif.jpg'));
  const width = 320;
  const height = 200;
  const neutral = [0.52, 1, 0.71];
  // 8-bit codes with a gamma of 2.2, expanded to 16-bit linear values by the linearization table.
  const table = Array.from({ length: 256 }, (_, k) => Math.round(65535 * (k / 255) ** 2.2));
  const linear = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  const cfa = Buffer.alloc(width * height);
  const pattern = [0, 1, 1, 2]; // RGGB
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const color = pattern[(y % 2) * 2 + (x % 2)];
      const value = linear(motif(x, y, width, height)[color] / 255) * neutral[color] * 0.9;
      cfa[y * width + x] = Math.round(255 * value ** (1 / 2.2));
    }
  }
  // XYZ (D65) → linear sRGB.
  const colorMatrix = [3.2406, -1.5372, -0.4986, -0.9689, 1.8758, 0.0415, 0.0557, -0.204, 1.057];
  const date = '2026:05:01 14:30:00';

  const header = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]);
  const ifd0Entries = (rawAt, exifAt, jpegAt) => [
    [254, LONG, [1]],
    [256, LONG, [width]],
    [257, LONG, [height]],
    [258, SHORT, [8, 8, 8]],
    [259, SHORT, [7]],
    [262, SHORT, [6]],
    [271, ASCII, 'Example'],
    [272, ASCII, 'Sample Camera'],
    [273, LONG, [jpegAt]],
    [274, SHORT, [1]],
    [277, SHORT, [3]],
    [278, LONG, [height]],
    [279, LONG, [jpeg.length]],
    [284, SHORT, [1]],
    [305, ASCII, 'generate-photo-samples.mjs'],
    [306, ASCII, date],
    [330, LONG, [rawAt]],
    [33432, ASCII, 'CC0-1.0'],
    [34665, LONG, [exifAt]],
    [50706, BYTE, [1, 4, 0, 0]],
    [50707, BYTE, [1, 1, 0, 0]],
    [50708, ASCII, 'Example Sample Camera'],
    [50721, SRATIONAL, colorMatrix.map(ratio)],
    [50728, RATIONAL, neutral.map(ratio)],
    [50778, SHORT, [21]],
    [50970, LONG, [2]],
  ];
  const exifEntries = [
    [33434, RATIONAL, [[1, 125]]],
    [33437, RATIONAL, [[40, 10]]],
    [34855, SHORT, [200]],
    [36864, UNDEFINED, [...Buffer.from('0231')]],
    [36867, ASCII, date],
    [36881, ASCII, '+02:00'],
    [37386, RATIONAL, [[350, 10]]],
    [40962, LONG, [width]],
    [40963, LONG, [height]],
    [42036, ASCII, 'Sample lens 35 mm'],
  ];
  const rawEntries = (cfaAt) => [
    [254, LONG, [0]],
    [256, LONG, [width]],
    [257, LONG, [height]],
    [258, SHORT, [8]],
    [259, SHORT, [1]],
    [262, SHORT, [32803]],
    [273, LONG, [cfaAt]],
    [277, SHORT, [1]],
    [278, LONG, [height]],
    [279, LONG, [cfa.length]],
    [284, SHORT, [1]],
    [33421, SHORT, [2, 2]],
    [33422, BYTE, pattern],
    [50710, BYTE, [0, 1, 2]],
    [50711, SHORT, [1]],
    [50712, SHORT, table],
    [50714, LONG, [0]],
    [50717, LONG, [65535]],
  ];
  // Directory sizes do not depend on the offsets in them, so lay out once with zeros, then for real.
  const layout = (rawAt, exifAt, jpegAt, cfaAt) => {
    const ifd0 = ifd(ifd0Entries(rawAt, exifAt, jpegAt), 8);
    const exif = ifd(exifEntries, 8 + ifd0.length);
    const raw = ifd(rawEntries(cfaAt), 8 + ifd0.length + exif.length);
    return { ifd0, exif, raw };
  };
  const sizes = layout(0, 0, 0, 0);
  const exifAt = 8 + sizes.ifd0.length;
  const rawAt = exifAt + sizes.exif.length;
  const jpegAt = rawAt + sizes.raw.length;
  const cfaAt = jpegAt + jpeg.length + (jpeg.length & 1);
  const { ifd0, exif, raw } = layout(rawAt, exifAt, jpegAt, cfaAt);
  return Buffer.concat([header, ifd0, exif, raw, jpeg, Buffer.alloc(jpeg.length & 1), cfa]);
}

// ---- JPEG XL ------------------------------------------------------------------------------------------------

async function motifJxl() {
  const dir = path.resolve(import.meta.dirname, '..', 'node_modules', '@jsquash', 'jxl');
  const { default: encode, init } = await import(pathToFileURL(path.join(dir, 'encode.js')).href);
  // Node has no fetch for file URLs, so the single-threaded encoder gets its WebAssembly module handed in.
  await init(await WebAssembly.compile(readFileSync(path.join(dir, 'codec', 'enc', 'jxl_enc.wasm'))));
  const width = 640;
  const height = 400;
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(motif(x, y, width, height), (y * width + x) * 4);
  return Buffer.from(await encode({ data: rgba, width, height }, { lossless: true, effort: 7 }));
}

// ---- Generate -----------------------------------------------------------------------------------------------

write('images/camera.dng', cameraDng());
if (!only.length || only.includes('images/motif.jxl')) write('images/motif.jxl', await motifJxl());

for (const [rel, size] of written) console.log(`${rel.padEnd(28)} ${size.toLocaleString('en-US').padStart(9)} bytes`);
