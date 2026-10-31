// SPDX-License-Identifier: GPL-3.0-or-later
// Choosing the words of a line with what is known about the language, the same way for every language that has
// data: word pairs (which word follows which), single words, and a model of letter sequences for words no list
// knows (names, compounds). The candidates of a line are the recognizer's readings (n-best) and, for each word,
// variants by typical handwriting confusions (n/r, missing accents, a dropped letter) that are real words.
// Words that recur on the page count as known, so names and abbreviations win over their misreadings.
import { candidates, known, ocrDistance, type Dictionary } from './correct';
import { searchSteps, type Reading, type Step } from './ctc';

// ---------- Letter sequences ----------

/** Probability of the next letter given the three before it, smoothed down to two, one and none */
export interface CharModel { counts: Map<string, number>; letters: number }

const ORDER = 4;
const BETA = 2;

/** From words (each counted once: what matters is which sequences words can have, not how often they are said) */
export function buildCharModel(words: Iterable<string>): CharModel {
  const counts = new Map<string, number>();
  const letters = new Set<string>();
  for (const w of words) {
    const s = '^'.repeat(ORDER - 1) + w + '$';
    for (const ch of w) letters.add(ch);
    for (let i = ORDER - 1; i < s.length; i++) {
      for (let n = 0; n < ORDER; n++) {
        const h = s.slice(i - n, i);
        counts.set(h + '\u0001' + s[i], (counts.get(h + '\u0001' + s[i]) ?? 0) + 1);
        counts.set(h, (counts.get(h) ?? 0) + 1);
      }
    }
  }
  return { counts, letters: letters.size + 1 };
}

function charProb(m: CharModel, h: string, c: string): number {
  let p = 1 / m.letters;
  for (let n = 0; n <= h.length; n++) {
    const hh = h.slice(h.length - n);
    p = ((m.counts.get(hh + '\u0001' + c) ?? 0) + BETA * p) / ((m.counts.get(hh) ?? 0) + BETA);
  }
  return p;
}

/**
 * For the beam search: the letter model's score of appending c to a reading, relative to a letter picked at random
 * (so letters that fit raise a reading, letters no word has there lower it); a space or sign after a word adds how
 * well the word can end there. weight scales it against the recognizer.
 */
export function letterScorer(m: CharModel, weight: number): (text: string, c: string) => number {
  const uniform = Math.log(1 / m.letters);
  return (text, c) => {
    const word = (/\p{L}+$/u.exec(text)?.[0] ?? '').toLowerCase();
    const h = ('^'.repeat(ORDER - 1) + word).slice(-(ORDER - 1));
    if (/\p{L}/u.test(c)) return weight * (Math.log(charProb(m, h, c.toLowerCase())) - uniform);
    return word ? weight * Math.log(charProb(m, h, '$')) : 0;
  };
}

/** log P of a whole word under the letter model, end included */
export function charLogP(m: CharModel, w: string): number {
  const s = '^'.repeat(ORDER - 1) + w + '$';
  let lp = 0;
  for (let i = ORDER - 1; i < s.length; i++) lp += Math.log(charProb(m, s.slice(i - ORDER + 1, i), s[i]));
  return lp;
}

// ---------- Words ----------

export interface LanguageModel {
  dict: Dictionary;
  /** word → count, and their sum */
  uni: Map<string, number>;
  total: number;
  /** "a b" → count; a → count of all pairs starting with a; "<s>" starts a line */
  pairs: Map<string, number>;
  follow: Map<string, number>;
  /** "a b c" → count, and "a b" → count of all triples starting with it (empty without triple data) */
  triples: Map<string, number>;
  followPair: Map<string, number>;
  /** Usual spelling of a word (lower case → "Kennzeichen", "the") */
  forms: Map<string, string>;
  chars: CharModel;
}

