// SPDX-License-Identifier: GPL-3.0-or-later
// Table structure. Ruled tables come from their lines alone (no model): long dark runs make the grid, missing
// border pieces between two grid cells make merged cells. Tables without (enough) lines go to SLANet_plus, which
// predicts the HTML structure and a box per cell. Either way the recognized text lines are then put into the cells.
import { crop, gray, intersect, resize, toCHW, type Box, type Img } from './image';
import type { Loaded, Ort } from './models';

export interface Cell extends Box {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  header?: boolean;
  text?: string;
}

export interface TableGrid extends Box {
  rows: number;
  cols: number;
  cells: Cell[];
  source: 'lines' | 'model' | 'columns';
  /** The table has rules (also when the model's structure replaced a broken grid of them) */
  ruled?: boolean;
  /** Column and row borders of a ruled grid */
  xs?: number[];
  ys?: number[];
}

interface Seg { pos: number; from: number; to: number }

// ---------- Ruled tables ----------

/**
 * Finds ruled tables on the page (or in a part of it). Returns one grid per connected group of lines that has at
 * least two rows or columns of cells.
 */
export function findRuledTables(img: Img, area?: Box): TableGrid[] {
  const box = area ?? { x0: 0, y0: 0, x1: img.width, y1: img.height };
  const part = crop(img, box);
  const masks = lineMasks(part);
  const minLen = Math.max(24, Math.round(Math.max(img.width, img.height) * 0.02));
  const hs = segments(masks.h, part.width, part.height, true, minLen);
  const vs = segments(masks.v, part.width, part.height, false, minLen);
  if (hs.length < 2 || vs.length < 2) return [];

  // Group segments that touch into separate tables
  const all = [...hs.map((s) => ({ s, h: true })), ...vs.map((s) => ({ s, h: false }))];
  const parent = all.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const tol = 6;
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i], b = all[j];
      if (a.h === b.h) continue;
      const [h, v] = a.h ? [a.s, b.s] : [b.s, a.s];
      if (v.pos >= h.from - tol && v.pos <= h.to + tol && h.pos >= v.from - tol && h.pos <= v.to + tol) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, { hs: Seg[]; vs: Seg[] }>();
  all.forEach((a, i) => {
    const g = groups.get(find(i)) ?? { hs: [], vs: [] };
    (a.h ? g.hs : g.vs).push(a.s);
    groups.set(find(i), g);
  });

  const tables: TableGrid[] = [];
  for (const g of groups.values()) {
    const t = grid(g.hs, g.vs, Math.max(6, Math.round(Math.max(img.width, img.height) * 0.008)));
    if (t && (t.rows > 1 || t.cols > 1) && t.rows * t.cols >= 2) {
      const shift = (b: Box) => ({ x0: b.x0 + box.x0, y0: b.y0 + box.y0, x1: b.x1 + box.x0, y1: b.y1 + box.y0 });
      tables.push({
        ...t, ...shift(t), cells: t.cells.map((c) => ({ ...c, ...shift(c) })), source: 'lines',
        xs: t.xs!.map((x) => x + box.x0), ys: t.ys!.map((y) => y + box.y0),
      });
    }
  }
  return tables;
}

/**
 * Thin lines by contrast: a pixel belongs to a horizontal line when the pixels 4 px above and below are both
 * clearly lighter, or both clearly darker (white rules on coloured table headers); vertical lines likewise.
 * So light grey rules, white separators and dark scanned lines all count, and the edges of filled areas.
 */
export function lineMasks(img: Img): { h: Uint8Array; v: Uint8Array } {
  const { width: w, height: hgt } = img;
  const g = gray(img);
  const h = new Uint8Array(w * hgt), v = new Uint8Array(w * hgt);
  const d = 4, t = 22, step = 45;
  const thin = (c: number, a: number, b: number) => (a - c >= t && b - c >= t) || (c - a >= t && c - b >= t);
  for (let y = d; y < hgt - d; y++) {
    for (let x = d; x < w - d; x++) {
      const i = y * w + x, c = g[i];
      // A strong step counts too: the border between a coloured header row and white body rows has no rule
      if (thin(c, g[i - d * w], g[i + d * w]) || Math.abs(g[i - 2 * w] - g[i + 2 * w]) >= step) h[i] = 1;
      if (thin(c, g[i - d], g[i + d]) || Math.abs(g[i - 2] - g[i + 2]) >= step) v[i] = 1;
    }
  }
  return { h, v };
}

