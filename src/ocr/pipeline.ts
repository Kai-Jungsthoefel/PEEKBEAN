// SPDX-License-Identifier: GPL-3.0-or-later
// One page through the whole pipeline: orientation → line detection → straightening → recognition (with other
// scripts for lines the main model cannot read) → layout → tables → document blocks.
import { assemble, lineStyle, walk, type Block, type Line, type MarginRow } from './assemble';
import { buildDictionary, correctLines, type Dictionary } from './correct';
import { detectLines } from './det';
import { findSheet, flattenSheet } from './document';
import { crop, rectBox, refineSkew, resize, rotate, rotate90, rotatePoint, toCHW, type Img, type RotRect } from './image';
import { detectLayout, type Region } from './layout';
import { DICTIONARIES, FRANC_TO_DICT, LANGUAGE_DATA, loadModel, SCRIPTS, type Env, type ModelKey, type ScriptKey } from './models';
import { francAll } from 'franc-min';
import { buildLanguageModel, contextAfter, decodeLine, researchLine, DECODE_DEFAULTS, fixNumbers, LINE_START, pageWords, type LanguageModel, type LineContext } from './lm';
import { recognize, type RecResult } from './rec';
import { columnsFromPieces, findRuledTables, predictTable, type TableGrid } from './table';

export interface PipelineOptions {
  /** Longest side for line detection */
  detSide: number;
  /** Longest side of the page image the pipeline works on; larger images (photos) are reduced to it */
  pageSide: number;
  orientation: boolean;
  /** Photos of a sheet: cut out the sheet, flatten the perspective, even out the light */
  photo: boolean;
  layout: boolean;
  /** SLANet_plus for tables without lines; otherwise columns from text positions */
  tableModel: boolean;
  /** Other scripts: off, try all when needed, or a fixed list */
  scripts: 'off' | 'auto' | ScriptKey[];
  /** Running headers and footers into Word's header and footer (otherwise dropped) */
  headerFooter: boolean;
  /** Blocks side by side in the original stay side by side (a table without borders in Word) */
  columns: boolean;
  /** Correct unsure words: with word pairs and triples where the language has them, else against its word list */
  correct: boolean;
}

export const DEFAULTS: PipelineOptions = {
  detSide: 1600, pageSide: 1754, orientation: true, photo: true, layout: true, tableModel: true, scripts: 'auto', headerFooter: true, columns: true, correct: true,
};

export interface PageResult {
  /** The page as processed (turned and straightened) */
  img: Img;
  blocks: Block[];
  header: MarginRow[];
  footer: MarginRow[];
  lines: Line[];
  regions: Region[];
  tables: TableGrid[];
  /** A photo whose sheet was cut out and flattened */
  flattened: boolean;
  /** Quarter turns and fine rotation (degrees) that were applied */
  turned: number;
  skew: number;
  /** Milliseconds per step */
  timings: Record<string, number>;
  /** Scripts other than the main one that were found */
  scriptsUsed: string[];
}

export type Progress = (step: string) => void;

/**
 * @param textLines lines from a PDF text layer: then detection and recognition are skipped
 */