/** From the single words, pairs and triples (tab-separated, as scripts/build-ocr-data.mjs writes them) and the word list */
export function buildLanguageModel(dict: Dictionary, uniText: string, pairText: string, tripleText = ''): LanguageModel {
  const uni = new Map<string, number>(), forms = new Map<string, string>();
  let total = 0;
  for (const line of uniText.split('\n')) {
    const [w, c, form] = line.split('\t');
    if (!w || !c) continue;
    uni.set(w, Number(c));
    total += Number(c);
    if (form && form !== w) forms.set(w, form);
  }
  const triples = new Map<string, number>(), followPair = new Map<string, number>();
  for (const line of tripleText.split('\n')) {
    const [a, b, c, n] = line.split('\t');
    if (!n) continue;
    triples.set(a + ' ' + b + ' ' + c, Number(n));
    followPair.set(a + ' ' + b, (followPair.get(a + ' ' + b) ?? 0) + Number(n));
  }
  const pairs = new Map<string, number>(), follow = new Map<string, number>();
  for (const line of pairText.split('\n')) {
    const [a, b, c] = line.split('\t');
    if (!c) continue;
    pairs.set(a + ' ' + b, Number(c));
    follow.set(a, (follow.get(a) ?? 0) + Number(c));
  }
  const words = new Set<string>(dict.freq.keys());
  for (const [w, c] of uni) if (c >= 3 && /^\p{L}+$/u.test(w)) words.add(w);
  return { dict, uni, total, pairs, follow, triples, followPair, forms, chars: buildCharModel(words) };
}

export interface DecodeOptions {
  /** Weight of the recognizer's log-probability against the language */
  ocr: number;
  /** Cost of one confusion edit (n/r …), in log-probability units; accents cost half, other edits double */
  edit: number;
  /** Extra cost of a word no list knows, on top of its letter-model probability */
  unknown: number;
  /**
   * Lines the recognizer is this sure about (log-probability per character of its top reading) keep their words;
   * only its other readings compete. Print lands above it almost always (76 % of print lines, 4 % of handwriting
   * in the tests): there a word no list knows is a term or name, not a misreading.
   */
  sure: number;
  /**
   * Bonus per word of a reading: every word costs language probability, so without it readings that drop a word
   * (a single letter, a symbol) would win
   */
  word: number;
  /** Use word triples where the data has them */
  triples: boolean;
  /** Write chosen variants as the language usually does (nouns capitalised in German …) */
  casing: boolean;
  /**
   * Weight of the letter model when an unsure line is searched again (0: not searched again). Helped pages of
   * handwriting a lot (German +6, English +3 words in 100), single lines slightly less, print not at all
   */
  letters: number;
}

// Chosen on public handwriting datasets, checked on print and on handwriting in eight languages
export const DECODE_DEFAULTS: DecodeOptions = { ocr: 1, edit: 5, unknown: 3, sure: -0.01, word: 3, triples: true, casing: false, letters: 0.3 };

/** Words of the page seen at least twice (lower case → count): names, terms and abbreviations of this document */
export function pageWords(texts: string[]): Map<string, number> {
  const count = new Map<string, number>();
  for (const t of texts) for (const w of t.match(/\p{L}{2,}/gu) ?? []) count.set(w.toLowerCase(), (count.get(w.toLowerCase()) ?? 0) + 1);
  for (const [w, c] of count) if (c < 2) count.delete(w);
  return count;
}

const UNI_FLOOR = 1e-8;

function isKnown(lm: LanguageModel, page: Map<string, number>, w: string): boolean {
  return lm.uni.has(w) || page.has(w) || known(lm.dict, w);
}

/** The part of a word's score that does not depend on the word before: computed once per word and page */
interface WordInfo { known: boolean; uni: number; alone: number }
const infoCache = new WeakMap<Map<string, number>, Map<string, WordInfo>>();

function wordInfo(lm: LanguageModel, page: Map<string, number>, w: string, o: DecodeOptions): WordInfo {
  let cache = infoCache.get(page);
  if (!cache) { cache = new Map(); infoCache.set(page, cache); }
  let i = cache.get(w);
  if (!i) {
    if (/^\d+$/.test(w)) i = { known: true, uni: 1e-4, alone: Math.log(1e-4) };
    else if (!isKnown(lm, page, w)) i = { known: false, uni: 0, alone: charLogP(lm.chars, w) - o.unknown };
    else {
      const uni = Math.max(UNI_FLOOR, (lm.uni.get(w) ?? (lm.dict.freq.has(w) ? 2 : 0)) / lm.total, page.has(w) ? 1e-4 : 0);
      i = { known: true, uni, alone: Math.log(0.4 * uni) };
    }
    cache.set(w, i);
  }
  return i;
}

