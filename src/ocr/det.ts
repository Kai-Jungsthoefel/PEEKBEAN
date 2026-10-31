// SPDX-License-Identifier: GPL-3.0-or-later
// Text line detection with PP-OCRv6 (DB): the model paints a probability map of "text here", the post-processing
// turns its blobs into rotated rectangles, grown a little (unclip) because the model paints the line cores only.
import { resize, toCHW, type Img, type RotRect } from './image';
import type { Loaded, Ort } from './models';

const MEAN = [0.485, 0.456, 0.406];
const STD = [0.229, 0.224, 0.225];

export interface DetOptions {
  /** Longest side the page is scaled to for detection (multiple of 32) */
  maxSide: number;
}

export async function detectLines(ort: Ort, model: Loaded, img: Img, opts: DetOptions): Promise<RotRect[]> {
  const post = (model.config?.PostProcess ?? {}) as { thresh?: number; box_thresh?: number; unclip_ratio?: number };
  const thresh = post.thresh ?? 0.3, boxThresh = post.box_thresh ?? 0.6, unclip = post.unclip_ratio ?? 1.5;

  const scale = Math.min(1, opts.maxSide / Math.max(img.width, img.height));
  const rw = Math.max(32, Math.round((img.width * scale) / 32) * 32);
  const rh = Math.max(32, Math.round((img.height * scale) / 32) * 32);
  const input = toCHW(resize(img, rw, rh), MEAN, STD, 1 / 255, true);
  const out = await model.session.run({ [model.session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, rh, rw]) });
  const map = out[model.session.outputNames[0]].data as Float32Array;

  const sx = img.width / rw, sy = img.height / rh;
  return blobs(map, rw, rh, thresh, boxThresh, unclip).map((r) => scaleRect(r, sx, sy));
}

/** Connected blobs above thresh → rotated rectangles, scored by their mean probability. */
function blobs(map: Float32Array, w: number, h: number, thresh: number, boxThresh: number, unclip: number): RotRect[] {
  const label = new Int32Array(w * h);
  const rects: RotRect[] = [];
  const stack: number[] = [];
  let next = 0;
  for (let start = 0; start < map.length; start++) {
    if (label[start] || map[start] <= thresh) continue;
    next++;
    label[start] = next;
    stack.push(start);
    let sum = 0, count = 0;
    // Row extremes are enough for the convex hull
    const rowMin = new Map<number, number>(), rowMax = new Map<number, number>();
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % w, y = (i / w) | 0;
      sum += map[i];
      count++;
      if (!rowMin.has(y) || x < rowMin.get(y)!) rowMin.set(y, x);
      if (!rowMax.has(y) || x > rowMax.get(y)!) rowMax.set(y, x);
      for (const n of [i - 1, i + 1, i - w, i + w]) {
        if (n < 0 || n >= map.length) continue;
        if ((n === i - 1 && x === 0) || (n === i + 1 && x === w - 1)) continue;
        if (!label[n] && map[n] > thresh) {
          label[n] = next;
          stack.push(n);
        }
      }
    }
    if (count < 6 || sum / count < boxThresh) continue;
    const pts: [number, number][] = [];
    for (const [y, x0] of rowMin) {
      pts.push([x0, y], [x0, y + 1], [rowMax.get(y)! + 1, y], [rowMax.get(y)! + 1, y + 1]);
    }
    const r = minAreaRect(hull(pts));
    if (Math.min(r.w, r.h) < 2) continue;
    // Unclip: grow by area · ratio / perimeter on every side
    const d = (r.w * r.h * unclip) / (2 * (r.w + r.h));
    const grown = normalize({ ...r, w: r.w + 2 * d, h: r.h + 2 * d });
    if (Math.min(grown.w, grown.h) < 5) continue;
    rects.push(grown);
  }
  return rects;
}

function hull(points: [number, number][]): [number, number][] {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [], upper: [number, number][] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  for (let i = p.length - 1; i >= 0; i--) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p[i]) <= 0) upper.pop();
    upper.push(p[i]);
  }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

/** Rotating calipers: the smallest rectangle around the hull has one side on a hull edge. */
function minAreaRect(pts: [number, number][]): RotRect {
  let best: RotRect | null = null;
  let bestArea = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i], [bx, by] = pts[(i + 1) % pts.length];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 1e-6) continue;
    const ux = (bx - ax) / len, uy = (by - ay) / len;
    let minU = Infinity, maxU = -Infinity, minN = Infinity, maxN = -Infinity;
    for (const [x, y] of pts) {
      const u = x * ux + y * uy, n = -x * uy + y * ux;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minN = Math.min(minN, n); maxN = Math.max(maxN, n);
    }
    const a = (maxU - minU) * (maxN - minN);
    if (a < bestArea) {
      bestArea = a;
      const cu = (minU + maxU) / 2, cn = (minN + maxN) / 2;
      best = { cx: cu * ux - cn * uy, cy: cu * uy + cn * ux, w: maxU - minU, h: maxN - minN, angle: Math.atan2(uy, ux) };
    }
  }
  return best ?? { cx: pts[0]?.[0] ?? 0, cy: pts[0]?.[1] ?? 0, w: 1, h: 1, angle: 0 };
}

/**
 * Angle into −45°…45° with w as the horizontal-ish side; boxes at least 1.5× taller than wide are vertical text and
 * get turned by 90° (as PaddleOCR does), so w always runs along the reading direction.
 */
export function normalize(r: RotRect): RotRect {
  let { w, h, angle } = r;
  angle = Math.atan2(Math.sin(angle), Math.cos(angle));
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle <= -Math.PI / 2) angle += Math.PI;
  if (angle > Math.PI / 4) { angle -= Math.PI / 2; [w, h] = [h, w]; }
  else if (angle < -Math.PI / 4) { angle += Math.PI / 2; [w, h] = [h, w]; }
  if (h >= 1.5 * w) { angle += Math.PI / 2; [w, h] = [h, w]; }
  return { cx: r.cx, cy: r.cy, w, h, angle };
}

/** Scale a rectangle by different x and y factors (the detection input is not proportional). */
function scaleRect(r: RotRect, sx: number, sy: number): RotRect {
  const cos = Math.cos(r.angle), sin = Math.sin(r.angle);
  const ux = cos * sx, uy = sin * sy, vx = -sin * sx, vy = cos * sy;
  return {
    cx: r.cx * sx, cy: r.cy * sy,
    w: r.w * Math.hypot(ux, uy), h: r.h * Math.hypot(vx, vy),
    angle: Math.atan2(uy, ux),
  };
}
