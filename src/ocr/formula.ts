// SPDX-License-Identifier: GPL-3.0-or-later
// Formulas to LaTeX with Texo (FormulaNet, a distilled PP-FormulaNet-S: an image encoder and a two-layer text decoder,
// AGPL-3.0, https://github.com/alephpi/Texo). The picture of one formula goes in, LaTeX comes out token by token.
// The image is prepared as Texo's own web app does (UniMERNet's processor): grey, ink cropped, fitted into 384 × 384
// on black, normalized.
import { crop, resize, type Box, type Img } from './image';
import type { Env, Session, Tensor } from './models';

const SIZE = 384;
const MEAN = 0.7931, STD = 0.1738;
const BOS = 0, EOS = 2;
/** Longer outputs are a model running in circles, not a formula */
const MAX_TOKENS = 400;

/** The encoder comes in three parts: static hosts limit files to about 25 MB (scripts/build-ocr-data.mjs splits it) */
export const FORMULA_FILES = {
  encoder: [1, 2, 3].map((i) => `ocr/models/formula-encoder.part${i}.onnx`),
  decoder: 'ocr/models/formula-decoder.onnx',
  tokenizer: 'ocr/models/formula-tokenizer.json',
};
export const FORMULA_MB = 80.1;

export interface FormulaModel {
  encoder: Session;
  decoder: Session;
  /** Token id → token */
  vocab: string[];
}

export interface Formula {
  latex: string;
  /** Mean probability of the chosen tokens */
  conf: number;
}

let loading: Promise<FormulaModel> | null = null;

export function loadFormulaModel(env: Env): Promise<FormulaModel> {
  loading ??= (async () => {
    const [parts, dec, tok] = await Promise.all([
      Promise.all(FORMULA_FILES.encoder.map((url, i) => env.fetchBytes(url, (l, t) => env.onDownload?.(`formula-encoder-${i}`, l, t)))),
      env.fetchBytes(FORMULA_FILES.decoder, (l, t) => env.onDownload?.('formula-decoder', l, t)),
      env.fetchBytes(FORMULA_FILES.tokenizer),
    ]);
    const enc = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    parts.reduce((at, p) => (enc.set(p, at), at + p.length), 0);
    const vocab: string[] = [];
    const json = JSON.parse(new TextDecoder().decode(tok)) as { model: { vocab: Record<string, number> } };
    for (const [token, id] of Object.entries(json.model.vocab)) vocab[id] = token;
    const options = env.sessionOptions ?? {};
    return {
      encoder: await env.ort.InferenceSession.create(enc, options),
      decoder: await env.ort.InferenceSession.create(dec, options),
      vocab,
    };
  })();
  loading.catch(() => (loading = null));
  return loading;
}