/** Long runs of line pixels (with small gaps), merged over neighbouring rows/columns into line segments. */
export function segments(dark: Uint8Array, w: number, h: number, horizontal: boolean, minLen: number): Seg[] {
  const [outer, inner] = horizontal ? [h, w] : [w, h];
  const at = horizontal ? (o: number, i: number) => dark[o * w + i] : (o: number, i: number) => dark[i * w + o];
  const runs: Seg[] = [];
  for (let o = 0; o < outer; o++) {
    let start = -1, gap = 0;
    for (let i = 0; i <= inner; i++) {
      const on = i < inner && at(o, i);
      if (on) {
        if (start < 0) start = i;
        gap = 0;
      } else if (start >= 0 && ++gap > 3) {
        const end = i - gap;
        if (end - start >= minLen) runs.push({ pos: o, from: start, to: end });
        start = -1;
        gap = 0;
      }
    }
  }
  // Merge runs of adjacent rows that overlap or continue each other (a slightly tilted or bowed line in a photo
  // steps from one row to the next); thick results (filled areas, bold text) are dropped
  const segs: (Seg & { first: number; last: number })[] = [];
  for (const r of runs) {
    const s = segs.find((s) => r.pos - s.last <= 1 && r.from <= s.to + 6 && r.to >= s.from - 6);
    if (s) {
      s.last = r.pos;
      s.from = Math.min(s.from, r.from);
      s.to = Math.max(s.to, r.to);
    } else segs.push({ ...r, first: r.pos, last: r.pos });
  }
  // Up to 7 px thick, plus what a remaining tilt of up to 0.6° adds over the length
  return segs
    .filter((s) => s.last - s.first <= 7 + 0.01 * (s.to - s.from))
    .map((s) => ({ pos: (s.first + s.last) / 2, from: s.from, to: s.to }));
}

function grid(hs: Seg[], vs: Seg[], tol: number): Omit<TableGrid, 'source'> | null {
  // Positions of one rule vary a little in photos (a slight lean), so they are pooled with a tolerance
  const ys = cluster(hs.map((s) => s.pos), tol);
  const xs = cluster(vs.map((s) => s.pos), tol);
  if (ys.length < 2 || xs.length < 2) return null;
  const rows = ys.length - 1, cols = xs.length - 1;
  // Is there a line along this piece of border? Covered for more than half of its length counts.
  const covered = (segs: Seg[], pos: number, from: number, to: number) => {
    let len = 0;
    for (const s of segs) {
      if (Math.abs(s.pos - pos) > tol) continue;
      len += Math.max(0, Math.min(to, s.to) - Math.max(from, s.from));
    }
    return len > (to - from) * 0.5;
  };
  // Union-find over grid cells: no border between two neighbours means they are one merged cell
  const id = (r: number, c: number) => r * cols + c;
  const parent = Array.from({ length: rows * cols }, (_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols && !covered(vs, xs[c + 1], ys[r], ys[r + 1])) parent[find(id(r, c + 1))] = find(id(r, c));
      if (r + 1 < rows && !covered(hs, ys[r + 1], xs[c], xs[c + 1])) parent[find(id(r + 1, c))] = find(id(r, c));
    }
  }
  const groups = new Map<number, { r0: number; r1: number; c0: number; c1: number }>();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const k = find(id(r, c));
      const g = groups.get(k);
      if (g) {
        g.r0 = Math.min(g.r0, r); g.r1 = Math.max(g.r1, r);
        g.c0 = Math.min(g.c0, c); g.c1 = Math.max(g.c1, c);
      } else groups.set(k, { r0: r, r1: r, c0: c, c1: c });
    }
  }
  const cells: Cell[] = [...groups.values()]
    .map((g) => ({
      row: g.r0, col: g.c0, rowSpan: g.r1 - g.r0 + 1, colSpan: g.c1 - g.c0 + 1,
      x0: xs[g.c0], y0: ys[g.r0], x1: xs[g.c1 + 1], y1: ys[g.r1 + 1],
    }))
    .sort((a, b) => a.row - b.row || a.col - b.col);
  // A frame around one block of text is no table
  if (cells.length < 2) return null;
  return { x0: xs[0], y0: ys[0], x1: xs[cols], y1: ys[rows], rows, cols, cells, xs, ys };
}

