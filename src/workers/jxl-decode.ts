// SPDX-License-Identifier: GPL-3.0-or-later
// JPEG XL with jxl-oxide (MIT OR Apache-2.0, Rust compiled to WebAssembly) for browsers that do not decode it. It renders
// to PNG, which keeps 16 bits, alpha and color profiles for the browser to show; HDR images (PQ, HLG transfer) are
// unpacked here and tone mapped like EXR and Radiance HDR.
import initJxl, { JxlImage } from 'jxl-oxide-wasm';
import jxlWasm from 'jxl-oxide-wasm/module.wasm?url';
import { toneMap } from './tonemap';

export type JxlResult = { width: number; height: number; data: Uint8ClampedArray; png?: boolean; note?: string };

let ready: Promise<unknown> | null = null;

interface Png {
  width: number;
  height: number;
  depth: number;
  /** PNG color type: 0 gray, 2 RGB, 4 gray + alpha, 6 RGBA. */
  color: number;
  /** cICP chunk: primaries, transfer, matrix, full range. */
  cicp: number[] | null;
  idat: Uint8Array[];
}

function readPng(png: Uint8Array): Png {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const out: Png = { width: 0, height: 0, depth: 8, color: 6, cicp: null, idat: [] };
  for (let pos = 8; pos + 12 <= png.length; ) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const data = png.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      out.width = view.getUint32(pos + 8);
      out.height = view.getUint32(pos + 12);
      out.depth = data[8];
      out.color = data[9];
    } else if (type === 'cICP') out.cicp = Array.from(data);
    else if (type === 'IDAT') out.idat.push(data);
    pos += 12 + length;
  }
  return out;
}

/** Unfiltered samples of a non-interlaced PNG, scaled to 0–1. */
async function pngSamples(png: Png): Promise<{ samples: Float32Array; channels: number }> {
  const channels = [1, 0, 3, 0, 2, 0, 4][png.color] || 3;
  const bytes = png.depth / 8;
  const bpp = channels * bytes;
  const stride = png.width * bpp;
  const stream = new Blob(png.idat as BlobPart[]).stream().pipeThrough(new DecompressionStream('deflate'));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const rows = new Uint8Array(stride * png.height);
  for (let y = 0; y < png.height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = rows.subarray(y * stride, (y + 1) * stride);
    const up = y ? rows.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? row[i - bpp] : 0;
      const b = up ? up[i] : 0;
      const c = up && i >= bpp ? up[i - bpp] : 0;
      let v = src[i];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[i] = v;
    }
  }
  const count = png.width * png.height * channels;
  const samples = new Float32Array(count);
  if (bytes === 2) for (let i = 0; i < count; i++) samples[i] = ((rows[2 * i] << 8) | rows[2 * i + 1]) / 65535;
  else for (let i = 0; i < count; i++) samples[i] = rows[i] / 255;
  return { samples, channels };
}

// HDR signal → linear light with diffuse white at 1 (ITU-R BT.2408: 203 cd/m²).
const pq = (e: number) => {
  const p = Math.max(e, 0) ** (1 / 78.84375);
  return (10000 / 203) * (Math.max(p - 0.8359375, 0) / (18.8515625 - 18.6875 * p)) ** (1 / 0.1593017578125);
};
const hlg = (e: number) => (e <= 0.5 ? (e * e) / 3 : (Math.exp((e - 0.55991073) / 0.17883277) + 0.28466892) / 12);

// Linear BT.2020 and Display P3 → linear BT.709/sRGB primaries.
const TO_709: Record<number, number[]> = {
  9: [1.6605, -0.5876, -0.0728, -0.1246, 1.1329, -0.0083, -0.0182, -0.1006, 1.1187],
  12: [1.2249, -0.2247, 0, -0.042, 1.0419, 0, -0.0197, -0.0786, 1.0979],
};

async function toneMapped(png: Png): Promise<Uint8ClampedArray> {
  const { samples, channels } = await pngSamples(png);
  const [primaries, transfer] = png.cicp!;
  const color = channels >= 3 ? 3 : 1;
  const matrix = color === 3 ? TO_709[primaries] : undefined;
  for (let i = 0; i < samples.length; i += channels) {
    const rgb = [0, 1, 2].slice(0, color).map((c) => samples[i + c]);
    let linear = transfer === 16 ? rgb.map(pq) : rgb.map(hlg);
    if (transfer === 18) {
      // HLG system gamma for a 1000 cd/m² display.
      const y = color === 3 ? 0.2627 * linear[0] + 0.678 * linear[1] + 0.0593 * linear[2] : linear[0];
      linear = linear.map((v) => (1000 / 203) * v * Math.max(y, 1e-6) ** 0.2);
    }
    if (matrix) linear = [0, 1, 2].map((r) => matrix[r * 3] * linear[0] + matrix[r * 3 + 1] * linear[1] + matrix[r * 3 + 2] * linear[2]);
    for (let c = 0; c < color; c++) samples[i + c] = Math.max(0, linear[c]);
  }
  return toneMap(samples, png.width, png.height, channels);
}

export async function decodeJxl(buffer: ArrayBuffer): Promise<JxlResult> {
  ready ??= initJxl({ module_or_path: jxlWasm });
  await ready;
  const image = new JxlImage();
  try {
    image.feedBytes(new Uint8Array(buffer));
    if (!image.tryInit() || !image.width || !image.height) throw new Error('The JPEG XL file is incomplete or damaged.');
    const frames = image.numLoadedKeyframes;
    if (!frames) throw new Error('The JPEG XL file is incomplete or damaged.');
    // Animations show their first frame.
    const encoded = image.render(0).encodeToPng();
    const note = image.animated && frames > 1 ? `First frame of ${frames}` : undefined;
    const png = readPng(encoded);
    const transfer = png.cicp?.[1];
    if (transfer === 16 || transfer === 18) {
      return { width: png.width, height: png.height, data: await toneMapped(png), note: note ? `${note}, HDR tone mapped` : 'HDR, tone mapped' };
    }
    return { width: png.width, height: png.height, data: new Uint8ClampedArray(encoded.buffer, encoded.byteOffset, encoded.byteLength), png: true, note };
  } catch (error) {
    // jxl-oxide reports errors as plain strings.
    throw error instanceof Error ? error : new Error(`The JPEG XL image could not be decoded: ${String(error)}.`);
  } finally {
    image.free();
  }
}
