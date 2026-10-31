// SPDX-License-Identifier: GPL-3.0-or-later
// The models of the text recognition: PaddlePaddle models (Apache-2.0) as ONNX, and the word data per language. All
// are served by the site itself from ocr/ (scripts/build-ocr-data.mjs puts them there); nothing is fetched elsewhere.
import { parse } from 'yaml';

const paddle = (name: string) => ({ onnx: `ocr/models/${name}.onnx`, yml: `ocr/models/${name}.yml` });

export type ScriptKey = 'cyrillic' | 'greek';

export interface ModelDef {
  label: string;
  onnx: string;
  /** inference.yml with the character dictionary or label list */
  yml: string;
  sizeMB: number;
}

export const MODELS = {
  'det-small': { label: 'Line detection', ...paddle('det-small'), sizeMB: 9.9 },
  'rec-small': { label: 'Text recognition', ...paddle('rec-small'), sizeMB: 21.4 },
  layout: { label: 'Layout', ...paddle('layout'), sizeMB: 4.9 },
  table: { label: 'Table structure', ...paddle('table'), sizeMB: 7.8 },
  orientation: { label: 'Page orientation', ...paddle('orientation'), sizeMB: 6.8 },
  'rec-cyrillic': { label: 'Cyrillic text recognition', ...paddle('rec-cyrillic'), sizeMB: 8.1 },
  'rec-greek': { label: 'Greek text recognition', ...paddle('rec-greek'), sizeMB: 7.8 },
} satisfies Record<string, ModelDef>;

export type ModelKey = keyof typeof MODELS;

/** Word lists for the correction (FrequencyWords, CC-BY-SA-4.0; the 50,000 most frequent words of each language) */
export const DICTIONARIES: Record<string, string> = Object.fromEntries(
  ['en', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'pl', 'ru', 'tr', 'sv', 'da', 'no', 'cs', 'hu', 'ro', 'fi', 'uk', 'el']
    .map((l) => [l, `ocr/lang/${l}.words.txt.gz`]),
);

/** Languages with word pairs and triples (Leipzig Corpora Collection, CC BY 4.0) for choosing among readings */
export const LANGUAGE_DATA = ['en', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'pl'];

/** franc's ISO 639-3 codes → the word lists' codes */
export const FRANC_TO_DICT: Record<string, string> = {
  eng: 'en', deu: 'de', spa: 'es', fra: 'fr', ita: 'it', por: 'pt', nld: 'nl', pol: 'pl', rus: 'ru', tur: 'tr',
  swe: 'sv', dan: 'da', nob: 'no', ces: 'cs', hun: 'hu', ron: 'ro', fin: 'fi', ukr: 'uk', ell: 'el',
};

export const SCRIPTS: Record<ScriptKey, { label: string; model: ModelKey }> = {
  cyrillic: { label: 'Cyrillic', model: 'rec-cyrillic' },
  greek: { label: 'Greek', model: 'rec-greek' },
};

// ---------- Runtime: onnxruntime-web ----------

export interface Tensor { dims: readonly number[]; data: unknown }
export interface Session {
  inputNames: readonly string[];
  outputNames: readonly string[];
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
}
export interface Ort {
  Tensor: new (type: 'float32', data: Float32Array, dims: number[]) => Tensor;
  InferenceSession: { create(model: Uint8Array, options?: object): Promise<Session> };
}

export interface Loaded {
  session: Session;
  /** Parsed inference.yml */
  config: Record<string, unknown> | null;
}

export interface Env {
  ort: Ort;
  /** Fetch one of the site's files (from a cache if possible); gzip files come back unpacked */
  fetchBytes(url: string, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array>;
  sessionOptions?: object;
  /** Called while a model downloads */
  onDownload?: (key: ModelKey, loaded: number, total: number) => void;
}

const loaded = new Map<string, Promise<Loaded>>();

export function loadModel(env: Env, key: ModelKey): Promise<Loaded> {
  let p = loaded.get(key);
  if (!p) {
    p = (async () => {
      const def: ModelDef = MODELS[key];
      const [bytes, ymlBytes] = await Promise.all([
        env.fetchBytes(def.onnx, (l, t) => env.onDownload?.(key, l, t)),
        env.fetchBytes(def.yml),
      ]);
      const config = parse(new TextDecoder().decode(ymlBytes)) as Record<string, unknown>;
      const session = await env.ort.InferenceSession.create(bytes, env.sessionOptions ?? {});
      return { session, config };
    })();
    p.catch(() => loaded.delete(key));
    loaded.set(key, p);
  }
  return p;
}
