// SPDX-License-Identifier: GPL-3.0-or-later
// PDF text layer → lines in page pixels. Items on one baseline that follow each other closely are one line; a gap
// of more than a tenth of the font size is a space (OCR text layers often place each word as its own item).
import type { Line } from './assemble';

export interface TextItem { str: string; transform: number[]; width: number }

/** pdf.js Util.transform: the matrix product m1 · m2 */
function transform(m1: number[], m2: number[]): number[] {
  return [
    m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/**
 * @param viewportTransform the page viewport's transform (PDF points → pixels)
 * @param scale the viewport's scale, for the item widths
 */
export function linesFromItems(items: TextItem[], viewportTransform: number[], scale: number): Line[] {
  const pieces = items
    .filter((it) => typeof it.str === 'string' && it.str.trim())
    .map((it) => {
      const t = transform(viewportTransform, it.transform);
      const h = Math.hypot(t[2], t[3]);
      const x = t[4], base = t[5];
      return { text: it.str, x0: x, x1: x + it.width * scale, y0: base - h * 0.85, y1: base + h * 0.25, base, h };
    })
    // Vertical or rotated text and invisible zero-size items would break the row logic
    .filter((p) => p.h > 2 && p.x1 > p.x0)
    .sort((a, b) => a.base - b.base || a.x0 - b.x0);
  const lines: (Line & { base: number; h: number })[] = [];
  for (const p of pieces) {
    const l = lines.find((l) => Math.abs(l.base - p.base) < 0.3 * p.h && p.x0 - l.x1 < 0.8 * p.h && p.x0 >= l.x0 - 1);
    if (l) {
      const gap = p.x0 - l.x1;
      l.text += (gap > 0.1 * p.h && !l.text.endsWith(' ') && !p.text.startsWith(' ') ? ' ' : '') + p.text;
      l.x1 = Math.max(l.x1, p.x1);
      l.y0 = Math.min(l.y0, p.y0);
      l.y1 = Math.max(l.y1, p.y1);
    } else lines.push({ ...p, conf: 1, script: 'pdf' });
  }
  return lines.map(({ base: _b, h: _h, ...l }) => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() }));
}