function cluster(values: number[], tol = 6): number[] {
  const v = values.slice().sort((a, b) => a - b);
  const out: number[][] = [];
  for (const x of v) {
    const last = out[out.length - 1];
    if (last && x - last[last.length - 1] <= tol) last.push(x);
    else out.push([x]);
  }
  return out.map((g) => g.reduce((a, b) => a + b, 0) / g.length);
}

// ---------- SLANet_plus ----------

const SLA = 488;

export async function predictTable(ort: Ort, model: Loaded, img: Img, box: Box): Promise<TableGrid | null> {
  const part = crop(img, box);
  const scale = SLA / Math.max(part.width, part.height);
  const rw = Math.max(1, Math.round(part.width * scale)), rh = Math.max(1, Math.round(part.height * scale));
  const data = new Float32Array(3 * SLA * SLA);
  toCHW(resize(part, rw, rh), [0.485, 0.456, 0.406], [0.229, 0.224, 0.225], 1 / 255, true, data, SLA);
  // toCHW wrote rh rows of width SLA per channel at stride SLA·rh; move each channel to stride SLA·SLA
  const fixed = new Float32Array(3 * SLA * SLA);
  for (let c = 0; c < 3; c++) fixed.set(data.subarray(c * SLA * rh, (c + 1) * SLA * rh), c * SLA * SLA);
  const s = model.session;
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor('float32', fixed, [1, 3, SLA, SLA]) });
  const tensors = Object.values(out);
  const loc = tensors.find((t) => t.dims[t.dims.length - 1] === 8);
  const struct = tensors.find((t) => t !== loc);
  if (!loc || !struct) return null;

  const post = (model.config?.PostProcess ?? {}) as { character_dict?: unknown[] };
  let dict = (post.character_dict ?? []).map(String);
  if (!dict.includes('<td></td>')) dict.push('<td></td>');
  dict = ['sos', ...dict.filter((t) => t !== '<td>'), 'eos'];
  const [, L, V] = struct.dims as number[];
  if (V !== dict.length) console.warn(`Table model has ${V} tokens, dictionary ${dict.length}`);
  const probs = struct.data as Float32Array, boxes = loc.data as Float32Array;

  const tokens: string[] = [];
  const cellBoxes: Box[] = [];
  for (let t = 0; t < L; t++) {
    let best = 0, bp = -Infinity;
    for (let v = 0; v < V; v++) if (probs[t * V + v] > bp) { bp = probs[t * V + v]; best = v; }
    const tok = dict[best];
    if (t > 0 && tok === 'eos') break;
    if (tok === 'sos' || tok === 'eos') continue;
    tokens.push(tok);
    if (tok === '<td></td>' || tok === '<td') {
      const b = boxes.subarray(t * 8, t * 8 + 8);
      // Normalized to the padded square, so both axes scale with the longer side
      const side = Math.max(part.width, part.height);
      const xs = [b[0], b[2], b[4], b[6]].map((x) => x * side + box.x0);
      const ys = [b[1], b[3], b[5], b[7]].map((y) => y * side + box.y0);
      cellBoxes.push({ x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    }
  }
  return fromHtmlTokens(tokens, cellBoxes, box);
}

/** HTML structure tokens → cells with row/column positions (rowspans block cells in later rows). */
function fromHtmlTokens(tokens: string[], boxes: Box[], box: Box): TableGrid | null {
  const cells: Cell[] = [];
  const taken = new Set<string>();
  let row = -1, col = 0, inHead = false, k = 0;
  let pending: { colSpan: number; rowSpan: number } | null = null;
  const place = (colSpan: number, rowSpan: number) => {
    while (taken.has(`${row},${col}`)) col++;
    const b = boxes[k++] ?? { x0: 0, y0: 0, x1: 0, y1: 0 };
    cells.push({ row, col, colSpan, rowSpan, header: inHead, ...b });
    for (let r = 0; r < rowSpan; r++) for (let c = 0; c < colSpan; c++) taken.add(`${row + r},${col + c}`);
    col += colSpan;
  };
  for (const t of tokens) {
    if (t === '<thead>') inHead = true;
    else if (t === '</thead>') inHead = false;
    else if (t === '<tr>') { row++; col = 0; }
    else if (t === '<td></td>') place(1, 1);
    else if (t === '<td') pending = { colSpan: 1, rowSpan: 1 };
    else if (pending && t.includes('colspan')) pending.colSpan = Number(t.match(/\d+/)?.[0] ?? 1);
    else if (pending && t.includes('rowspan')) pending.rowSpan = Number(t.match(/\d+/)?.[0] ?? 1);
    else if (pending && t === '>') { place(pending.colSpan, pending.rowSpan); pending = null; }
  }
  if (!cells.length) return null;
  const rows = Math.max(...cells.map((c) => c.row + c.rowSpan));
  const cols = Math.max(...cells.map((c) => c.col + c.colSpan));
  return { ...box, rows, cols, cells, source: 'model' };
}

// ---------- Tables from text positions alone ----------

export interface Piece extends Box { text: string; chars?: number[] }

/**
 * Rows from the vertical positions of the pieces, columns from the horizontal gaps that run through all rows.
 * Used when neither lines nor the model give a structure, and for aligned key/value blocks.
 */
export function columnsFromPieces(pieces: Piece[], box: Box): TableGrid | null {
  if (pieces.length < 2) return null;
  const rows = groupRows(pieces);
  // Column gaps: x ranges not covered by any piece
  const spans = pieces.map((p) => [p.x0, p.x1]).sort((a, b) => a[0] - b[0]);
  const cols: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = cols[cols.length - 1];
    if (last && a <= last[1] + 4) last[1] = Math.max(last[1], b);
    else cols.push([a, b]);
  }
  if (cols.length < 2 || rows.length < 2) return null;
  const cells: Cell[] = [];
  rows.forEach((r, ri) => {
    const y0 = Math.min(...r.map((p) => p.y0)), y1 = Math.max(...r.map((p) => p.y1));
    cols.forEach(([x0, x1], ci) => {
      const inside = r.filter((p) => p.x0 >= x0 - 1 && p.x1 <= x1 + 1).sort((a, b) => a.x0 - b.x0);
      cells.push({ row: ri, col: ci, rowSpan: 1, colSpan: 1, x0, y0, x1, y1, text: inside.map((p) => p.text).join(' ') });
    });
  });
  return { ...box, rows: rows.length, cols: cols.length, cells, source: 'columns' };
}