export async function processPage(env: Env, input: Img, opts: PipelineOptions, progress: Progress = () => {}, textLines?: Line[]): Promise<PageResult> {
  const timings: Record<string, number> = {};
  const time = async <T>(name: string, f: () => Promise<T> | T): Promise<T> => {
    progress(name);
    const t = performance.now();
    try {
      return await f();
    } finally {
      timings[name] = (timings[name] ?? 0) + performance.now() - t;
    }
  };
  let img = input;
  let turned = 0, skew = 0, flattened = false;
  let lines: Line[];
  let regions: Region[] = [];
  const layout = async (page: Img) => {
    if (opts.layout) regions = await time('Layout', async () => detectLayout(env.ort, await loadModel(env, 'layout'), page));
  };
  const scriptsUsed = new Set<string>();

  if (textLines) {
    lines = textLines;
  } else {
    if (opts.photo) {
      const sheet = await time('Sheet', () => findSheet(img));
      if (sheet) {
        const src = img;
        // Only the geometry: evening out the light (evenLight) washed out thin table rules in tests
        img = await time('Sheet', () => flattenSheet(src, sheet, opts.pageSide));
        flattened = true;
      }
    }
    // Photos come in at full resolution so the sheet is flattened from all their pixels; then the page size
    if (Math.max(img.width, img.height) > opts.pageSide * 1.05) {
      const s = opts.pageSide / Math.max(img.width, img.height), src = img;
      img = await time('Sheet', () => resize(src, Math.round(src.width * s), Math.round(src.height * s)));
    }
    // Not for strips (a single line): the classifier looks at the centre square, which says little there
    if (opts.orientation && Math.max(img.width, img.height) < 3 * Math.min(img.width, img.height)) {
      turned = await time('Orientation', () => orientation(env, img));
      if (turned) img = rotate90(img, turned);
    }
    const det = await loadModel(env, 'det-small');
    let rects = await time('Line detection', () => detectLines(env.ort, det, img, { maxSide: opts.detSide }));

    // Straighten: the median angle of the long lines; boxes are turned with the page instead of detecting again
    const angles = rects.filter((r) => r.w > 4 * r.h).map((r) => r.angle).sort((a, b) => a - b);
    const rough = angles.length >= 3 ? angles[angles.length >> 1] : 0;
    // The line boxes come from a coarse map; the projection profile pins the angle down to 0.05°
    const angle = angles.length >= 3 ? refineSkew(img, rough) : 0;
    if (Math.abs(angle) > (0.2 * Math.PI) / 180) {
      skew = (angle * 180) / Math.PI;
      const src = img;
      img = await time('Straightening', () => rotate(src, -angle));
      rects = rects.map((r) => {
        const [cx, cy] = rotatePoint(r.cx, r.cy, img.width, img.height, -angle);
        return { ...r, cx, cy, angle: r.angle - angle };
      });
    }

    const rec = await loadModel(env, 'rec-small');
    const res = await time('Recognition', () => recognize(env.ort, rec, img, rects));
    const page = img;
    await layout(page);
    // Formulas and drawings read badly with any model; they must not start a search through other scripts
    const skip = regions.filter((r) => ['formula', 'image', 'chart', 'seal'].includes(r.label));
    const inside = rects.map((r) => {
      const b = rectBox(r);
      return skip.some((s) => Math.min(s.x1, b.x1) - Math.max(s.x0, b.x0) > 0.5 * (b.x1 - b.x0) && Math.min(s.y1, b.y1) - Math.max(s.y0, b.y0) > 0.5 * (b.y1 - b.y0));
    });
    await time('Other scripts', () => otherScripts(env, page, rects, res, opts.scripts, scriptsUsed, progress, inside));
    let recognized = rects
      .map((r, i) => {
        const box = rectBox(r);
        const chars = res[i].pos && [...res[i].text].length === res[i].pos!.length ? res[i].pos!.map((f) => box.x0 + f * (box.x1 - box.x0)) : undefined;
        const charConf = res[i].probs && res[i].probs!.length === [...res[i].text].length ? res[i].probs : undefined;
        return { ...box, text: res[i].text, conf: res[i].conf, script: res[i].script ?? 'main', chars, charConf, nbest: res[i].nbest, steps: res[i].steps } as Line;
      })
      .filter((l) => l.text.trim());
    if (opts.correct) {
      const found = recognized;
      recognized = await time('Correction', async () => {
        const lang = wordListLanguage(found.map((l) => l.text).join(' '));
        if (!lang) return found;
        const dict = await loadDictionary(env, lang);
        // With word pairs for the language: choose among the readings and word variants; otherwise the word list
        const lm = await loadLanguageModel(env, lang, dict);
        if (!lm) return (await correctLines(found, dict)).lines;
        const page = pageWords(found.map((l) => l.text));
        const para = found.some((l) => l.nbest?.some((r) => r.text.includes('§')));
        // Top to bottom, each line with the context of the line right above it in the same column
        const order = found.map((_, i) => i).sort((a, b) => found[a].y0 - found[b].y0);
        const out = found.slice();
        const after = new Map<number, LineContext>();
        for (const i of order) {
          const l = found[i];
          const above = lineAbove(found, i);
          const ctx = above >= 0 ? after.get(above) ?? LINE_START : LINE_START;
          const nbest = researchLine(lm, l);
          const text = fixNumbers(nbest?.length ? decodeLine(lm, page, nbest, DECODE_DEFAULTS, ctx) : l.text, para);
          after.set(i, contextAfter(text));
          // Character positions and probabilities belong to the top reading; only kept where the text stayed
          if (text !== l.text) out[i] = { ...l, text, chars: undefined, charConf: undefined };
        }
        return out;
      });
    }
    lines = recognized;
  }

  const page = img;
  for (const l of lines) l.style = lineStyle(page, l);
  if (textLines) await layout(page);
  const tables = await time('Tables', () => findTables(env, page, regions, lines, opts));
  const doc = await time('Assembling', () => assemble(lines, regions, tables, { columns: opts.columns, pageWidth: page.width, pageHeight: page.height }));
  for (const b of walk(doc.blocks)) if (b.type === 'image') b.img = crop(page, b.box);
  const header = opts.headerFooter ? doc.header : [], footer = opts.headerFooter ? doc.footer : [];
  return { img, blocks: doc.blocks, header, footer, lines, regions, tables, flattened, turned, skew, timings, scriptsUsed: [...scriptsUsed] };
}

