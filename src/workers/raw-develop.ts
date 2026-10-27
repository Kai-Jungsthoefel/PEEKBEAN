// SPDX-License-Identifier: GPL-3.0-or-later
// A plain development of DNG raw data for DNG files without a usable preview (often phone DNGs): UTIF2 decodes the
// sensor data, then black and white level, the white balance the camera measured, bilinear demosaicing, the DNG color
// matrix to sRGB, an automatic exposure like dcraw's and the orientation. No noise reduction, lens or tone curves.
import * as UTIF from 'utif2';

type Ifd = UTIF.IFD & { subIFD?: Ifd[]; isLE?: boolean };

/** Numeric values of a tag; rationals arrive from UTIF2 as [numerator, denominator]. */
function tag(ifd: Ifd, id: number): number[] {
  const value = ifd[`t${id}`] as unknown;
  if (!value || typeof value === 'number') return typeof value === 'number' ? [value] : [];
  return Array.from(value as ArrayLike<unknown>, (v) => (Array.isArray(v) ? v[0] / (v[1] || 1) : Number(v)));
}

// Linear sRGB (D65) → XYZ.
const XYZ_RGB = [
  [0.412453, 0.35758, 0.180423],
  [0.212671, 0.71516, 0.072169],
  [0.019334, 0.119193, 0.950227],
];

