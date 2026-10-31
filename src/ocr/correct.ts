// SPDX-License-Identifier: GPL-3.0-or-later
// Post-correction of recognized text: words the dictionary does not know get candidates within two edits, weighted
// by typical OCR confusions (r/n, rn/m, l/I …) and word frequency. Optionally a language model picks among the
// candidates in their sentence. German compounds of two known words count as known.

export interface Dictionary {
  /** lower-case word → frequency score (log of the count) */
  freq: Map<string, number>;
  /** words reachable by deleting one character → the words */
  deletes: Map<string, string[]>;
}

/** From a frequency list ("word count" per line, most frequent first) */
export function buildDictionary(list: string, max = 50000): Dictionary {
  const freq = new Map<string, number>();
  const deletes = new Map<string, string[]>();
  for (const line of list.split('\n').slice(0, max)) {
    const [w, c] = line.trim().split(/\s+/);
    if (!w || !/^[\p{L}'-]+$/u.test(w)) continue;
    const word = w.toLowerCase();
    if (freq.has(word)) continue;
    freq.set(word, Math.log(Number(c) || 1));
    for (const d of oneDeletes(word)) {
      const list = deletes.get(d);
      if (list) list.push(word); else deletes.set(d, [word]);
    }
  }
  return { freq, deletes };
}

function oneDeletes(w: string): Set<string> {
  const out = new Set<string>([w]);
  for (let i = 0; i < w.length; i++) out.add(w.slice(0, i) + w.slice(i + 1));
  return out;
}

export function known(dict: Dictionary, word: string): boolean {
  const w = word.toLowerCase();
  if (dict.freq.has(w)) return true;
  // Compounds: two known parts of at least 3 letters, maybe with a linking s ("Arbeits|zylinder")
  for (let i = 3; i <= w.length - 3; i++) {
    const a = w.slice(0, i), b = w.slice(i);
    if ((dict.freq.has(a) || (a.endsWith('s') && dict.freq.has(a.slice(0, -1)))) && dict.freq.has(b)) return true;
  }
  return false;
}

/** Characters OCR mixes up (both directions); a swap between them costs less than an ordinary edit */
const SIMILAR = ['rn', 'nu', 'mn', 'ec', 'li', 'il', 'ao', 'au', 'uü', 'aä', 'oö', 'hb', 'vw', 'ij', 'ft', 'ce', 'cr', 'ad', 'ue', 'ei', 'ir'];
const similar = new Set(SIMILAR.flatMap((p) => [p, p[1] + p[0]]));

/** Weighted edit distance (with transpositions); "rn"↔"m" and "m"↔"rn" count as one cheap edit */
export function ocrDistance(a: string, b: string): number {
  const n = a.length, m = b.length;
  const d: number[][] = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: m + 1 }, (_, j) => (i ? (j ? 0 : i) : j)));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const sub = a[i - 1] === b[j - 1] ? 0 : sameBase(a[i - 1], b[j - 1]) ? 0.25 : similar.has(a[i - 1] + b[j - 1]) ? 0.5 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + sub);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      if (i > 1 && a.slice(i - 2, i) === 'rn' && b[j - 1] === 'm') v = Math.min(v, d[i - 2][j - 1] + 0.5);
      if (j > 1 && b.slice(j - 2, j) === 'rn' && a[i - 1] === 'm') v = Math.min(v, d[i - 1][j - 2] + 0.5);
      d[i][j] = v;
    }
  }
  return d[n][m];
}

/** Same letter with or without an accent (í/i, é/e): OCR adds and drops those easily */
function sameBase(x: string, y: string): boolean {
  const bx = x.normalize('NFD')[0], by = y.normalize('NFD')[0];
  return bx === by && /\p{L}/u.test(bx);
}

export interface Candidate { word: string; cost: number; score: number }

/** Dictionary words within two edits of a word, best first */
export function candidates(dict: Dictionary, word: string, maxCost = 2): Candidate[] {
  const w = word.toLowerCase();
  const seen = new Set<string>();
  for (const d1 of oneDeletes(w)) {
    for (const d of [d1, ...(w.length > 4 ? oneDeletes(d1) : [])]) {
      for (const c of dict.deletes.get(d) ?? []) seen.add(c);
    }
  }
  const out: Candidate[] = [];
  for (const c of seen) {
    if (Math.abs(c.length - w.length) > 2) continue;
    const cost = ocrDistance(w, c);
    if (cost > maxCost || (w.length <= 4 && cost > 1)) continue;
    out.push({ word: c, cost, score: dict.freq.get(c)! - 4 * cost });
  }
  return out.sort((a, b) => b.score - a.score);
}