export function groupRows<T extends Box>(items: T[]): T[][] {
  const sorted = items.slice().sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  const rows: T[][] = [];
  for (const it of sorted) {
    const row = rows[rows.length - 1];
    if (row) {
      const ry0 = Math.min(...row.map((p) => p.y0)), ry1 = Math.max(...row.map((p) => p.y1));
      const overlap = Math.min(ry1, it.y1) - Math.max(ry0, it.y0);
      if (overlap > 0.5 * Math.min(ry1 - ry0, it.y1 - it.y0)) {
        row.push(it);
        continue;
      }
    }
    rows.push([it]);
  }
  return rows.map((r) => r.sort((a, b) => a.x0 - b.x0));
}

/** Put text pieces into the cells: by the cell with the largest share of the piece. */
export function fillCells(table: TableGrid, pieces: Piece[]): void {
  if (table.source === 'columns') return;
  pieces = splitAcrossCells(table, pieces);
  if (table.source === 'lines') {
    splitMergedColumns(table, pieces);
    splitRows(table, pieces);
  }
  const byCell = new Map<Cell, Piece[]>();
  // The model's cell boxes are approximate: place text row by row. Row bands lie halfway between the rows' centres;
  // within its band a piece goes to the cell it overlaps most horizontally.
  const rowOf = table.source === 'model' ? modelRowBands(table) : null;
  for (const p of pieces) {
    let best: Cell | null = null, bestA = 0;
    if (rowOf) {
      const r = rowOf((p.y0 + p.y1) / 2);
      for (const c of table.cells) {
        if (r < c.row || r >= c.row + c.rowSpan) continue;
        const a = Math.min(c.x1, p.x1) - Math.max(c.x0, p.x0) + 1e-3 / (1 + Math.abs((c.x0 + c.x1) / 2 - (p.x0 + p.x1) / 2));
        if (a > bestA) { bestA = a; best = c; }
      }
      if (best) {
        byCell.set(best, [...(byCell.get(best) ?? []), p]);
        continue;
      }
    }
    for (const c of table.cells) {
      const a = intersect(c, p);
      if (a > bestA) { bestA = a; best = c; }
    }
    if (!best) {
      // Model boxes can be off a little; then the nearest cell centre wins
      const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2;
      best = table.cells.reduce((m, c) =>
        Math.hypot((c.x0 + c.x1) / 2 - cx, (c.y0 + c.y1) / 2 - cy) < Math.hypot((m.x0 + m.x1) / 2 - cx, (m.y0 + m.y1) / 2 - cy) ? c : m);
    }
    byCell.set(best, [...(byCell.get(best) ?? []), p]);
  }
  for (const c of table.cells) {
    c.text = groupRows(byCell.get(c) ?? []).map((r) => r.map((p) => p.text).join(' ')).join('\n');
  }
}