function invert3(m: number[][]): number[][] {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (!det) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  return [
    [(e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det],
    [(f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det],
    [(d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det],
  ];
}

/**
 * Camera RGB (white balanced) → linear sRGB, from the DNG ColorMatrix (XYZ → camera) like dcraw does: the rows of
 * camera-from-sRGB are scaled so that white stays white, then inverted.
 */
function cameraToSrgb(ifd0: Ifd): number[][] {
  const second = tag(ifd0, 50779)[0] === 21; // CalibrationIlluminant2 D65
  const matrix = tag(ifd0, second ? 50722 : 50721);
  if (matrix.length < 9) return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const camRgb = [0, 1, 2].map((r) => [0, 1, 2].map((c) => matrix[r * 3] * XYZ_RGB[0][c] + matrix[r * 3 + 1] * XYZ_RGB[1][c] + matrix[r * 3 + 2] * XYZ_RGB[2][c]));
  for (const row of camRgb) {
    const sum = row[0] + row[1] + row[2];
    if (sum) for (let c = 0; c < 3; c++) row[c] /= sum;
  }
  return invert3(camRgb);
}

/** Reads the decoded samples: 8 and 16 bit as bytes and words, other depths bit-packed from the most significant bit. */
function sampleReader(data: Uint8Array, bits: number, le: boolean): (i: number) => number {
  if (bits === 8) return (i) => data[i];
  if (bits === 16) return le ? (i) => data[2 * i] | (data[2 * i + 1] << 8) : (i) => (data[2 * i] << 8) | data[2 * i + 1];
  return (i) => {
    const bit = i * bits;
    let value = 0;
    for (let b = 0; b < bits; b++) value = (value << 1) | ((data[(bit + b) >> 3] >> (7 - ((bit + b) & 7))) & 1);
    return value;
  };
}

/** Pixels in display orientation for EXIF orientation 1–8. */
function orient(rgba: Uint8ClampedArray, width: number, height: number, orientation: number) {
  if (orientation <= 1 || orientation > 8) return { data: rgba, width, height };
  const swap = orientation >= 5;
  const w = swap ? height : width;
  const h = swap ? width : height;
  const out = new Uint8ClampedArray(rgba.length);
  const src = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const dst = new Uint32Array(out.buffer);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Source pixel shown at (x, y).
      let sx: number, sy: number;
      switch (orientation) {
        case 2: [sx, sy] = [width - 1 - x, y]; break;
        case 3: [sx, sy] = [width - 1 - x, height - 1 - y]; break;
        case 4: [sx, sy] = [x, height - 1 - y]; break;
        case 5: [sx, sy] = [y, x]; break;
        case 6: [sx, sy] = [y, height - 1 - x]; break;
        case 7: [sx, sy] = [width - 1 - y, height - 1 - x]; break;
        default: [sx, sy] = [width - 1 - y, x]; break;
      }
      dst[y * w + x] = src[sy * width + sx];
    }
  }
  return { data: out, width: w, height: h };
}

export function developRaw(buffer: ArrayBuffer): { width: number; height: number; data: Uint8ClampedArray } {
  const ifds = (UTIF.decode as (b: ArrayBuffer, options: object) => Ifd[])(buffer, { parseMN: false, debug: false });
  const all: Ifd[] = [];
  const walk = (list: Ifd[] | undefined) => list?.forEach((ifd) => (all.push(ifd), walk(ifd.subIFD)));
  walk(ifds);
  const ifd0 = ifds[0];
  const raw = all
    .filter((ifd) => (tag(ifd, 254)[0] ?? 0) === 0 && [32803, 34892].includes(tag(ifd, 262)[0]))
    .sort((a, b) => tag(b, 256)[0] * tag(b, 257)[0] - tag(a, 256)[0] * tag(a, 257)[0])[0];
  if (!ifd0 || !raw) throw new Error('This raw file contains no preview image.');
  const cfa = tag(raw, 262)[0] === 32803;
  (UTIF.decodeImage as (b: ArrayBuffer, ifd: Ifd, ifds: Ifd[]) => void)(buffer, raw, ifds);
  const { width, height } = raw;
  const bits = tag(raw, 258)[0] ?? 16;
  const channels = cfa ? 1 : (tag(raw, 277)[0] ?? 3);
  if (!raw.data?.length || (!cfa && channels < 3)) throw new Error('The raw data of this DNG file cannot be decoded.');
  const read = sampleReader(raw.data, bits, raw.isLE ?? true);
  const table = tag(raw, 50712);
  const white = tag(raw, 50717)[0] ?? 2 ** bits - 1;
  const [blackRows, blackCols] = tag(raw, 50713).length === 2 ? tag(raw, 50713) : [1, 1];
  const blackLevels = tag(raw, 50714);
  const [top, left, bottom, right] = tag(raw, 50829).length === 4 ? tag(raw, 50829) : [0, 0, height, width];
  const [cropX, cropY] = tag(raw, 50719).length === 2 ? tag(raw, 50719).map(Math.round) : [0, 0];
  const [cropW, cropH] = tag(raw, 50720).length === 2 ? tag(raw, 50720).map(Math.round) : [right - left, bottom - top];
  const w = Math.max(1, Math.min(cropW, right - left - cropX));
  const h = Math.max(1, Math.min(cropH, bottom - top - cropY));
  const x0 = left + cropX;
  const y0 = top + cropY;

  // Color of each CFA cell (0 red, 1 green, 2 blue), counted from the active area's corner.
  const [rows, cols] = tag(raw, 33421).length === 2 ? tag(raw, 33421) : [2, 2];
  const planes = tag(raw, 50710).length ? tag(raw, 50710) : [0, 1, 2];
  const pattern = tag(raw, 33422).length >= rows * cols ? tag(raw, 33422).map((p) => planes.indexOf(p)) : [0, 1, 1, 2];
  const colorAt = (x: number, y: number) => pattern[((y + cropY) % rows) * cols + ((x + cropX) % cols)];

  // White balance from the neutral the camera measured, normalized so that no channel is darkened.
  const neutral = tag(ifd0, 50728).length === 3 ? tag(ifd0, 50728) : [1, 1, 1];
  const inverse = neutral.map((n) => (n > 0 ? 1 / n : 1));
  const minimum = Math.min(...inverse);
  const balance = inverse.map((m) => m / minimum);
  const matrix = cameraToSrgb(ifd0);

  // Normalized, white-balanced samples of the cropped area, clipped so that blown highlights stay white.
  const values = new Float32Array(w * h * (cfa ? 1 : 3));
  for (let y = 0; y < h; y++) {
    const ry = y0 + y;
    for (let x = 0; x < w; x++) {
      const rx = x0 + x;
      for (let c = 0; c < (cfa ? 1 : 3); c++) {
        let v = read((ry * width + rx) * channels + c);
        if (table.length) v = table[Math.min(v, table.length - 1)];
        const black = blackLevels.length >= blackRows * blackCols * (cfa ? 1 : channels)
          ? blackLevels[(((ry - top) % blackRows) * blackCols + ((rx - left) % blackCols)) * (cfa ? 1 : channels) + (cfa ? 0 : c)] ?? 0
          : (blackLevels[0] ?? 0);
        const color = cfa ? colorAt(x, y) : c;
        values[(y * w + x) * (cfa ? 1 : 3) + c] = Math.min(1, Math.max(0, ((v - black) / (white - black)) * balance[color]));
      }
    }
  }

  // Automatic exposure: the brightest percent of samples may clip (at most four times brighter).
  const histogram = new Uint32Array(4096);
  for (let i = 0; i < values.length; i += 7) histogram[Math.min(4095, (values[i] * 4095) | 0)]++;
  let total = 0;
  for (const n of histogram) total += n;
  let level = 4095;
  for (let seen = 0; level > 0 && seen < total * 0.01; level--) seen += histogram[level];
  const gain = Math.min(4, Math.max(1, 4095 / Math.max(level, 1)));
  const encode = new Uint8Array(4096);
  for (let i = 0; i < 4096; i++) {
    const x = i / 4095;
    encode[i] = Math.round(255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  }

  const out = new Uint8ClampedArray(w * h * 4);
  const m = matrix.flat().map((v) => v * gain * 4095);
  const put = (i: number, r: number, g: number, b: number) => {
    out[i * 4] = encode[Math.min(4095, Math.max(0, (m[0] * r + m[1] * g + m[2] * b) | 0))];
    out[i * 4 + 1] = encode[Math.min(4095, Math.max(0, (m[3] * r + m[4] * g + m[5] * b) | 0))];
    out[i * 4 + 2] = encode[Math.min(4095, Math.max(0, (m[6] * r + m[7] * g + m[8] * b) | 0))];
    out[i * 4 + 3] = 255;
  };
  if (!cfa) {
    for (let i = 0; i < w * h; i++) put(i, values[i * 3], values[i * 3 + 1], values[i * 3 + 2]);
    return orient(out, w, h, tag(ifd0, 274)[0] ?? 1);
  }

  // Bilinear demosaicing: each missing color is the mean of the 3×3 neighbors that have it. Per CFA cell and color,
  // the offsets of those neighbors (just the pixel itself for its own color).
  const offsets = Array.from({ length: rows * cols }, (_, cell) => {
    const cy = Math.floor(cell / cols);
    const cx = cell % cols;
    const own = colorAt(cx, cy);
    return [0, 1, 2].map((c) => {
      if (c === own) return Int32Array.of(0);
      const list: number[] = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (colorAt(cx + dx + cols, cy + dy + rows) === c) list.push(dy * w + dx);
      return Int32Array.from(list);
    });
  });
  const rgb = new Float32Array(3);
  for (let y = 0; y < h; y++) {
    const border = y === 0 || y === h - 1;
    const rowCells = (y % rows) * cols;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (border || x === 0 || x === w - 1) {
        // Edges: only the neighbors inside the image.
        const sum = [0, 0, 0];
        const count = [0, 0, 0];
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const color = colorAt(xx, yy);
            sum[color] += values[yy * w + xx];
            count[color]++;
          }
        }
        const own = colorAt(x, y);
        for (let c = 0; c < 3; c++) rgb[c] = c === own ? values[i] : count[c] ? sum[c] / count[c] : 0;
      } else {
        const cell = offsets[rowCells + (x % cols)];
        for (let c = 0; c < 3; c++) {
          const list = cell[c];
          let sum = 0;
          for (let k = 0; k < list.length; k++) sum += values[i + list[k]];
          rgb[c] = list.length ? sum / list.length : 0;
        }
      }
      put(i, rgb[0], rgb[1], rgb[2]);
    }
  }
  return orient(out, w, h, tag(ifd0, 274)[0] ?? 1);
}