export interface CorrectOptions {
  /** Highest edit cost for words the recognizer was fairly sure about */
  maxCostConfident: number;
  /** Highest edit cost for unsure words (handwriting) */
  maxCostUnsure: number;
  /** A word whose least sure character reaches this probability is left alone (an unknown name or term) */
  confident: number;
  /** Below this the word counts as unsure */
  unsure: number;
  /** Choose among the candidates with a language model: score of a whole line (higher is better) */
  rerank?: (variants: string[]) => Promise<number[]>;
}

export const CORRECT_DEFAULTS: CorrectOptions = { maxCostConfident: 1, maxCostUnsure: 2, confident: 0.9, unsure: 0.6 };

/** Corrects the text of lines in place of new ones; returns how many words changed. */
export async function correctLines<T extends { text: string; conf: number; charConf?: number[] }>(lines: T[], dict: Dictionary, opts: CorrectOptions = CORRECT_DEFAULTS): Promise<{ lines: T[]; changed: number }> {
  let changed = 0;
  const out: T[] = [];
  for (const l of lines) {
    const parts = l.text.split(/([\p{L}]+(?:[-'’][\p{L}]+)*)/u);
    // Words to fix, with their candidates: only words with an unsure character (from the recognizer); without
    // character probabilities (a PDF text layer) the line's confidence decides
    const slots: { i: number; cands: Candidate[] }[] = [];
    let at = 0;
    parts.forEach((p, i) => {
      const start = at;
      at += [...p].length;
      if (i % 2 === 0 || p.length < 3 || /['’]/.test(p) || known(dict, p) || /^\p{Lu}+$/u.test(p) && p.length <= 4) return;
      const sure = l.charConf ? Math.min(...l.charConf.slice(start, start + [...p].length)) : l.conf;
      if (sure >= opts.confident) return;
      const cands = candidates(dict, p, sure < opts.unsure ? opts.maxCostUnsure : opts.maxCostConfident);
      if (cands.length) slots.push({ i, cands });
    });
    for (const s of slots) {
      let pick = s.cands[0];
      if (opts.rerank && s.cands.length > 1) {
        const top = s.cands.slice(0, 5);
        const variants = top.map((c) => parts.map((p, i) => (i === s.i ? keepCase(p, c.word) : p)).join(''));
        const lm = await opts.rerank(variants);
        // The language model decides, the dictionary score breaks near ties
        const best = top.map((c, k) => ({ c, v: lm[k] + 0.3 * c.score })).sort((a, b) => b.v - a.v)[0];
        pick = best.c;
      }
      parts[s.i] = keepCase(parts[s.i], pick.word);
      changed++;
    }
    out.push({ ...l, text: parts.join('') });
  }
  return { lines: out, changed };
}

/**
 * Takes a corrector's rewrite of a line only word by word: where the rewrite has the same number of words, a word
 * the recognizer was unsure about may become the rewrite's word if the two are close (OCR distance at most 2).
 * Punctuation, casing of sure words and anything the rewrite added or dropped stay as recognized.
 */
export function guardedMerge<T extends { text: string; conf: number; charConf?: number[] }>(line: T, rewrite: string, opts: CorrectOptions = CORRECT_DEFAULTS): T {
  const parts = line.text.split(/([\p{L}]+(?:[-'’][\p{L}]+)*)/u);
  const theirs = rewrite.match(/[\p{L}]+(?:[-'’][\p{L}]+)*/gu) ?? [];
  const mine = parts.filter((_, i) => i % 2 === 1);
  if (theirs.length !== mine.length) return line;
  let at = 0, w = 0;
  const out = parts.map((p, i) => {
    const start = at;
    at += [...p].length;
    if (i % 2 === 0) return p;
    const t = theirs[w++];
    if (t.toLowerCase() === p.toLowerCase()) return p;
    const sure = line.charConf ? Math.min(...line.charConf.slice(start, start + [...p].length)) : line.conf;
    if (sure >= opts.confident || ocrDistance(p.toLowerCase(), t.toLowerCase()) > 2) return p;
    return keepCase(p, t.toLowerCase());
  });
  return { ...line, text: out.join('') };
}

/** The candidate in the original's capitalisation (Capitalised or UPPER) */
function keepCase(orig: string, word: string): string {
  if (orig === orig.toUpperCase() && orig.length > 1) return word.toUpperCase();
  if (orig[0] === orig[0].toUpperCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}
