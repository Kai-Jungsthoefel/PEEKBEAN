// SPDX-License-Identifier: GPL-3.0-or-later
// From recognized lines, layout regions and tables to a document: blocks in reading order (headings, paragraphs,
// lists, tables, pictures), each paragraph with its detected language.
import { francAll } from 'franc-min';
import { area, intersect, type Box, type Img } from './image';
import type { Region } from './layout';
import { columnsFromPieces, fillCells, groupRows, type TableGrid } from './table';

export interface Line extends Box {
  text: string;
  conf: number;
  /** Which recognizer read it: "main" or a script key */
  script: string;
  /** Look of the type, measured in the page image (see lineStyle) */
  style?: LineStyle;
  /** x of each character of text (OCR only): lets a line that runs across table cells be split */
  chars?: number[];
  /** Probability of each character of text (OCR only): where the recognizer was unsure */
  charConf?: number[];
  /** Other likely readings of the whole line (OCR only), most likely first, with log-probabilities */
  nbest?: { text: string; logp: number }[];
  /** The recognizer's most likely characters per time step (OCR only), to search the readings again */
  steps?: { blank: number; cands: [number, string, number][] }[];
}

export interface LineStyle {
  /** The ink is clearly coloured (not black or grey) */
  color: boolean;
  /** Light type on a dark background (a coloured bar) */
  inverse: boolean;
  /** Ink pixels per box pixel: bold type has more */
  weight: number;
}

/** Measures the type of a line in the page image: background from the median brightness, ink is what differs. */
export function lineStyle(img: Img, b: Box): LineStyle {
  const x0 = Math.max(0, Math.floor(b.x0)), x1 = Math.min(img.width, Math.ceil(b.x1));
  const y0 = Math.max(0, Math.floor(b.y0)), y1 = Math.min(img.height, Math.ceil(b.y1));
  const lum: number[] = [];
  for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
    const i = (y * img.width + x) * 4;
    lum.push((img.data[i] * 77 + img.data[i + 1] * 150 + img.data[i + 2] * 29) >> 8);
  }
  const bg = median(lum);
  let ink = 0, sat = 0, n = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4;
    const r = img.data[i], g = img.data[i + 1], bl = img.data[i + 2];
    n++;
    if (Math.abs(((r * 77 + g * 150 + bl * 29) >> 8) - bg) < 70) continue;
    ink++;
    sat += Math.max(r, g, bl) - Math.min(r, g, bl);
  }
  return { color: ink > 0 && sat / ink > 55, inverse: bg < 110, weight: n ? ink / n : 0 };
}

export type Block =
  | { type: 'heading'; level: number; text: string; lang?: string; box: Box; size: number; title?: boolean }
  | { type: 'paragraph'; text: string; lang?: string; role?: 'caption' | 'header' | 'footer'; box: Box }
  | { type: 'list'; ordered: boolean; items: string[]; lang?: string; box: Box }
  | { type: 'table'; grid: TableGrid; borderless: boolean; box: Box }
  | { type: 'image'; label: string; box: Box; img?: Img }
  /** Blocks side by side in the original: one stack of blocks per column, widths as shares of the whole */
  | { type: 'columns'; columns: Block[][]; widths: number[]; box: Box };

/** A running header or footer row: its pieces at the left, centre or right */
export interface MarginRow { pieces: { text: string; align: 'left' | 'center' | 'right' }[] }

export interface PageDoc {
  blocks: Block[];
  header: MarginRow[];
  footer: MarginRow[];
}

export interface AssembleOptions {
  /** Keep side-by-side blocks side by side (otherwise one below the other, in reading order) */
  columns: boolean;
  pageWidth: number;
  pageHeight: number;
}

/** All blocks, also those inside columns */
export function* walk(blocks: Block[]): Generator<Block> {
  for (const b of blocks) {
    if (b.type === 'columns') for (const c of b.columns) yield* walk(c);
    else yield b;
  }
}

