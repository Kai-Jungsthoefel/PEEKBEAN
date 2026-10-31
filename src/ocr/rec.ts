// SPDX-License-Identifier: GPL-3.0-or-later
// Text line recognition (CTC): each line is cut out, straightened to 48 px height and read; the model outputs one
// character distribution per time step, CTC decoding drops blanks and repeats.
import { toCHW, warpRect, type Img, type RotRect } from './image';
import { searchSteps, topSteps, type Reading, type Step } from './ctc';
import type { Loaded, Ort } from './models';

export interface RecResult {
  text: string;
  /** Mean probability of the chosen characters, 0…1 */
  conf: number;
  /** Which recognizer read it, set by the pipeline: "main" or a script key */
  script?: string;
  /** Where each character of text sits along the line, 0…1 of its width (from the CTC time steps) */
  pos?: number[];
  /** Probability of each character of text */
  probs?: number[];
  /** The most likely whole readings of the line (CTC beam search), most likely first */
  nbest?: Reading[];
  /** The recognizer's most likely characters per time step: to search again later with a letter model */
  steps?: Step[];
}

const HEIGHT = 48;
/** Paddle pads every batch to at least this width (ratio 320/48) */
const MIN_WIDTH = 320;
const BATCH = 6;

interface Dict { chars: string[]; space: boolean | null }
const dicts = new WeakMap<Loaded, Dict>();

function dictOf(model: Loaded): Dict {
  let d = dicts.get(model);
  if (!d) {
    const post = (model.config?.PostProcess ?? {}) as { character_dict?: unknown[] };
    d = { chars: (post.character_dict ?? []).map(String), space: null };
    dicts.set(model, d);
  }
  return d;
}

export async function recognize(ort: Ort, model: Loaded, img: Img, rects: RotRect[], reverse = false): Promise<RecResult[]> {
  const crops = rects.map((r) => warpRect(img, r, HEIGHT));
  const order = crops.map((_, i) => i).sort((a, b) => crops[a].width - crops[b].width);
  const results: RecResult[] = new Array(rects.length);
  for (let s = 0; s < order.length; s += BATCH) {
    const idx = order.slice(s, s + BATCH);
    const W = Math.max(MIN_WIDTH, ...idx.map((i) => crops[i].width));
    const plane = 3 * HEIGHT * W;
    const data = new Float32Array(idx.length * plane); // zeros = padding, as in Paddle
    idx.forEach((i, b) => toCHW(crops[i], [0.5, 0.5, 0.5], [0.5, 0.5, 0.5], 1 / 255, true, data.subarray(b * plane, (b + 1) * plane), W));
    const out = await model.session.run({ [model.session.inputNames[0]]: new ort.Tensor('float32', data, [idx.length, 3, HEIGHT, W]) });
    const t = out[model.session.outputNames[0]];
    const [, T, C] = t.dims as number[];
    const probs = t.data as Float32Array;
    idx.forEach((i, b) => {
      // Time step t covers the input columns around (t + 0.5) / T of the padded width W
      const p = probs.subarray(b * T * C, (b + 1) * T * C), dict = dictOf(model);
      const r = decode(dict, p, T, C, W / crops[i].width);
      if (!reverse) {
        r.steps = topSteps((t, c) => p[t * C + c], T, C, (c) => (c <= dict.chars.length ? dict.chars[c - 1] : ' '));
        r.nbest = searchSteps(r.steps);
      }
      results[i] = reverse ? { ...r, text: [...r.text].reverse().join(''), pos: r.pos?.slice().reverse(), probs: r.probs?.slice().reverse() } : r;
    });
  }
  return results;
}

function decode(dict: Dict, p: Float32Array, T: number, C: number, stretch: number): RecResult {
  // Index 0 is the CTC blank, then the dictionary; one more class means a space at the end
  if (dict.space === null) {
    dict.space = C === dict.chars.length + 2;
    if (C !== dict.chars.length + 1 && C !== dict.chars.length + 2) {
      console.warn(`Recognition model has ${C} classes for ${dict.chars.length} characters`);
    }
  }
  let text = '';
  const pos: number[] = [];
  const probs: number[] = [];
  let sum = 0, n = 0, prev = -1;
  for (let t = 0; t < T; t++) {
    let best = 0, bp = -Infinity;
    for (let c = 0; c < C; c++) {
      const v = p[t * C + c];
      if (v > bp) { bp = v; best = c; }
    }
    if (best !== 0 && best !== prev) {
      const ch = best <= dict.chars.length ? dict.chars[best - 1] : ' ';
      text += ch;
      for (let k = 0; k < [...ch].length; k++) { pos.push(Math.min(1, ((t + 0.5) / T) * stretch)); probs.push(bp); }
      sum += bp;
      n++;
    }
    prev = best;
  }
  // Trim spaces at both ends, and their positions with them
  const chars = [...text];
  let a = 0, z = chars.length;
  while (a < z && chars[a] === ' ') a++;
  while (z > a && chars[z - 1] === ' ') z--;
  return { text: chars.slice(a, z).join(''), conf: n ? sum / n : 0, pos: pos.slice(a, z), probs: probs.slice(a, z) };
}
