// SPDX-License-Identifier: GPL-3.0-or-later
// Page layout with PP-DocLayout-S (PicoDet, 23 classes): where titles, text, tables, pictures, headers and footers are.
import { iou, resize, toCHW, type Box, type Img } from './image';
import type { Loaded, Ort } from './models';

export interface Region extends Box {
  label: string;
  score: number;
}

const SIZE = 480;

export async function detectLayout(ort: Ort, model: Loaded, img: Img, minScore = 0.4): Promise<Region[]> {
  const labels = ((model.config?.label_list ?? []) as unknown[]).map(String);
  const input = toCHW(resize(img, SIZE, SIZE), [0.485, 0.456, 0.406], [0.229, 0.224, 0.225], 1 / 255, false);
  const s = model.session;
  const feeds: Record<string, ReturnType<typeof tensor>> = {};
  const tensor = (data: Float32Array, dims: number[]) => new ort.Tensor('float32', data, dims);
  for (const name of s.inputNames) {
    feeds[name] = name.includes('scale')
      ? tensor(new Float32Array([SIZE / img.height, SIZE / img.width]), [1, 2])
      : name.includes('shape') ? tensor(new Float32Array([SIZE, SIZE]), [1, 2])
      : tensor(input, [1, 3, SIZE, SIZE]);
  }
  const out = await s.run(feeds);
  const dets = Object.values(out).find((t) => t.dims.length === 2 && t.dims[1] === 6)!;
  const count = Object.values(out).find((t) => t !== dets);
  const n = count ? Number((count.data as ArrayLike<number | bigint>)[0]) : dets.dims[0];
  const d = dets.data as Float32Array;
  const regions: Region[] = [];
  for (let i = 0; i < n; i++) {
    const [cls, score, x0, y0, x1, y1] = d.subarray(i * 6, i * 6 + 6);
    if (score < minScore || cls < 0) continue;
    regions.push({
      label: labels[cls] ?? String(cls), score,
      x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(img.width, x1), y1: Math.min(img.height, y1),
    });
  }
  // The model's NMS works per class; the same area as "text" and "table" keeps the more confident one
  regions.sort((a, b) => b.score - a.score);
  const kept: Region[] = [];
  for (const r of regions) if (!kept.some((k) => iou(k, r) > 0.6)) kept.push(r);
  return kept;
}