const TITLE = new Set(['doc_title', 'paragraph_title']);
const CAPTION = new Set(['figure_title', 'table_title', 'chart_title']);
const MARGIN = new Set(['header', 'footer', 'number', 'header_image', 'footer_image']);
const PICTURE = new Set(['image', 'chart', 'seal', 'formula']);

interface Group extends Box {
  kind: 'title' | 'caption' | 'body' | 'table' | 'picture';
  label: string;
  lines: Line[];
  grid?: TableGrid;
}

export function assemble(input: Line[], regions: Region[], tables: TableGrid[], opts: AssembleOptions): PageDoc {
  const groups: Group[] = [];
  const lines = joinSectionNumbers(input, tables);
  const rest = new Set(lines);

  const share = (r: Box, l: Box) => intersect(r, l) / (area(l) || 1);

  // Running headers and footers first: short lines in the outer 8 % of the page that stand apart from the body
  // (the layout model also calls the last lines of a page "footer", e.g. a signature), or page numbers. A header
  // or footer of two rows counts, as both rows lie in the zone.
  const margins = regions.filter((r) => MARGIN.has(r.label));
  const zone = (l: Box) => {
    const cy = (l.y0 + l.y1) / 2;
    return cy < 0.08 * opts.pageHeight || cy > 0.92 * opts.pageHeight;
  };
  const marginLines: Line[] = [];
  for (const l of lines) {
    const r = margins.find((m) => share(m, l) > 0.5);
    const cy = (l.y0 + l.y1) / 2, h = l.y1 - l.y0;
    const nearEdge = zone(l);
    // No body line just above or below (lines of the same row and other margin lines do not count). At the bottom
    // the gap must be larger: the last lines of a letter (a signature) sit close to the edge too.
    const gap = cy < opts.pageHeight / 2 ? 2.5 : 3.5;
    const apart = !lines.some((o) => {
      const d = Math.abs((o.y0 + o.y1) / 2 - cy);
      return o !== l && !zone(o) && d > 0.5 * h && d < gap * h;
    });
    const pageNumber = /^(\d{1,4}|page \d+( of \d+)?|seite \d+( von \d+)?|[-–] ?\d+ ?[-–])$/i.test(l.text.trim());
    if (!(nearEdge && l.text.length < 80 && (apart || pageNumber || (r && r.label === 'number')))) continue;
    marginLines.push(l);
    rest.delete(l);
  }
  const marginRows = (top: boolean): MarginRow[] =>
    groupRows(marginLines.filter((l) => (l.y0 + l.y1) / 2 < opts.pageHeight / 2 === top)).map((row) => ({
      pieces: row.map((l) => {
        const cx = (l.x0 + l.x1) / 2, w = opts.pageWidth;
        const align: 'left' | 'center' | 'right' = cx < 0.4 * w ? 'left' : cx > 0.6 * w ? 'right' : 'center';
        return { text: l.text, align };
      }),
    }));

  // Tables take the lines whose centre lies inside them
  const tableBoxes: Box[] = [];
  for (const grid of tables) {
    const inside = lines.filter((l) => rest.has(l) && contains(grid, l));
    // A grid without text is a drawing (graph paper, a chart's axes), not a table
    if (!inside.length) continue;
    fillCells(grid, inside);
    // Nor is one where most cells stay empty, or one inside a picture holding only short labels (a technical
    // drawing); the layout model calls some coloured tables pictures, so real cell text keeps those
    if (grid.source === 'lines') {
      const filled = grid.cells.filter((c) => c.text);
      if (filled.length < 0.35 * grid.cells.length) continue;
      // Cells full of running text are a page layout drawn with lines (a sheet with a dividing line), not a table
      if (filled.length <= 6 && filled.reduce((n, c) => n + c.text!.split('\n').length, 0) > 8 * filled.length) continue;
      const inPicture = regions.some((r) => PICTURE.has(r.label) && share(r, grid) > 0.7)
        && !regions.some((r) => r.label === 'table' && share(r, grid) > 0.5);
      const rowsWithTwo = new Set(filled.map((c) => c.row).filter((r, _, all) => all.filter((x) => x === r).length >= 2)).size;
      if (inPicture && (median(filled.map((c) => c.text!.length)) < 4 || rowsWithTwo < 0.5 * grid.rows)) continue;
    }
    inside.forEach((l) => rest.delete(l));
    groups.push({ ...grid, kind: 'table', label: 'table', lines: inside, grid });
    tableBoxes.push(grid);
  }

  // Pictures from the layout lose the parts that turned out to be tables; one that is mostly running text is no
  // picture (the layout model sometimes calls coloured tables or text boxes pictures)
  const pictures: Region[] = [];
  for (const r of regions.filter((r) => PICTURE.has(r.label))) {
    const p = withoutTables(r, tableBoxes);
    if (!p) continue;
    // A formula inside a line of text ("the volume V_min is …") stays text; only formulas set apart become pictures
    if (r.label === 'formula' && lines.some((l) => rest.has(l) && l.x1 - l.x0 > 1.5 * (p.x1 - p.x0)
      && Math.min(l.y1, p.y1) - Math.max(l.y0, p.y0) > 0.5 * Math.min(l.y1 - l.y0, p.y1 - p.y0))) continue;
    const text = lines.filter((l) => rest.has(l) && share(p, l) > 0.5);
    const bodyLike = text.filter((l) => l.text.length > 25);
    if (bodyLike.reduce((s, l) => s + area(l), 0) > 0.2 * area(p)) continue;
    pictures.push({ ...r, ...p });
  }

  // Titles, captions and pictures take the lines mostly inside them
  const special = [...regions.filter((r) => TITLE.has(r.label) || CAPTION.has(r.label)), ...pictures];
  const byRegion = new Map<Region, Line[]>();
  for (const l of [...rest]) {
    let best: Region | null = null, most = 0.5;
    for (const r of special) {
      const s = share(r, l);
      if (s > most) { most = s; best = r; }
    }
    if (best) {
      byRegion.set(best, [...(byRegion.get(best) ?? []), l]);
      rest.delete(l);
    }
  }
  for (const r of special) {
    const ls = byRegion.get(r) ?? [];
    const kind = TITLE.has(r.label) ? 'title' : CAPTION.has(r.label) ? 'caption' : 'picture';
    if (kind !== 'picture' && !ls.length) continue;
    // A title region may be too wide or tall; its lines are what counts
    const box = kind === 'picture' ? r : bounds(ls);
    groups.push({ ...box, kind, label: r.label, lines: ls });
  }

  // The remaining lines form blocks: vertically close and horizontally overlapping lines belong together
  for (const g of bodyBlocks([...rest])) groups.push({ ...bounds(g), kind: 'body', label: 'text', lines: g });
  mergeAlignedBlocks(groups);

  // Body text size from all lines of the page (tables included): a page with few paragraphs still has a baseline
  const bodyHeight = median(lines.map((l) => l.y1 - l.y0)) || 20;
  const bodyWeight = median(lines.filter((l) => l.style && !l.style.inverse).map((l) => l.style!.weight)) || 1;
  const toBlocks = (g: Group): Block[] => {
    const box: Box = { x0: g.x0, y0: g.y0, x1: g.x1, y1: g.y1 };
    if (g.kind === 'table') return [{ type: 'table', grid: g.grid!, borderless: g.grid!.source !== 'lines' && !g.grid!.ruled, box }];
    if (g.kind === 'picture') return [{ type: 'image', label: g.label, box }];
    if (g.kind === 'caption') return [{ type: 'paragraph', text: joinRows(g.lines), role: 'caption', box }];
    if (g.kind === 'title') {
      return [{ type: 'heading', level: 0, text: joinRows(g.lines), box, size: median(g.lines.map((l) => l.y1 - l.y0)), title: g.label === 'doc_title' }];
    }
    return bodyToBlocks(g.lines, bodyHeight, box, opts.pageWidth, bodyWeight);
  };
  const fromNodes = (nodes: Node[]): Block[] => nodes.flatMap((n): Block[] => {
    if (!('colNodes' in n)) return toBlocks(n);
    const columns = n.colNodes.map(fromNodes);
    if (!opts.columns) return columns.flat();
    // Column widths from the gaps between the columns' boxes
    const boxes = n.colNodes.map((c) => bounds(flatGroups(c)));
    const edges = [boxes[0].x0, ...boxes.slice(1).map((b, i) => (boxes[i].x1 + b.x0) / 2), boxes[boxes.length - 1].x1];
    const total = edges[edges.length - 1] - edges[0] || 1;
    const widths = boxes.map((_, i) => (edges[i + 1] - edges[i]) / total);
    return [{ type: 'columns', columns, widths, box: bounds(boxes) }];
  });
  const blocks = fromNodes(layoutTree(groups));

  levelHeadings([blocks]);
  for (const b of walk(blocks)) {
    if (b.type === 'paragraph' || b.type === 'heading') b.lang = language(b.text);
    if (b.type === 'list') b.lang = language(b.items.join(' '));
  }
  return { blocks, header: marginRows(true), footer: marginRows(false) };
}

