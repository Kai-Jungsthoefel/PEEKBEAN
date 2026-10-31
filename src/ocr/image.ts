// SPDX-License-Identifier: GPL-3.0-or-later
// Small image helpers on plain RGBA buffers, so the pipeline runs the same in a worker and in Node.

export interface Img {
  width: number;
  height: number;
  /** RGBA, row by row */
  data: Uint8ClampedArray;
}

/** A rotated rectangle: center, size and angle in radians; w runs along the text direction. */
export interface RotRect {
  cx: number;
  cy: number;
  w: number;
  h: number;
  angle: number;
}

export interface Box { x0: number; y0: number; x1: number; y1: number }

export function newImg(width: number, height: number, fill = 255): Img {
  const data = new Uint8ClampedArray(width * height * 4).fill(fill);
  return { width, height, data };
}

/** Bilinear sample of one channel; outside the image counts as white. */
function sample(img: Img, x: number, y: number, c: number): number {
  const { width: w, height: h, data } = img;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const at = (xx: number, yy: number) =>
    xx < 0 || yy < 0 || xx >= w || yy >= h ? 255 : data[(yy * w + xx) * 4 + c];
  return (at(x0, y0) * (1 - fx) + at(x0 + 1, y0) * fx) * (1 - fy) + (at(x0, y0 + 1) * (1 - fx) + at(x0 + 1, y0 + 1) * fx) * fy;
}

/** Resize with bilinear sampling; for strong downscaling it averages a box first so thin strokes survive. */
export function resize(img: Img, w: number, h: number): Img {
  let src = img;
  // Halve until the remaining factor is below 2: bilinear alone would skip pixels
  while (src.width >= w * 2 && src.height >= h * 2) src = halve(src);
  const out = newImg(w, h);
  const sx = src.width / w, sy = src.height / h;
  for (let y = 0; y < h; y++) {
    const yy = (y + 0.5) * sy - 0.5;
    for (let x = 0; x < w; x++) {
      const xx = (x + 0.5) * sx - 0.5;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out.data[o + c] = sample(src, Math.max(0, xx), Math.max(0, yy), c);
      out.data[o + 3] = 255;
    }
  }
  return out;
}

function halve(img: Img): Img {
  const w = img.width >> 1, h = img.height >> 1;
  const out = newImg(w, h);
  const s = img.data, sw = img.width;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = ((y * 2) * sw + x * 2) * 4, b = a + sw * 4, o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out.data[o + c] = (s[a + c] + s[a + 4 + c] + s[b + c] + s[b + 4 + c]) >> 2;
    }
  }
  return out;
}

export function crop(img: Img, box: Box): Img {
  const x0 = Math.max(0, Math.floor(box.x0)), y0 = Math.max(0, Math.floor(box.y0));
  const x1 = Math.min(img.width, Math.ceil(box.x1)), y1 = Math.min(img.height, Math.ceil(box.y1));
  const w = Math.max(1, x1 - x0), h = Math.max(1, y1 - y0);
  const out = newImg(w, h);
  for (let y = 0; y < h && y0 + y < img.height; y++) {
    const from = ((y0 + y) * img.width + x0) * 4;
    out.data.set(img.data.subarray(from, from + Math.min(w, img.width - x0) * 4), y * w * 4);
  }
  return out;
}