/** log P(w | prev): word pairs where seen, single words, the page's own words, else the letter model */
function wordLogP(lm: LanguageModel, page: Map<string, number>, prev2: string, prev: string, w: string, o: DecodeOptions): number {
  const i = wordInfo(lm, page, w, o);
  if (!i.known || /^\d+$/.test(w)) return i.alone;
  const f = lm.follow.get(prev);
  const pair = f ? lm.pairs.get(prev + ' ' + w) : undefined;
  const pb = pair ? pair / f! : 0;
  const fp = o.triples ? lm.followPair.get(prev2 + ' ' + prev) : undefined;
  const triple = fp ? lm.triples.get(prev2 + ' ' + prev + ' ' + w) : undefined;
  if (triple) return Math.log(0.5 * triple / fp! + 0.3 * pb + 0.2 * i.uni);
  return pair ? Math.log(0.6 * pb + 0.4 * i.uni) : i.alone;
}

// ---------- Variants of a word ----------

/** Letters handwriting (and OCR) mixes up, both directions; a swap costs one edit */
const CONFUSE: [string, string][] = [['n', 'r'], ['n', 'u'], ['u', 'v'], ['a', 'o'], ['e', 'c'], ['r', 'v'], ['i', 'l'], ['h', 'k'], ['h', 'b'], ['t', 'f'], ['l', 't'], ['e', 'i'], ['a', 'e'], ['g', 'q'], ['m', 'n'], ['c', 'o']];
const swaps = new Map<string, string[]>();
for (const [a, b] of CONFUSE) {
  swaps.set(a, [...(swaps.get(a) ?? []), b]);
  swaps.set(b, [...(swaps.get(b) ?? []), a]);
}
/** Letters most often lost in fast writing */
const DROPPED = ['r', 'n', 'e', 'i', 'l', 't'];
/** Several letters for one and back ("rn" for "m"): one edit */
const MULTI: [string, string][] = [['rn', 'm'], ['ii', 'u'], ['cl', 'd'], ['nn', 'm'], ['in', 'm'], ['ri', 'n'], ['c', 'ck'], ['li', 'h']];

/** Letters of the language with an accent, by their base letter (from the word list: é è ê for e in French …) */
const accentCache = new WeakMap<LanguageModel, Map<string, string[]>>();
function accents(lm: LanguageModel): Map<string, string[]> {
  let m = accentCache.get(lm);
  if (!m) {
    m = new Map();
    const seen = new Set<string>();
    for (const w of lm.dict.freq.keys()) for (const ch of w) seen.add(ch);
    for (const ch of seen) {
      const base = ch.normalize('NFD')[0];
      if (base !== ch && /\p{L}/u.test(base)) m.set(base, [...(m.get(base) ?? []), ch]);
    }
    // And back: an accented letter may be wrong as well
    for (const [base, list] of [...m]) for (const a of list) m.set(a, [base, ...list.filter((x) => x !== a)]);
    accentCache.set(lm, m);
  }
  return m;
}

/** One cheap edit away: confusions, accents, a dropped or an extra letter, multi-letter confusions; with costs */
function edits1(lm: LanguageModel, w: string): Map<string, number> {
  const out = new Map<string, number>();
  const put = (v: string, c: number) => { if (v && v !== w && (out.get(v) ?? Infinity) > c) out.set(v, c); };
  const acc = accents(lm);
  const chars = [...w];
  for (let i = 0; i < chars.length; i++) {
    const pre = chars.slice(0, i).join(''), post = chars.slice(i + 1).join('');
    for (const s of swaps.get(chars[i]) ?? []) put(pre + s + post, 1);
    for (const s of acc.get(chars[i]) ?? []) put(pre + s + post, 0.5);
    put(pre + post, 1.5);
  }
  for (let i = 0; i <= chars.length; i++) {
    const pre = chars.slice(0, i).join(''), post = chars.slice(i).join('');
    for (const d of DROPPED) put(pre + d + post, 1);
  }
  for (const [a, b] of MULTI) {
    for (const [x, y] of [[a, b], [b, a]]) {
      for (let i = w.indexOf(x); i >= 0; i = w.indexOf(x, i + 1)) put(w.slice(0, i) + y + w.slice(i + x.length), 1);
    }
  }
  return out;
}