/**
 * A section number set apart from its title ("1.1      Introduction") is detected as a line of its own; join
 * the two when they are the only pieces of their row and the title is short. Table rows ("1 | Deck cleat | 12")
 * have more pieces and stay apart, and so does anything inside a table. A section number has up to four parts of
 * one or two digits, so a date ("18.03.2026") is none.
 */
function joinSectionNumbers(lines: Line[], tables: Box[]): Line[] {
  const out = lines.slice();
  const sameRow = (a: Line, b: Line) => Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > 0.5 * Math.min(a.y1 - a.y0, b.y1 - b.y0);
  for (const num of lines) {
    if (!/^(\d{1,2}(\.\d{1,2}){0,3}\.?|[A-Z]\.|[IVX]+\.)$/.test(num.text) || !out.includes(num)) continue;
    if (tables.some((t) => contains(t, num))) continue;
    const h = num.y1 - num.y0;
    const row = out.filter((t) => t !== num && sameRow(t, num));
    const title = row.find((t) => t.x0 > num.x1 && t.x0 - num.x1 < 8 * h);
    if (!title || row.length !== 1 || title.text.length > 70 || (title.y1 - title.y0) > 1.4 * h || h > 1.4 * (title.y1 - title.y0)) continue;
    out.splice(out.indexOf(num), 1);
    out[out.indexOf(title)] = {
      ...title, text: `${num.text} ${title.text}`,
      x0: num.x0, y0: Math.min(num.y0, title.y0), y1: Math.max(num.y1, title.y1),
    };
  }
  return out;
}