// ---------- Correction ----------

/** The page's language, if there is a word list for it */
export function wordListLanguage(text: string): string | null {
  const letters = text.replace(/[^\p{L}]/gu, '').length;
  if (letters < 10) return null;
  // Short texts (a single line) are told apart only among the big languages, which franc gets right about nine times
  // in ten there; on all 19 it guesses
  const only = letters >= 40 ? Object.keys(FRANC_TO_DICT) : ['deu', 'eng', 'spa', 'fra', 'ita', 'por', 'nld', 'pol'];
  const best = francAll(text, { only, minLength: 5 })[0]?.[0];
  return (best && FRANC_TO_DICT[best]) ?? null;
}

const dictionaries = new Map<string, Promise<Dictionary>>();
function loadDictionary(env: Env, lang: string): Promise<Dictionary> {
  let d = dictionaries.get(lang);
  if (!d) {
    d = env.fetchBytes(DICTIONARIES[lang]).then((b) => buildDictionary(new TextDecoder().decode(b)));
    d.catch(() => dictionaries.delete(lang));
    dictionaries.set(lang, d);
  }
  return d;
}

/** The line right above line i in the same column (overlapping it sideways, at most a line height away), or -1 */
function lineAbove(lines: Line[], i: number): number {
  const l = lines[i], h = l.y1 - l.y0;
  let best = -1, gap = Infinity;
  lines.forEach((o, j) => {
    if (j === i || o.y1 > l.y0 + 0.3 * h) return;
    const overlap = Math.min(o.x1, l.x1) - Math.max(o.x0, l.x0);
    const g = l.y0 - o.y1;
    if (overlap > 0.3 * Math.min(o.x1 - o.x0, l.x1 - l.x0) && g < 1.2 * h && g < gap) { gap = g; best = j; }
  });
  return best;
}

/** Word pairs, triples and single words of a language (ocr/lang, from scripts/build-ocr-data.mjs), if it has them */
const languageModels = new Map<string, Promise<LanguageModel | null>>();
function loadLanguageModel(env: Env, lang: string, dict: Dictionary): Promise<LanguageModel | null> {
  let m = languageModels.get(lang);
  if (!m) {
    const text = (b: Uint8Array) => new TextDecoder().decode(b);
    m = !LANGUAGE_DATA.includes(lang) ? Promise.resolve(null)
      : Promise.all(['words', 'pairs', 'triples'].map((k) => env.fetchBytes(`ocr/lang/${lang}.${k}.tsv.gz`)))
        .then(([u, p, t]) => buildLanguageModel(dict, text(u), text(p), text(t)), () => null);
    languageModels.set(lang, m);
  }
  return m;
}