/** Rotate by 90° steps clockwise. */
export function rotate90(img: Img, turns: number): Img {
  const t = ((turns % 4) + 4) % 4;
  if (t === 0) return img;
  const { width: w, height: h, data } = img;
  const ow = t === 2 ? w : h, oh = t === 2 ? h : w;
  const out = newImg(ow, oh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [nx, ny] = t === 1 ? [h - 1 - y, x] : t === 2 ? [w - 1 - x, h - 1 - y] : [y, w - 1 - x];
      const i = (y * w + x) * 4, o = (ny * ow + nx) * 4;
      out.data[o] = data[i];
      out.data[o + 1] = data[i + 1];
      out.data[o + 2] = data[i + 2];
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Cut a rotated rectangle out of the image, straightened, at the given output height. */
export function warpRect(img: Img, r: RotRect, outH: number, maxW = 3200): Img {
  const outW = Math.max(4, Math.min(maxW, Math.round((outH * r.w) / Math.max(1, r.h))));
  let src = img;
  let scale = 1;
  // Very tall lines (big headings) are reduced first, so bilinear sampling does not skip strokes
  while (r.h / scale >= outH * 2.5 && src.width > 8) {
    src = halve(src);
    scale *= 2;
  }
  const out = newImg(outW, outH);
  const cos = Math.cos(r.angle), sin = Math.sin(r.angle);
  for (let v = 0; v < outH; v++) {
    const dv = ((v + 0.5) / outH - 0.5) * r.h;
    for (let u = 0; u < outW; u++) {
      const du = ((u + 0.5) / outW - 0.5) * r.w;
      const x = (r.cx + du * cos - dv * sin) / scale - 0.5;
      const y = (r.cy + du * sin + dv * cos) / scale - 0.5;
      const o = (v * outW + u) * 4;
      for (let c = 0; c < 3; c++) out.data[o + c] = sample(src, x, y, c);
    }
  }
  return out;
}

/**
 * HWC RGBA → CHW float tensor data: (value · scale − mean) / std per channel, in BGR order when the Paddle model
 * was trained on OpenCV images.
 */
export function toCHW(img: Img, mean: number[], std: number[], scale: number, bgr: boolean, into?: Float32Array, intoWidth?: number): Float32Array {
  const { width: w, height: h, data } = img;
  const W = intoWidth ?? w;
  const plane = W * h;
  const out = into ?? new Float32Array(3 * plane);
  for (let c = 0; c < 3; c++) {
    const src = bgr ? 2 - c : c;
    const m = mean[c], s = std[c];
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[c * plane + y * W + x] = (data[(y * w + x) * 4 + src] * scale - m) / s;
    }
  }
  return out;
}

export function gray(img: Img): Uint8Array {
  const out = new Uint8Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8;
  return out;
}

export function rectCorners(r: RotRect): [number, number][] {
  const cos = Math.cos(r.angle), sin = Math.sin(r.angle);
  const hw = r.w / 2, hh = r.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => [r.cx + x * cos - y * sin, r.cy + x * sin + y * cos]);
}

export function rectBox(r: RotRect): Box {
  const pts = rectCorners(r);
  return {
    x0: Math.min(...pts.map((p) => p[0])), y0: Math.min(...pts.map((p) => p[1])),
    x1: Math.max(...pts.map((p) => p[0])), y1: Math.max(...pts.map((p) => p[1])),
  };
}

export const area = (b: Box) => Math.max(0, b.x1 - b.x0) * Math.max(0, b.y1 - b.y0);

export function intersect(a: Box, b: Box): number {
  return area({ x0: Math.max(a.x0, b.x0), y0: Math.max(a.y0, b.y0), x1: Math.min(a.x1, b.x1), y1: Math.min(a.y1, b.y1) });
}

export function iou(a: Box, b: Box): number {
  const i = intersect(a, b);
  return i / (area(a) + area(b) - i || 1);
}

/** Rotate around the centre by an angle in radians (clockwise on screen), same size, white corners. */
export function rotate(img: Img, angle: number): Img {
  const { width: w, height: h } = img;
  const out = newImg(w, h);
  const cos = Math.cos(angle), sin = Math.sin(angle), cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // Inverse mapping: where in the source does this output pixel come from
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      const sx = cx + dx * cos + dy * sin - 0.5, sy = cy - dx * sin + dy * cos - 0.5;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) out.data[o + c] = sample(img, sx, sy, c);
    }
  }
  return out;
}

/** Where a point of the original lands after rotate(img, angle). */
export function rotatePoint(x: number, y: number, w: number, h: number, angle: number): [number, number] {
  const cos = Math.cos(angle), sin = Math.sin(angle), dx = x - w / 2, dy = y - h / 2;
  return [w / 2 + dx * cos - dy * sin, h / 2 + dx * sin + dy * cos];
}

/**
 * Fine skew around an estimate: dark pixels are projected onto the y axis for angles ±0.8° around it; the angle
 * with the sharpest profile (lines of text and rules fall into few rows) wins.
 */
export function refineSkew(img: Img, estimate: number): number {
  const s = Math.min(1, 900 / img.width);
  const small = s < 1 ? resize(img, Math.round(img.width * s), Math.round(img.height * s)) : img;
  const g = gray(small);
  const pts: number[] = [];
  for (let y = 0; y < small.height; y += 1) {
    for (let x = 0; x < small.width; x += 2) if (g[y * small.width + x] < 150) pts.push(x - small.width / 2, y - small.height / 2);
  }
  let best = estimate, bestScore = -1;
  const bins = new Float64Array(small.height * 2 + 4);
  for (let d = -0.8; d <= 0.8001; d += 0.05) {
    const a = estimate + (d * Math.PI) / 180;
    const sin = Math.sin(a), cos = Math.cos(a);
    bins.fill(0);
    for (let i = 0; i < pts.length; i += 2) {
      const yy = Math.round(-pts[i] * sin + pts[i + 1] * cos + small.height);
      if (yy >= 0 && yy < bins.length) bins[yy]++;
    }
    let score = 0;
    for (const b of bins) score += b * b;
    if (score > bestScore) { bestScore = score; best = a; }
  }
  return best;
}