/**
 * A picture region minus the tables in it: a table across most of its width cuts it, the larger part above or below
 * remains; nothing worth keeping (under a quarter of the height) removes the picture.
 */
function withoutTables(r: Box, tables: Box[]): Box | null {
  let p: Box = { x0: r.x0, y0: r.y0, x1: r.x1, y1: r.y1 };
  for (const t of tables) {
    if (intersect(p, t) === 0) continue;
    if (Math.min(p.x1, t.x1) - Math.max(p.x0, t.x0) < 0.6 * (p.x1 - p.x0)) continue;
    const above = { ...p, y1: Math.min(p.y1, t.y0) }, below = { ...p, y0: Math.max(p.y0, t.y1) };
    p = above.y1 - above.y0 >= below.y1 - below.y0 ? above : below;
  }
  return p.y1 - p.y0 >= 0.25 * (r.y1 - r.y0) && p.y1 - p.y0 > 20 ? p : null;
}

const contains = (outer: Box, b: Box) => {
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  return cx >= outer.x0 && cx <= outer.x1 && cy >= outer.y0 && cy <= outer.y1;
};

function bounds(items: Box[]): Box {
  return {
    x0: Math.min(...items.map((b) => b.x0)), y0: Math.min(...items.map((b) => b.y0)),
    x1: Math.max(...items.map((b) => b.x1)), y1: Math.max(...items.map((b) => b.y1)),
  };
}