/** Known words within two cheap edits (or the word list's general candidates), each with its edit cost */
const variantCache = new WeakMap<Map<string, number>, Map<string, Map<string, number>>>();

function variants(lm: LanguageModel, page: Map<string, number>, w: string): Map<string, number> {
  let cache = variantCache.get(page);
  if (!cache) { cache = new Map(); variantCache.set(page, cache); }
  const hit = cache.get(w);
  if (hit) return hit;
  const found = new Map<string, number>();
  // Two edits away only words a list or the page has as they are (the compound check is too slow for thousands)
  const quick = (v: string) => lm.uni.has(v) || page.has(v) || lm.dict.freq.has(v);
  const take = (v: string, c: number, full = true) => { if ((full ? isKnown(lm, page, v) : quick(v)) && (found.get(v) ?? Infinity) > c) found.set(v, c); };
  const one = edits1(lm, w);
  for (const [v, c] of one) take(v, c);
  if (w.length >= 4) for (const [v, c] of one) if (c <= 1) for (const [v2, c2] of edits1(lm, v)) if (c2 <= 1) take(v2, c + c2, false);
  for (const c of candidates(lm.dict, w, 2)) take(c.word, 2 * c.cost);
  // The page's own words, within an ordinary edit distance of 1.5
  for (const p of page.keys()) if (Math.abs(p.length - w.length) <= 2 && p !== w) { const d = ocrDistance(w, p); if (d <= 1.5) take(p, d); }
  cache.set(w, found);
  return found;
}

// ---------- Lines ----------

interface Token { text: string; word: boolean }