/** The formula in a box of the page, or null when there is no ink in it */
export async function recognizeFormula(env: Env, model: FormulaModel, page: Img, box: Box): Promise<Formula | null> {
  // The layout's box may cut off a sign at its edge; the white margin around is cropped again in prepare
  const pad = Math.max(4, 0.15 * (box.y1 - box.y0));
  const input = prepare(crop(page, { x0: box.x0 - pad, y0: box.y0 - pad / 2, x1: box.x1 + pad, y1: box.y1 + pad / 2 }));
  if (!input) return null;
  const { ort } = env;
  const enc = await model.encoder.run({ [model.encoder.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });
  const hidden = enc[model.encoder.outputNames[0]];

  // The merged decoder: the first step without cache (it computes the cross-attention keys), then step by step
  const layers = model.decoder.inputNames.filter((n) => n.startsWith('past_key_values.') && n.endsWith('.decoder.key')).length;
  const heads = 16, headDim = 24;
  let past: Record<string, Tensor> = {};
  for (let l = 0; l < layers; l++) {
    for (const part of ['decoder.key', 'decoder.value', 'encoder.key', 'encoder.value']) {
      past[`past_key_values.${l}.${part}`] = new ort.Tensor('float32', new Float32Array(0), [1, heads, 0, headDim]);
    }
  }
  const tokens: number[] = [];
  let next = BOS, logp = 0;
  for (let step = 0; step < MAX_TOKENS; step++) {
    const out = await model.decoder.run({
      input_ids: new ort.Tensor('int64', new BigInt64Array([BigInt(next)]), [1, 1]),
      encoder_hidden_states: hidden,
      use_cache_branch: new ort.Tensor('bool', new Uint8Array([step > 0 ? 1 : 0]), [1]),
      ...past,
    });
    const logits = out.logits.data as Float32Array;
    const vocab = out.logits.dims[2];
    const row = logits.subarray(logits.length - vocab);
    let best = 0;
    for (let i = 1; i < vocab; i++) if (row[i] > row[best]) best = i;
    let sum = 0;
    for (let i = 0; i < vocab; i++) sum += Math.exp(row[i] - row[best]);
    logp += -Math.log(sum);
    if (best === EOS) break;
    tokens.push(best);
    next = best;
    const kept: Record<string, Tensor> = {};
    for (let l = 0; l < layers; l++) {
      kept[`past_key_values.${l}.decoder.key`] = out[`present.${l}.decoder.key`];
      kept[`past_key_values.${l}.decoder.value`] = out[`present.${l}.decoder.value`];
      // The cached branch returns empty encoder keys; the ones from the first step stay
      kept[`past_key_values.${l}.encoder.key`] = step === 0 ? out[`present.${l}.encoder.key`] : past[`past_key_values.${l}.encoder.key`];
      kept[`past_key_values.${l}.encoder.value`] = step === 0 ? out[`present.${l}.encoder.value`] : past[`past_key_values.${l}.encoder.value`];
    }
    past = kept;
  }
  if (!tokens.length || tokens.length >= MAX_TOKENS) return null;
  return { latex: tidy(tokens.map((t) => model.vocab[t] ?? '')), conf: Math.exp(logp / (tokens.length + 1)) };
}

/** Grey, dark-on-light, cropped to the ink, fitted into the square and normalized; three equal channels */
function prepare(img: Img): Float32Array | null {
  const n = img.width * img.height;
  const grey = new Uint8Array(n);
  let dark = 0;
  for (let i = 0; i < n; i++) {
    grey[i] = Math.round(0.2126 * img.data[i * 4] + 0.7152 * img.data[i * 4 + 1] + 0.0722 * img.data[i * 4 + 2]);
    if (grey[i] < 200) dark++;
  }
  // Light type on a dark background is turned around
  if (dark >= n - dark) for (let i = 0; i < n; i++) grey[i] = 255 - grey[i];

  // The ink: darker than 200 on the contrast-stretched image
  let min = 255, max = 0;
  for (const v of grey) { if (v < min) min = v; if (v > max) max = v; }
  if (max - min < 30) return null;
  let x0 = img.width, y0 = img.height, x1 = -1, y1 = -1;
  for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) {
    if (((grey[y * img.width + x] - min) / (max - min)) * 255 >= 200) continue;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  if (x1 < x0) return null;
  const inked = { width: x1 - x0 + 1, height: y1 - y0 + 1, data: new Uint8ClampedArray((x1 - x0 + 1) * (y1 - y0 + 1) * 4) };
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const o = ((y - y0) * inked.width + (x - x0)) * 4, v = grey[y * img.width + x];
    inked.data[o] = inked.data[o + 1] = inked.data[o + 2] = v;
    inked.data[o + 3] = 255;
  }

  const s = Math.min(SIZE / inked.width, SIZE / inked.height);
  const w = Math.max(1, Math.min(SIZE, Math.round(inked.width * s))), h = Math.max(1, Math.min(SIZE, Math.round(inked.height * s)));
  const fitted = resize(inked, w, h);
  const px = Math.floor((SIZE - w) / 2), py = Math.floor((SIZE - h) / 2);
  const plane = new Float32Array(SIZE * SIZE).fill((0 - MEAN) / STD);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    plane[(y + py) * SIZE + x + px] = (fitted.data[(y * w + x) * 4] / 255 - MEAN) / STD;
  }
  const out = new Float32Array(3 * SIZE * SIZE);
  out.set(plane, 0);
  out.set(plane, SIZE * SIZE);
  out.set(plane, 2 * SIZE * SIZE);
  return out;
}

/** KaTeX's short names that LaTeX does not know */
const ALIASES: Record<string, string> = {
  '\\infin': '\\infty', '\\rarr': '\\rightarrow', '\\larr': '\\leftarrow', '\\harr': '\\leftrightarrow',
  '\\Rarr': '\\Rightarrow', '\\Larr': '\\Leftarrow', '\\Harr': '\\Leftrightarrow', '\\darr': '\\downarrow', '\\uarr': '\\uparrow',
};

/** Tokens → LaTeX: a space only where a command would otherwise run into the next letter */
function tidy(tokens: string[]): string {
  let out = '';
  tokens.forEach((t, i) => {
    const token = ALIASES[t] ?? t;
    const prev = i ? ALIASES[tokens[i - 1]] ?? tokens[i - 1] : '';
    if (/^\\[A-Za-z]+$/.test(prev) && /^[A-Za-z0-9]/.test(token)) out += ' ';
    out += token;
  });
  return out.replace(/\\!/g, '').replace(/~/g, ' ').trim();
}