function median(v: number[]): number {
  if (!v.length) return 0;
  const s = v.slice().sort((a, b) => a - b);
  return s[s.length >> 1];
}

function bodyBlocks(lines: Line[]): Line[][] {
  const parent = lines.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      const a = lines[i], b = lines[j];
      const ha = a.y1 - a.y0, hb = b.y1 - b.y0;
      const [top, bottom] = a.y0 <= b.y0 ? [a, b] : [b, a];
      const gap = bottom.y0 - top.y1;
      const xOverlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
      const similar = Math.max(ha, hb) < 1.6 * Math.min(ha, hb);
      if (similar && gap < 0.75 * Math.min(ha, hb) && gap > -0.5 * Math.min(ha, hb) && xOverlap > 0.2 * Math.min(a.x1 - a.x0, b.x1 - b.x0)) {
        parent[find(j)] = find(i);
      }
    }
  }
  const groups = new Map<number, Line[]>();
  lines.forEach((l, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), l]));
  return [...groups.values()];
}

/**
 * Side-by-side blocks whose rows line up and whose lines are short (labels and values, totals) become one table
 * without borders; prose in two columns also lines up, but has long lines.
 */
function mergeAlignedBlocks(groups: Group[]): void {
  const body = () => groups.filter((g) => g.kind === 'body');
  let merged = true;
  while (merged) {
    merged = false;
    const list = body();
    outer: for (const a of list) {
      for (const b of list) {
        if (a === b || b.x0 <= a.x1 - 2) continue;
        const ra = groupRows(a.lines), rb = groupRows(b.lines);
        if (ra.length < 2 || ra.length !== rb.length) continue;
        const h = median(a.lines.map((l) => l.y1 - l.y0));
        const aligned = ra.every((r, i) => Math.abs(cy(r) - cy(rb[i])) < 0.5 * h);
        const short = [...a.lines, ...b.lines].every((l) => l.text.length <= 32);
        if (!aligned || !short || b.x0 - a.x1 > 12 * h) continue;
        const all = [...a.lines, ...b.lines];
        const grid = columnsFromPieces(all, bounds(all));
        if (!grid) continue;
        groups.splice(groups.indexOf(a), 1);
        groups.splice(groups.indexOf(b), 1);
        groups.push({ ...bounds(all), kind: 'table', label: 'aligned', lines: all, grid });
        merged = true;
        break outer;
      }
    }
  }
}

const cy = (row: Box[]) => row.reduce((s, b) => s + (b.y0 + b.y1) / 2, 0) / row.length;

/** Reading structure: a stack of groups and of bands that are split into columns */
type Node = Group | { colNodes: Node[][] };

const flatGroups = (nodes: Node[]): Group[] => nodes.flatMap((n) => ('colNodes' in n ? n.colNodes.flatMap(flatGroups) : [n]));

/**
 * Recursive XY cut: split into bands at empty horizontal stripes and read them top to bottom; a band that cannot be
 * split that way is split at empty vertical stripes into columns, read left to right (and kept side by side).
 */
function layoutTree(items: Group[]): Node[] {
  if (items.length <= 1) return items;
  const bands = split(items, true);
  if (bands.length > 1) return bands.flatMap(layoutTree);
  const cols = split(items, false);
  if (cols.length > 1) return [{ colNodes: cols.map(layoutTree) }];
  return items.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
}