function tokenize(line: string): Token[] {
  return line.split(/(\p{L}+(?:['’-]\p{L}+)*|\d+)/u).filter((t) => t !== '').map((t) => ({ text: t, word: /^[\p{L}\d]/u.test(t) }));
}

/** A chosen variant in the original's capitals where it was in capitals or starts the line, else as usually written */
function caseLike(lm: LanguageModel, orig: string, word: string, first: boolean, o: DecodeOptions): string {
  const form = o.casing ? lm.forms.get(word) : undefined;
  if (!form || (orig.length > 1 && orig === orig.toUpperCase())) return keepCase(orig, word);
  return first && orig[0] !== orig[0].toLowerCase() ? form[0].toUpperCase() + form.slice(1) : form;
}

function keepCase(orig: string, word: string): string {
  if (orig.length > 1 && orig === orig.toUpperCase()) return word.toUpperCase();
  if (orig[0] !== orig[0].toLowerCase()) return word[0].toUpperCase() + word.slice(1);
  return word;
}

/** What a line hands to the next: its last two words, or the start of a word broken with a hyphen at its end */
export interface LineContext { prev2: string; prev: string; carry?: string }

export const LINE_START: LineContext = { prev2: '<s>', prev: '<s>' };

/** The context the next line starts with, from the chosen text of this one */
export function contextAfter(text: string): LineContext {
  const words = (text.match(/\p{L}+(?:['’-]\p{L}+)*|\d+/gu) ?? []).map((w) => w.toLowerCase());
  const broken = /(\p{L}+)-\s*$/u.exec(text);
  if (broken) {
    const before = words.slice(0, -1);
    return { prev2: before[before.length - 2] ?? '<s>', prev: before[before.length - 1] ?? '<s>', carry: broken[1].toLowerCase() };
  }
  return { prev2: words[words.length - 2] ?? '<s>', prev: words[words.length - 1] ?? '<s>' };
}

/**
 * The best line: over the readings, and per word over its variants, the most likely by recognizer and language
 * together (Viterbi over the words with word pairs and triples). The line before gives the context of the first
 * words; the start of a word broken at its end is judged together with the rest at the start of this line
 * ("Anfech-" + "tung"). Returns the reading unchanged where nothing is better.
 */
export function decodeLine(lm: LanguageModel, page: Map<string, number>, readings: { text: string; logp: number }[], o: DecodeOptions = DECODE_DEFAULTS, ctx: LineContext = LINE_START): string {
  if (!readings.length) return '';
  const top = readings[0].logp;
  // A line the recognizer is sure about keeps its reading: on print the alternatives mostly drop symbols
  if (top / Math.max(1, readings[0].text.length) > o.sure) return readings[0].text;
  let best = readings[0].text, bestScore = -Infinity;
  for (const r of readings) {
    const tokens = tokenize(r.text);
    // Per word token: its options (text, key for the language model, cost); other tokens pass through
    type Opt = { text: string; key: string; cost: number; free?: boolean };
    const slots: Opt[][] = [];
    const where: number[] = [];
    const lastWord = tokens.reduce((a, t, i) => (t.word ? i : a), -1);
    const brokenEnd = lastWord >= 0 && /^-\s*$/.test(tokens.slice(lastWord + 1).map((t) => t.text).join(''));
    tokens.forEach((t, i) => {
      if (!t.word) return;
      const key = t.text.toLowerCase();
      const first = !slots.length;
      // The rest of a broken word: judged as the whole word, its variants only those that keep the start
      if (first && ctx.carry && /^\p{Ll}/u.test(t.text)) {
        const whole = ctx.carry + key;
        const opts: Opt[] = [{ text: t.text, key: whole, cost: 0 }];
        for (const [v, c] of variants(lm, page, whole)) if (v.startsWith(ctx.carry) && v.length > ctx.carry.length) opts.push({ text: v.slice(ctx.carry.length), key: v, cost: c * o.edit });
        slots.push(opts);
        where.push(i);
        return;
      }
      // The start of a word broken at the end of this line: left as it is, and without a language score
      if (i === lastWord && brokenEnd) {
        slots.push([{ text: t.text, key, cost: 0, free: true }]);
        where.push(i);
        return;
      }
      const opts: Opt[] = [{ text: t.text, key, cost: 0 }];
      if (/^\p{L}{2,}$/u.test(t.text) && !(isKnown(lm, page, key) && key.length <= 3)) {
        for (const [v, c] of variants(lm, page, key)) opts.push({ text: caseLike(lm, t.text, v, first, o), key: v, cost: c * o.edit });
      }
      slots.push(opts);
      where.push(i);
    });
    // Viterbi over the slots; the word before last comes from the best path into each option
    let prev = [{ score: 0, key: ctx.prev, key2: ctx.prev2, back: [] as number[] }];
    for (const opts of slots) {
      prev = opts.map((op, k) => {
        let bs = -Infinity, bp = 0;
        prev.forEach((p, j) => {
          const lp = op.free ? 0 : wordLogP(lm, page, p.key2, p.key, op.key, o);
          const s = p.score + lp - op.cost + o.word;
          if (s > bs) { bs = s; bp = j; }
        });
        return { score: bs, key: op.key, key2: prev[bp].key, back: [...prev[bp].back, k] };
      });
    }
    const end = prev.reduce((a, b) => (b.score > a.score ? b : a));
    const score = o.ocr * (r.logp - top) + end.score;
    if (score > bestScore) {
      bestScore = score;
      const out = tokens.map((t) => t.text);
      end.back.forEach((k, s) => (out[where[s]] = slots[s][k].text));
      best = out.join('');
    }
  }
  return best;
}

/** The readings of an unsure line searched again with the letter model in the search; sure lines keep theirs */
export function researchLine(lm: LanguageModel, line: { nbest?: Reading[]; steps?: Step[] }, o: DecodeOptions = DECODE_DEFAULTS): Reading[] | undefined {
  const top = line.nbest?.[0];
  if (!o.letters || !line.steps || !top || top.logp / Math.max(1, top.text.length) > o.sure) return line.nbest;
  return searchSteps(line.steps, { width: 32, n: 10, extend: letterScorer(lm.chars, o.letters) });
}

// ---------- Numbers ----------

/**
 * Digits misread as letters inside numbers (13g7 → 1397, 1O4 → 104), "§" where the page uses it and a "$" or "S"
 * stands before a number, and a space between a number and an abbreviation in capitals (100GB → 100 GB).
 */
export function fixNumbers(line: string, pageHasParagraph: boolean): string {
  let s = line.replace(/(?<=\d)[gq](?=\d)/g, '9').replace(/(?<=\d)[Oo](?=\d)/g, '0').replace(/(?<=\d)[lI](?=\d)/g, '1');
  if (pageHasParagraph) s = s.replace(/(^|[\s(])[$S](?=\s?\d)/g, '$1§');
  return s.replace(/(\d)(\p{Lu}{2,})\b/gu, '$1 $2');
}