/**
 * Row index for a height. A border lies halfway between the bottom of one row's single-row cells and the top of the
 * next row's (edges, not centres: a tall row with several lines would otherwise reach into the row above).
 */
function modelRowBands(t: TableGrid): (y: number) => number {
  const edge = (r: number, top: boolean) => {
    const v = t.cells.filter((c) => c.row === r && c.rowSpan === 1).map((c) => (top ? c.y0 : c.y1)).sort((a, b) => a - b);
    return v.length ? v[v.length >> 1] : NaN;
  };
  const borders: number[] = [];
  for (let r = 0; r + 1 < t.rows; r++) {
    const a = edge(r, false), b = edge(r + 1, true);
    borders.push(Number.isNaN(a) ? b : Number.isNaN(b) ? a : (a + b) / 2);
  }
  // Rows without single-row cells: borders spread evenly between their known neighbours
  for (let r = 0; r < borders.length; r++) {
    if (!Number.isNaN(borders[r])) continue;
    const prev = r ? borders[r - 1] : t.y0;
    const next = borders.slice(r + 1).find((v) => !Number.isNaN(v)) ?? t.y1;
    borders[r] = prev + (next - prev) / 2;
  }
  return (y) => {
    let r = 0;
    while (r < borders.length && y > borders[r]) r++;
    return r;
  };
}

/**
 * OCR can read two neighbouring cells as one line ("18.03.2026 MA"). When a line runs across a column border and
 * has a space close to it, split the line there (character positions come from the recognizer).
 */
function splitAcrossCells(t: TableGrid, pieces: Piece[]): Piece[] {
  const rowOf = t.source === 'model' ? modelRowBands(t) : null;
  const out: Piece[] = [];
  for (const p of pieces) {
    if (!p.chars || !p.text.includes(' ')) { out.push(p); continue; }
    const w = p.x1 - p.x0;
    // Column borders the line crosses: between horizontally neighbouring cells of its row
    const cy = (p.y0 + p.y1) / 2;
    const row = rowOf ? rowOf(cy) : -1;
    const cells = t.cells
      .filter((c) => (rowOf ? row >= c.row && row < c.row + c.rowSpan : cy >= c.y0 && cy <= c.y1))
      .sort((a, b) => a.x0 - b.x0);
    const borders = cells.slice(1).map((c, i) => (cells[i].x1 + c.x0) / 2).filter((b) => b > p.x0 + 0.05 * w && b < p.x1 - 0.05 * w);
    if (!borders.length) { out.push(p); continue; }
    const chars = [...p.text];
    const cuts: number[] = [];
    for (const b of borders) {
      let best = -1, bestD = Infinity;
      chars.forEach((ch, i) => {
        if (ch !== ' ') return;
        const d = Math.abs(p.chars![i] - b);
        if (d < bestD) { bestD = d; best = i; }
      });
      if (best > 0 && bestD < 0.12 * w && !cuts.includes(best)) cuts.push(best);
    }
    if (!cuts.length) { out.push(p); continue; }
    cuts.sort((a, b) => a - b);
    let start = 0;
    for (const cut of [...cuts, chars.length]) {
      const text = chars.slice(start, cut).join('').trim();
      if (text) {
        const xs = p.chars.slice(start, cut);
        out.push({ ...p, text, chars: xs, x0: start ? (p.chars[start - 1] + xs[0]) / 2 : p.x0, x1: cut < chars.length ? (xs[xs.length - 1] + p.chars[cut]) / 2 : p.x1 });
      }
      start = cut + 1;
    }
  }
  return out;
}