// ---------- Orientation ----------

/** PP-LCNet page orientation: 0/90/180/270; returns the clockwise quarter turns that make the page upright. */
async function orientation(env: Env, img: Img): Promise<number> {
  const m = await loadModel(env, 'orientation');
  // Resize the short side to 256, then the centre 224 × 224
  const s = 256 / Math.min(img.width, img.height);
  const r = resize(img, Math.round(img.width * s), Math.round(img.height * s));
  const x0 = Math.floor((r.width - 224) / 2), y0 = Math.floor((r.height - 224) / 2);
  const c = crop(r, { x0, y0, x1: x0 + 224, y1: y0 + 224 });
  const input = toCHW(c, [0.485, 0.456, 0.406], [0.229, 0.224, 0.225], 1 / 255, false);
  const out = await m.session.run({ [m.session.inputNames[0]]: new env.ort.Tensor('float32', input, [1, 3, 224, 224]) });
  const p = Array.from(out[m.session.outputNames[0]].data as Float32Array);
  const best = p.indexOf(Math.max(...p));
  // Label k: the content is turned k·90° clockwise, so k quarter turns back; only when the model is sure
  if (best === 0 || p[best] < 0.8) return 0;
  return (4 - best) % 4;
}

// ---------- Other scripts ----------

const SCRIPT_RE: Record<ScriptKey, RegExp> = { cyrillic: /\p{Script=Cyrillic}/u, greek: /\p{Script=Greek}/u };

/** The main model reads Latin, Chinese and Japanese; for other scripts it returns little or with low confidence. */
function uncertain(r: RotRect, res: RecResult): boolean {
  const chars = res.text.replace(/\s/g, '').length;
  // Short pieces (a number, a single word) are too little to judge
  // Lines in another script come out empty or as stray signs; handwriting the main model is unsure about still
  // yields mostly Latin letters, and is no reason to download other scripts
  const latin = (res.text.match(/[A-Za-zÀ-ɏ]/g) ?? []).length;
  return r.h >= 10 && r.w / r.h >= 2.5 && (res.conf < 0.9 || chars < 0.5 * (r.w / r.h)) && latin < 0.3 * (r.w / r.h);
}

/** Share of letters in the given script: a recognizer counts only if it really read its own script. */
function scriptShare(text: string, re: RegExp): number {
  const letters = [...text].filter((c) => /\p{L}/u.test(c));
  return letters.length ? letters.filter((c) => re.test(c)).length / letters.length : 0;
}

