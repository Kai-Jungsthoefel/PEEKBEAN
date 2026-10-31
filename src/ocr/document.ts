// SPDX-License-Identifier: GPL-3.0-or-later
// Photos of a sheet: find the paper (bright and grey against a desk or a dark background), take its four corners and
// warp it to a flat rectangle, so the rest of the pipeline sees a scan. No model: the paper is the largest bright,
// unsaturated area of the photo.
import { resize, type Img } from './image';

export type Point = [number, number];

export interface Sheet {
  /** Corners in the photo: top left, top right, bottom right, bottom left */
  corners: Point[];
  /** Share of the photo the sheet covers */
  coverage: number;
}

/**
 * The sheet in a photo, or null when there is none to cut out (a scan or rendered PDF page is all paper, and a
 * photo without a clear sheet stays as it is).
 */
export function findSheet(img: Img): Sheet | null {
  const s = Math.min(1, 640 / Math.max(img.width, img.height));
  const small = s < 1 ? resize(img, Math.round(img.width * s), Math.round(img.height * s)) : img;
  const { width: w, height: h, data } = small;

  // Paper score: light and grey. Otsu's threshold splits it from the background.
  const score = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    score[i] = (r * 77 + g * 150 + b * 29) / 256 - 1.5 * (Math.max(r, g, b) - Math.min(r, g, b));
  }
  const t = otsu(score);
  const paper = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) paper[i] = score[i] > t ? 1 : 0;

  // Largest connected area
  const label = new Int32Array(w * h);
  let best = 0, bestSize = 0, next = 0;
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (!paper[i] || label[i]) continue;
    next++;
    let size = 0;
    label[i] = next;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      size++;
      const x = j % w;
      for (const n of [j - 1, j + 1, j - w, j + w]) {
        if (n < 0 || n >= w * h || (n === j - 1 && x === 0) || (n === j + 1 && x === w - 1)) continue;
        if (paper[n] && !label[n]) { label[n] = next; stack.push(n); }
      }
    }
    if (size > bestSize) { bestSize = size; best = next; }
  }
  const coverage = bestSize / (w * h);
  // All paper (a scan) or no clear sheet
  if (coverage > 0.93 || coverage < 0.2) return null;

  // Corners: the area's points furthest towards each corner of the photo
  const pick = (f: (x: number, y: number) => number): Point => {
    let bp: Point = [0, 0], bv = -Infinity;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (label[y * w + x] !== best) continue;
      const v = f(x, y);
      if (v > bv) { bv = v; bp = [x, y]; }
    }
    return bp;
  };
  const small4 = [pick((x, y) => -x - y), pick((x, y) => x - y), pick((x, y) => x + y), pick((x, y) => y - x)];
  // Corners close to the photo's corners: a scan with a grey border, nothing to flatten
  const near = (p: Point, q: Point) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 0.07 * Math.max(w, h);
  if ([[0, 0], [w, 0], [w, h], [0, h]].every((c, i) => near(small4[i], c as Point))) return null;
  // The quadrilateral must hold most of the area (else the shape is no sheet: a torn edge, a hand on the paper)
  if (quadArea(small4) < 0.75 * bestSize || quadArea(small4) > 1.25 * bestSize) return null;
  const refined = refineCorners(label, best, w, h, small4) ?? small4;
  return { corners: refined.map(([x, y]) => [(x + 0.5) / s, (y + 0.5) / s] as Point), coverage };
}

/**
 * The extreme points are only good to a few pixels, and a small error leaves the page slightly trapezoid (columns
 * then lean). Fit a straight line through the edge points of each side instead and intersect neighbouring sides.
 */
