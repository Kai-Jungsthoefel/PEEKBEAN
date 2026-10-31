// SPDX-License-Identifier: GPL-3.0-or-later
// CTC prefix beam search: instead of the single most likely character per time step, the most likely whole readings
// of a line, each with its log-probability. Greedy decoding keeps one of them; a language model or word list can
// then choose among them (the n-best list). The search can also ask a letter model while it reads, so letter
// sequences no word of the language has fall back behind ones that look like words.

export interface Reading { text: string; logp: number }

/** One time step, reduced to what the search looks at: the blank and the most likely classes (id, character, p) */
export interface Step { blank: number; cands: [number, string, number][] }

/** The most likely classes of every step (class 0 = blank) */
export function topSteps(prob: (t: number, c: number) => number, T: number, C: number, chars: (c: number) => string,
  { perStep = 6, minProb = 0.005, allowed }: { perStep?: number; minProb?: number; allowed?: Uint8Array } = {}): Step[] {
  const steps: Step[] = [];
  for (let t = 0; t < T; t++) {
    let pool: [number, number][] = [];
    for (let c = 1; c < C; c++) {
      if (allowed && !allowed[c]) continue;
      const p = prob(t, c);
      if (p >= minProb) pool.push([c, p]);
    }
    pool.sort((a, b) => b[1] - a[1]);
    pool = pool.slice(0, perStep);
    steps.push({ blank: prob(t, 0), cands: pool.map(([c, p]) => [c, chars(c), p]) });
  }
  return steps;
}

export interface SearchOptions {
  /** Readings kept per step */
  width?: number;
  /** Readings returned */
  n?: number;
  /**
   * Log-score of appending character c to text (a letter model); added to the search's ranking only, the readings'
   * logp stays the recognizer's own
   */
  extend?: (text: string, c: string) => number;
}

/** The most likely readings from the reduced steps */
export function searchSteps(steps: Step[], { width = 16, n = 10, extend }: SearchOptions = {}): Reading[] {
  // Each prefix (as class sequence, joined) has a probability of ending in blank and in its last class, and the
  // letter model's score of its text
  type Beam = { pb: number; pnb: number; last: number; text: string; lm: number };
  let beams = new Map<string, Beam>([['', { pb: 1, pnb: 0, last: -1, text: '', lm: 0 }]]);
  let scale = 0;
  for (const step of steps) {
    const next = new Map<string, Beam>();
    const get = (key: string, last: number, text: string, lm: number) => {
      let b = next.get(key);
      if (!b) { b = { pb: 0, pnb: 0, last, text, lm }; next.set(key, b); }
      return b;
    };
    for (const [key, b] of beams) {
      const total = b.pb + b.pnb;
      // Blank: the prefix stays
      get(key, b.last, b.text, b.lm).pb += total * step.blank;
      for (const [c, ch, p] of step.cands) {
        const lm = () => b.lm + (extend ? extend(b.text, ch) : 0);
        if (c === b.last) {
          // The same class again without a blank between is the same character; after a blank it is a new one
          get(key, b.last, b.text, b.lm).pnb += b.pnb * p;
          if (b.pb > 0) get(key + ',' + c, c, b.text + ch, lm()).pnb += b.pb * p;
        } else {
          get(key + ',' + c, c, b.text + ch, lm()).pnb += total * p;
        }
      }
    }
    // Keep the most likely (recognizer and letter model together); rescale so long lines do not underflow
    const rank = (b: Beam) => Math.log(b.pb + b.pnb) + b.lm;
    const kept = [...next.entries()].sort((a, b) => rank(b[1]) - rank(a[1])).slice(0, width);
    const norm = Math.max(...kept.map(([, b]) => b.pb + b.pnb), 1e-300);
    scale += Math.log(norm);
    for (const [, b] of kept) { b.pb /= norm; b.pnb /= norm; }
    beams = new Map(kept);
  }
  // Different class sequences can spell the same text (two space classes, decomposed accents): merge them
  const byText = new Map<string, { p: number; lm: number }>();
  for (const b of beams.values()) {
    const text = b.text.normalize('NFC').replace(/\s+/g, ' ').trim();
    const e = byText.get(text);
    byText.set(text, { p: (e?.p ?? 0) + b.pb + b.pnb, lm: Math.max(e?.lm ?? -Infinity, b.lm) });
  }
  return [...byText.entries()]
    .sort((a, b) => Math.log(b[1].p) + b[1].lm - Math.log(a[1].p) - a[1].lm)
    .slice(0, n).map(([text, { p }]) => ({ text, logp: Math.log(p) + scale }));
}

/** Beam search straight from the recognizer's output */
export function beamSearch(prob: (t: number, c: number) => number, T: number, C: number, chars: (c: number) => string,
  { width = 16, perStep = 6, minProb = 0.005, n = 10, allowed }: { width?: number; perStep?: number; minProb?: number; n?: number; allowed?: Uint8Array } = {}): Reading[] {
  return searchSteps(topSteps(prob, T, C, chars, { perStep, minProb, allowed }), { width, n });
}
