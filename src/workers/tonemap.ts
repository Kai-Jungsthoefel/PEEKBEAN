// SPDX-License-Identifier: GPL-3.0-or-later
// High dynamic range pixels (EXR, Radiance HDR, float KTX2) → displayable sRGB, like a photo viewer would show them.

/** ACES filmic curve (Narkowicz's fit): keeps highlights from clipping hard. */
const aces = (x: number) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
const toSrgb = (x: number) => (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);

/**
 * Linear float pixels with `channels` values each (1 = gray, 2 = gray + alpha, 3 = RGB, 4 = RGBA) → RGBA bytes.
 * `flipY` turns bottom-up rows (as the EXR loader delivers them) the right way round.
 */
export function toneMap(data: ArrayLike<number>, width: number, height: number, channels: number, flipY = false): Uint8ClampedArray {
  const out = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const row = flipY ? height - 1 - y : y;
    for (let x = 0; x < width; x++) {
      const i = (row * width + x) * channels;
      const o = (y * width + x) * 4;
      const r = data[i];
      const g = channels >= 3 ? data[i + 1] : r;
      const b = channels >= 3 ? data[i + 2] : r;
      const a = channels === 4 ? data[i + 3] : channels === 2 ? data[i + 1] : 1;
      out[o] = toSrgb(aces(r)) * 255 + 0.5;
      out[o + 1] = toSrgb(aces(g)) * 255 + 0.5;
      out[o + 2] = toSrgb(aces(b)) * 255 + 0.5;
      out[o + 3] = Math.min(1, Math.max(0, a)) * 255 + 0.5;
    }
  }
  return out;
}