function refineCorners(label: Int32Array, id: number, w: number, h: number, quad: Point[]): Point[] | null {
  // Edge points: area pixels with a neighbour outside the area (not on the photo's border, where the sheet is cut)
  const sides: Point[][] = [[], [], [], []];
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    if (label[i] !== id) continue;
    if (label[i - 1] === id && label[i + 1] === id && label[i - w] === id && label[i + w] === id) continue;
    // The side whose line is nearest; points near a corner are left out, the corner itself is rounded
    let bestSide = -1, bestD = Infinity;
    for (let k = 0; k < 4; k++) {
      const d = distToSegment([x, y], quad[k], quad[(k + 1) % 4]);
      if (d < bestD) { bestD = d; bestSide = k; }
    }
    const a = quad[bestSide], b = quad[(bestSide + 1) % 4];
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const along = ((x - a[0]) * (b[0] - a[0]) + (y - a[1]) * (b[1] - a[1])) / (len * len);
    if (bestD < 0.03 * Math.max(w, h) && along > 0.1 && along < 0.9) sides[bestSide].push([x, y]);
  }
  if (sides.some((s) => s.length < 20)) return null;
  const lines = sides.map(fitLine);
  const corners: Point[] = [];
  for (let k = 0; k < 4; k++) {
    const p = intersect(lines[(k + 3) % 4], lines[k]);
    if (!p) return null;
    corners.push(p);
  }
  // Refined corners far from the rough ones mean the fit went wrong (a fold, a finger on the edge)
  if (corners.some((c, k) => Math.hypot(c[0] - quad[k][0], c[1] - quad[k][1]) > 0.05 * Math.max(w, h))) return null;
  return corners;
}

function distToSegment(p: Point, a: Point, b: Point): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** Total least squares line through points, as a point on it and a direction */
function fitLine(pts: Point[]): { p: Point; d: Point } {
  const n = pts.length;
  const mx = pts.reduce((s, q) => s + q[0], 0) / n, my = pts.reduce((s, q) => s + q[1], 0) / n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pts) { sxx += (x - mx) ** 2; syy += (y - my) ** 2; sxy += (x - mx) * (y - my); }
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { p: [mx, my], d: [Math.cos(angle), Math.sin(angle)] };
}

function intersect(a: { p: Point; d: Point }, b: { p: Point; d: Point }): Point | null {
  const det = a.d[0] * b.d[1] - a.d[1] * b.d[0];
  if (Math.abs(det) < 1e-6) return null;
  const t = ((b.p[0] - a.p[0]) * b.d[1] - (b.p[1] - a.p[1]) * b.d[0]) / det;
  return [a.p[0] + t * a.d[0], a.p[1] + t * a.d[1]];
}

/**
 * The sheet cut out and flattened: output size from the edge lengths (longest side at most maxSide).
 */
export function flattenSheet(img: Img, sheet: Sheet, maxSide = 2400): Img {
  const [tl, tr, br, bl] = sheet.corners;
  const dist = (a: Point, b: Point) => Math.hypot(a[0] - b[0], a[1] - b[1]);
  let W = (dist(tl, tr) + dist(bl, br)) / 2, H = (dist(tl, bl) + dist(tr, br)) / 2;
  const k = Math.min(1, maxSide / Math.max(W, H));
  W = Math.round(W * k);
  H = Math.round(H * k);
  // Homography from output pixels to photo pixels
  const m = homography([[0, 0], [W, 0], [W, H], [0, H]], [tl, tr, br, bl]);
  const out = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const src = img.data, sw = img.width, sh = img.height;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const d = m[6] * (x + 0.5) + m[7] * (y + 0.5) + 1;
      const sx = (m[0] * (x + 0.5) + m[1] * (y + 0.5) + m[2]) / d - 0.5;
      const sy = (m[3] * (x + 0.5) + m[4] * (y + 0.5) + m[5]) / d - 0.5;
      const x0 = Math.max(0, Math.min(sw - 2, Math.floor(sx))), y0 = Math.max(0, Math.min(sh - 2, Math.floor(sy)));
      const fx = Math.min(1, Math.max(0, sx - x0)), fy = Math.min(1, Math.max(0, sy - y0));
      const o = (y * W + x) * 4, a = (y0 * sw + x0) * 4, b = a + sw * 4;
      for (let c = 0; c < 3; c++) {
        out.data[o + c] = (src[a + c] * (1 - fx) + src[a + 4 + c] * fx) * (1 - fy) + (src[b + c] * (1 - fx) + src[b + 4 + c] * fx) * fy;
      }
      out.data[o + 3] = 255;
    }
  }
  return out;
}