const centerIn = (p: Box, c: Box) => {
  const x = (p.x0 + p.x1) / 2, y = (p.y0 + p.y1) / 2;
  return x >= c.x0 && x <= c.x1 && y >= c.y0 && y <= c.y1;
};

/**
 * A light rule may be missed in some rows, which merges two cells. When text sits on both sides of the column
 * border and nothing crosses it, the cells are separate after all.
 */
function splitMergedColumns(t: TableGrid, pieces: Piece[]): void {
  const xs = t.xs!;
  const queue = t.cells.filter((c) => c.colSpan > 1);
  while (queue.length) {
    const c = queue.pop()!;
    const inside = pieces.filter((p) => centerIn(p, c));
    for (let k = c.col + 1; k < c.col + c.colSpan; k++) {
      const bx = xs[k];
      if (inside.some((p) => p.x0 < bx - 2 && p.x1 > bx + 2)) continue;
      if (!inside.some((p) => p.x1 <= bx + 2) || !inside.some((p) => p.x0 >= bx - 2)) continue;
      const right: Cell = { ...c, col: k, colSpan: c.col + c.colSpan - k, x0: bx };
      c.colSpan = k - c.col;
      c.x1 = bx;
      t.cells.push(right);
      if (right.colSpan > 1) queue.push(right);
      break;
    }
  }
  t.cells.sort((a, b) => a.row - b.row || a.col - b.col);
}

/**
 * Rows whose rule is missing (only a faint change of shading) end up as one grid row with two text rows in every
 * filled cell. Split such a row when most of its filled cells have the same number of text rows at the same heights
 * (and the others more, from wrapped text); each piece then goes to the part its height falls into.
 */
function splitRows(t: TableGrid, pieces: Piece[]): void {
  for (let r = t.rows - 1; r >= 0; r--) {
    const cells = t.cells.filter((c) => c.row === r && c.rowSpan === 1);
    if (t.cells.some((c) => c.row <= r && c.row + c.rowSpan > r && c.rowSpan > 1)) continue;
    const rows = cells.map((c) => groupRows(pieces.filter((p) => centerIn(p, c))));
    const filled = rows.filter((x) => x.length);
    // k text rows in most filled cells; cells with wrapped text have more, but never fewer
    const counts = filled.map((x) => x.length);
    const k = median(counts);
    const exact = filled.filter((x) => x.length === k);
    if (filled.length < 2 || k < 2 || exact.length < 0.6 * filled.length || counts.some((n) => n < k)) continue;
    const centres = exact.map((x) => x.map((row) => row.reduce((s, p) => s + (p.y0 + p.y1) / 2, 0) / row.length));
    const h = median(pieces.map((p) => p.y1 - p.y0));
    if (centres.some((cs) => cs.some((y, i) => Math.abs(y - centres[0][i]) > 0.6 * h))) continue;
    // New borders halfway between the text rows
    const borders = centres[0].slice(1).map((y, i) => (y + centres[0][i]) / 2);
    for (const c of t.cells) if (c.row > r) c.row += k - 1;
    const next: Cell[] = [];
    for (const c of cells) {
      const ys = [c.y0, ...borders, c.y1];
      for (let i = 0; i < k; i++) next.push({ ...c, row: r + i, y0: ys[i], y1: ys[i + 1] });
    }
    t.cells = t.cells.filter((c) => !cells.includes(c)).concat(next).sort((a, b) => a.row - b.row || a.col - b.col);
    t.rows += k - 1;
    t.ys = [...t.ys!.slice(0, r + 1), ...borders, ...t.ys!.slice(r + 1)];
  }
}

function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  return s[s.length >> 1] ?? 0;
}