/** Items in the stretches between empty stripes (horizontal: stripes across the page) */
function split(items: Group[], horizontal: boolean): Group[][] {
  const lo = (g: Group) => (horizontal ? g.y0 : g.x0) + 1, hi = (g: Group) => (horizontal ? g.y1 : g.x1) - 1;
  const sorted = items.slice().sort((a, b) => lo(a) - lo(b));
  const parts: Group[][] = [[sorted[0]]];
  let end = hi(sorted[0]);
  for (const g of sorted.slice(1)) {
    if (lo(g) > end) parts.push([g]);
    else parts[parts.length - 1].push(g);
    end = Math.max(end, hi(g));
  }
  return parts;
}

const BULLET = /^([•·▪◦‣∙●○■□–—*-])\s*/;
const NUMBERED = /^(\(?\d{1,2}[.)]|\(?[a-z][.)])\s+/;

function bodyToBlocks(lines: Line[], bodyHeight: number, box: Box, pageWidth: number, bodyWeight: number): Block[] {
  const rows = groupRows(lines);
  const texts = rows.map((r) => r.map((l) => l.text).join(' '));
  // One short line that stands out is a heading: clearly larger type, or coloured, inverted (a bar) or bold
  const h = median(lines.map((l) => l.y1 - l.y0));
  if (rows.length === 1 && texts[0].length < 90 && !/[.:,;]$/.test(texts[0])) {
    const st = lines.map((l) => l.style).filter((x): x is LineStyle => !!x);
    const marked = st.length > 0 && (st.every((x) => x.color) || st.every((x) => x.inverse) || st.every((x) => x.weight > 1.35 * bodyWeight));
    if (h > 1.3 * bodyHeight || (marked && h > 0.8 * bodyHeight)) return [{ type: 'heading', level: 0, text: texts[0], box, size: h }];
  }
  // Rows starting with a bullet or number open list items; indented rows continue the item, a row back at the
  // bullet's margin ends the list. Text before and after the list stays paragraphs.
  const bullets = texts.map((t) => BULLET.test(t) ? 'bullet' : NUMBERED.test(t) ? 'number' : null);
  const right = Math.max(...rows.map((r) => r[r.length - 1].x1));
  const narrow = right - Math.min(...lines.map((l) => l.x0)) < 0.45 * pageWidth;
  const out: Block[] = [];
  let para: number[] = [];
  let list: { ordered: boolean; items: string[]; x0: number } | null = null;
  const flush = () => {
    if (para.length) out.push({ type: 'paragraph', text: paragraph(rows, texts, para, right, narrow, h), box });
    if (list) out.push({ type: 'list', ordered: list.ordered, items: list.items, box });
    para = [];
    list = null;
  };
  rows.forEach((r, i) => {
    if (bullets[i]) {
      if (para.length) flush();
      list ??= { ordered: bullets[i] === 'number', items: [], x0: r[0].x0 };
      list.items.push(texts[i].replace(BULLET, '').replace(NUMBERED, ''));
    } else if (list && r[0].x0 > list.x0 + 0.5 * h) {
      // Indented: the item goes on, unless the row before ended well short of the margin; then this is an item
      // whose bullet the OCR missed
      const prev = rows[i - 1];
      if (prev[prev.length - 1].x1 < right - 0.15 * (right - list.x0)) list.items.push(texts[i]);
      else list.items[list.items.length - 1] = join(list.items[list.items.length - 1], texts[i]);
    } else {
      if (list) flush();
      para.push(i);
    }
  });
  flush();
  return out;
}

/**
 * Rows of one paragraph. A row that ends early although the next row's first word would have fitted is a
 * deliberate line break (closing lines); so are short rows in a narrow block when the next one starts with a
 * capital or digit (addresses). Otherwise the rows flow together.
 */
function paragraph(rows: Line[][], texts: string[], idx: number[], right: number, narrow: boolean, h: number): string {
  let text = texts[idx[0]];
  for (let k = 1; k < idx.length; k++) {
    const i = idx[k], prev = idx[k - 1];
    const room = right - rows[prev][rows[prev].length - 1].x1;
    const width = rows[i][rows[i].length - 1].x1 - rows[i][0].x0;
    const word = texts[i].split(' ')[0];
    const wordWidth = (width * (word.length + 1)) / Math.max(1, texts[i].length);
    const address = narrow && texts[prev].length <= 40 && /^[\p{Lu}\d]/u.test(texts[i]);
    text = room > wordWidth + 0.5 * h || address ? `${text}\n${texts[i]}` : join(text, texts[i]);
  }
  return text;
}