/** Brightness evening for photos: divide by a blurred background, so shadows and uneven light become white paper. */
export function evenLight(img: Img): Img {
  const { width: w, height: h, data } = img;
  // Background estimate: the brightest values in coarse blocks, smoothed
  const bs = Math.max(16, Math.round(Math.max(w, h) / 40));
  const bw = Math.ceil(w / bs), bh = Math.ceil(h / bs);
  const bg = new Float32Array(bw * bh * 3);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const vals: number[][] = [[], [], []];
    for (let y = by * bs; y < Math.min(h, (by + 1) * bs); y += 2) for (let x = bx * bs; x < Math.min(w, (bx + 1) * bs); x += 2) {
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) vals[c].push(data[i + c]);
    }
    for (let c = 0; c < 3; c++) {
      const v = vals[c].sort((a, b) => a - b);
      bg[(by * bw + bx) * 3 + c] = v[Math.floor(v.length * 0.9)] || 255;
    }
  }
  const out = { width: w, height: h, data: new Uint8ClampedArray(data.length) };
  for (let y = 0; y < h; y++) {
    const fy = Math.min(bh - 1, Math.max(0, (y + 0.5) / bs - 0.5)), y0 = Math.floor(fy), y1 = Math.min(bh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(bw - 1, Math.max(0, (x + 0.5) / bs - 0.5)), x0 = Math.floor(fx), x1 = Math.min(bw - 1, x0 + 1), tx = fx - x0;
      const i = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const b = (bg[(y0 * bw + x0) * 3 + c] * (1 - tx) + bg[(y0 * bw + x1) * 3 + c] * tx) * (1 - ty)
          + (bg[(y1 * bw + x0) * 3 + c] * (1 - tx) + bg[(y1 * bw + x1) * 3 + c] * tx) * ty;
        out.data[i + c] = Math.min(255, (data[i + c] / Math.max(40, b)) * 255);
      }
      out.data[i + 3] = 255;
    }
  }
  return out;
}

function otsu(v: Float32Array): number {
  let min = Infinity, max = -Infinity;
  for (const x of v) { if (x < min) min = x; if (x > max) max = x; }
  const bins = 256, hist = new Float64Array(bins), span = max - min || 1;
  for (const x of v) hist[Math.min(bins - 1, Math.floor(((x - min) / span) * bins))]++;
  let sum = 0;
  for (let i = 0; i < bins; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, bestT = 0;
  for (let i = 0; i < bins; i++) {
    wB += hist[i];
    if (!wB || wB === v.length) continue;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / (v.length - wB);
    const between = wB * (v.length - wB) * (mB - mF) ** 2;
    if (between > best) { best = between; bestT = i; }
  }
  return min + ((bestT + 0.5) / bins) * span;
}

function quadArea(p: Point[]): number {
  let a = 0;
  for (let i = 0; i < 4; i++) a += p[i][0] * p[(i + 1) % 4][1] - p[(i + 1) % 4][0] * p[i][1];
  return Math.abs(a) / 2;
}

/** 3×3 homography (as 8 numbers, h33 = 1) mapping the four points `from` onto `to`. */
function homography(from: Point[], to: Point[]): number[] {
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i], [u, v] = to[i];
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
  }
  // Gaussian elimination with partial pivoting on the 8×9 augmented matrix
  for (let c = 0; c < 8; c++) {
    let p = c;
    for (let r = c + 1; r < 8; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < 8; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k < 9; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[8] / row[i]);
}