async function otherScripts(
  env: Env, img: Img, rects: RotRect[], res: (RecResult & { script?: string })[],
  setting: PipelineOptions['scripts'], used: Set<string>, progress: Progress, skip: boolean[],
): Promise<void> {
  res.forEach((r) => (r.script ??= 'main'));
  if (setting === 'off') return;
  let open = rects.map((_, i) => i).filter((i) => !skip[i] && uncertain(rects[i], res[i]));
  // Automatic search only when there is real text the main model failed on, not one doubtful word
  const expected = open.reduce((n, i) => n + rects[i].w / rects[i].h, 0);
  if (!open.length || (setting === 'auto' && expected < 15)) return;
  const candidates = (setting === 'auto' ? Object.keys(SCRIPTS) : setting) as ScriptKey[];
  for (const key of candidates) {
    if (!open.length) break;
    progress(`Other scripts: ${SCRIPTS[key].label}`);
    const model = await loadModel(env, SCRIPTS[key].model as ModelKey);
    const tried = await recognize(env.ort, model, img, open.map((i) => rects[i]));
    open.forEach((i, k) => {
      const t = tried[k];
      if (t.conf >= 0.85 && t.conf > res[i].conf - 0.05 && scriptShare(t.text, SCRIPT_RE[key]) >= 0.5) {
        res[i] = { ...t, script: key };
        used.add(key);
      }
    });
    open = open.filter((i) => res[i].script === 'main');
  }
  // Short lines (the end of a paragraph) were left out above: when the line just above was read in another
  // script and this one yielded at most one letter, read it with that script too
  if (!used.size) return;
  const byKey = new Map<ScriptKey, number[]>();
  rects.forEach((r, i) => {
    if (res[i].script !== 'main' || r.w / r.h >= 2.5 || res[i].text.replace(/[^\p{L}]/gu, '').length > 1) return;
    const above = rects.findIndex((a, j) => res[j].script !== 'main' && r.cy - a.cy > 0 && r.cy - a.cy < 1.8 * a.h
      && Math.abs(r.cx - r.w / 2 - (a.cx - a.w / 2)) < 2 * a.h);
    if (above >= 0) byKey.set(res[above].script as ScriptKey, [...(byKey.get(res[above].script as ScriptKey) ?? []), i]);
  });
  for (const [key, idx] of byKey) {
    const tried = await recognize(env.ort, await loadModel(env, SCRIPTS[key].model as ModelKey), img, idx.map((i) => rects[i]));
    idx.forEach((i, k) => {
      if (tried[k].conf >= 0.85 && scriptShare(tried[k].text, SCRIPT_RE[key]) >= 0.5) res[i] = { ...tried[k], script: key };
    });
  }
}

// ---------- Tables ----------

async function findTables(env: Env, img: Img, regions: Region[], lines: Line[], opts: PipelineOptions): Promise<TableGrid[]> {
  // Grids in drawings are dropped later, when most of their cells stay empty (the layout model also calls
  // coloured tables pictures, so its pictures are no guide here)
  const tables = findRuledTables(img);
  // A grid with many merged cells is often a broken one (faint or bowed rules in a photo): ask the table model
  // too and keep its structure when it finds the same columns with fewer merges
  // (a title row across the whole width is a normal merge and does not count)
  const merged = (t: TableGrid) => t.cells.filter((c) => (c.rowSpan > 1 || c.colSpan > 1) && c.colSpan < t.cols).length / t.cells.length;
  if (opts.tableModel) {
    for (let i = 0; i < tables.length; i++) {
      const t = tables[i];
      if (merged(t) <= 0.06) continue;
      const p = await predictTable(env.ort, await loadModel(env, 'table'), img, { x0: t.x0 - 4, y0: t.y0 - 4, x1: t.x1 + 4, y1: t.y1 + 4 });
      if (!p || p.cols < t.cols - 1 || merged(p) >= merged(t)) continue;
      // Same columns: the vertical rules give the exact column borders, better than the model's cell boxes
      if (p.cols === t.cols && t.xs) {
        const xs = t.xs;
        p.cells = p.cells.map((c) => ({ ...c, x0: xs[c.col], x1: xs[c.col + c.colSpan] }));
        p.xs = xs;
      }
      tables[i] = { ...p, ruled: true };
    }
  }
  for (const r of regions.filter((r) => r.label === 'table')) {
    // A grid already covers this region
    if (tables.some((t) => overlapShare(t, r) > 0.5)) continue;
    let grid: TableGrid | null = null;
    if (opts.tableModel) grid = await predictTable(env.ort, await loadModel(env, 'table'), img, r);
    const inside = lines.filter((l) => overlapShare(l, r) > 0.5);
    // Model result without structure worth the name: fall back to columns from the text positions
    if (!grid || grid.cells.length < 2) grid = columnsFromPieces(inside, r);
    if (grid) tables.push(grid);
  }
  return tables;
}

function overlapShare(a: { x0: number; y0: number; x1: number; y1: number }, b: typeof a): number {
  const w = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), h = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.min((a.x1 - a.x0) * (a.y1 - a.y0), (b.x1 - b.x0) * (b.y1 - b.y0));
}