function joinRows(lines: Line[]): string {
  return groupRows(lines).map((r) => r.map((l) => l.text).join(' ')).reduce(join, '');
}

const CJK = /[　-鿿가-힯＀-￯]/;

/** Join two lines of a paragraph: undo hyphenation, no space between CJK characters. */
function join(a: string, b: string): string {
  if (!a) return b;
  if (/[a-zäöüß]-$/i.test(a) && /^[a-zäöüß]/.test(b)) return a.slice(0, -1) + b;
  if (CJK.test(a[a.length - 1]) && CJK.test(b[0])) return a + b;
  return `${a} ${b}`;
}

/**
 * Heading levels over the whole document by type size: sizes are sorted and a new size class starts where the next
 * size is 13 % smaller than its neighbour (line boxes vary with ascenders and descenders). A document title (from
 * the layout, or a first heading clearly larger than the rest) is level 1, the others start below it.
 */
export function levelHeadings(pages: Block[][]): void {
  const heads = pages.flatMap((p) => [...walk(p)]).filter((b): b is Extract<Block, { type: 'heading' }> => b.type === 'heading');
  if (!heads.length) return;
  const others = heads.slice(1).map((h) => h.size);
  const titles = new Set(heads.filter((h) => h.title));
  if (!titles.size && others.length && heads[0].size >= 1.15 * median(others)) titles.add(heads[0]);
  const open = heads.filter((h) => !titles.has(h));
  const sizes = open.map((h) => h.size).sort((a, b) => b - a);
  const classOf = new Map<number, number>();
  sizes.forEach((v, i) => classOf.set(v, i && v < sizes[i - 1] * 0.87 ? classOf.get(sizes[i - 1])! + 1 : classOf.get(sizes[i - 1]) ?? 0));
  const first = titles.size ? 2 : 1;
  for (const h of titles) h.level = 1;
  for (const h of open) h.level = Math.min(3, first + (classOf.get(h.size) ?? 0));
}

/** ISO 639-3 from franc → BCP 47 tag for Word; undetermined for short or mixed text. */
const LANGS: Record<string, string> = {
  deu: 'de-DE', eng: 'en-US', fra: 'fr-FR', spa: 'es-ES', ita: 'it-IT', nld: 'nl-NL', por: 'pt-PT', pol: 'pl-PL',
  ces: 'cs-CZ', slk: 'sk-SK', hun: 'hu-HU', ron: 'ro-RO', swe: 'sv-SE', dan: 'da-DK', nob: 'nb-NO', fin: 'fi-FI',
  rus: 'ru-RU', ukr: 'uk-UA', bul: 'bg-BG', srp: 'sr-RS', hrv: 'hr-HR', slv: 'sl-SI', ell: 'el-GR', tur: 'tr-TR',
  kor: 'ko-KR', jpn: 'ja-JP', cmn: 'zh-CN', arb: 'ar-SA', tha: 'th-TH', hin: 'hi-IN', lit: 'lt-LT', lav: 'lv-LV',
  est: 'et-EE', cat: 'ca-ES', vie: 'vi-VN', ind: 'id-ID',
};

export function language(text: string): string | undefined {
  // Short strings (an ID, a name) and blocks of short lines (addresses) give random guesses
  if (text.replace(/[^\p{L}]/gu, '').length < 20) return undefined;
  if (text.includes('\n') && text.split('\n').every((l) => l.length < 45)) return undefined;
  const [best, second] = francAll(text, { minLength: 10 });
  if (!best || best[0] === 'und') return undefined;
  if (second && best[1] - second[1] < 0.02 && text.length < 40) return undefined;
  return LANGS[best[0]];
}
