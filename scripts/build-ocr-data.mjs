// SPDX-License-Identifier: GPL-3.0-or-later
// Puts the text recognition's files into public/ocr, so the site serves them itself (licenses/paddleocr-models.txt,
// licenses/ocr-word-data.txt):
//   ocr/models/<name>.onnx + .yml          PaddleOCR models from Hugging Face (Apache-2.0), only renamed
//   ocr/lang/<lang>.words.txt.gz           FrequencyWords lists, 50,000 words (CC BY-SA 4.0), only compressed
//   ocr/lang/<lang>.{words,pairs,triples}.tsv.gz
//                                          word, pair and triple counts from the Leipzig Corpora Collection's news
//                                          corpora with 300,000 sentences (CC BY 4.0)
// The Leipzig archives are large (60–90 MB each); --leipzig <dir> reuses ones downloaded before.
// node scripts/build-ocr-data.mjs [--leipzig <dir>]
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const root = path.join(import.meta.dirname, '..');
const out = path.join(root, 'public', 'ocr');
const args = process.argv.slice(2);
const leipzig = args.includes('--leipzig') ? args[args.indexOf('--leipzig') + 1] : path.join(tmpdir(), 'peekbean-leipzig');

const HF = 'https://huggingface.co';
const MODELS = {
  'det-small': 'PaddlePaddle/PP-OCRv6_small_det_onnx',
  'rec-small': 'PaddlePaddle/PP-OCRv6_small_rec_onnx',
  'rec-cyrillic': 'PaddlePaddle/cyrillic_PP-OCRv5_mobile_rec_onnx',
  'rec-greek': 'PaddlePaddle/el_PP-OCRv5_mobile_rec_onnx',
  table: 'PaddlePaddle/SLANet_plus_onnx',
  orientation: 'PaddlePaddle/PP-LCNet_x1_0_doc_ori_onnx',
};
// PaddlePaddle publishes PP-DocLayout-S without ONNX; this conversion of it is Apache-2.0 as well.
const LAYOUT = { onnx: 'stefanj0/PP-DocLayout-S-ONNX/resolve/main/pp_doclayout_s.onnx', yml: 'PaddlePaddle/PP-DocLayout-S/resolve/main/inference.yml' };

const WORD_LISTS = ['en', 'de', 'es', 'fr', 'it', 'pt', 'nl', 'pl', 'ru', 'tr', 'sv', 'da', 'no', 'cs', 'hu', 'ro', 'fi', 'uk', 'el'];
const CORPORA = { en: 'eng', de: 'deu', es: 'spa', fr: 'fra', it: 'ita', pt: 'por', nl: 'nld', pl: 'pol' };
/** Least counts kept: rarer entries hardly help and make the files three times larger */
const LEAST = { words: 3, pairs: 3, triples: 5 };

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  return new Uint8Array(await res.arrayBuffer());
}

async function models() {
  const dir = path.join(out, 'models');
  mkdirSync(dir, { recursive: true });
  const files = Object.entries(MODELS).flatMap(([name, repo]) => [
    [`${name}.onnx`, `${HF}/${repo}/resolve/main/inference.onnx`],
    [`${name}.yml`, `${HF}/${repo}/resolve/main/inference.yml`],
  ]);
  files.push(['layout.onnx', `${HF}/${LAYOUT.onnx}`], ['layout.yml', `${HF}/${LAYOUT.yml}`]);
  for (const [name, url] of files) {
    if (existsSync(path.join(dir, name))) continue;
    writeFileSync(path.join(dir, name), await download(url));
    console.log('model', name);
  }
}

async function wordLists() {
  const dir = path.join(out, 'lang');
  mkdirSync(dir, { recursive: true });
  for (const lang of WORD_LISTS) {
    const file = path.join(dir, `${lang}.words.txt.gz`);
    if (existsSync(file)) continue;
    const list = await download(`https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${lang}/${lang}_50k.txt`);
    writeFileSync(file, gzipSync(list, { level: 9 }));
    console.log('word list', lang);
  }
}

/** Counts of lower-case words, pairs and triples ("<s>" starts a sentence), as tab-separated lines, most frequent first */
function counts(sentences) {
  const word = /[\p{L}]+(?:['’-][\p{L}]+)*|\d+/gu;
  const uni = new Map(), pairs = new Map(), triples = new Map();
  const add = (m, k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const line of sentences.split('\n')) {
    const text = line.slice(line.indexOf('\t') + 1);
    const ws = ['<s>', ...(text.match(word) ?? []).map((w) => w.toLowerCase())];
    for (let i = 1; i < ws.length; i++) {
      add(uni, ws[i]);
      add(pairs, `${ws[i - 1]}\t${ws[i]}`);
      if (i >= 2) add(triples, `${ws[i - 2]}\t${ws[i - 1]}\t${ws[i]}`);
    }
  }
  const tsv = (m, least) => [...m].filter(([, c]) => c >= least).sort((a, b) => b[1] - a[1]).map(([k, c]) => `${k}\t${c}\n`).join('');
  return { words: tsv(uni, LEAST.words), pairs: tsv(pairs, LEAST.pairs), triples: tsv(triples, LEAST.triples) };
}

async function wordCounts() {
  const dir = path.join(out, 'lang');
  mkdirSync(leipzig, { recursive: true });
  for (const [lang, code] of Object.entries(CORPORA)) {
    if (existsSync(path.join(dir, `${lang}.triples.tsv.gz`))) continue;
    const name = `${code}_news_2023_300K`;
    const archive = path.join(leipzig, `${name}.tar.gz`);
    if (!existsSync(archive)) writeFileSync(archive, await download(`https://downloads.wortschatz-leipzig.de/corpora/${name}.tar.gz`));
    const sentences = path.join(leipzig, name, `${name}-sentences.txt`);
    if (!existsSync(sentences)) execFileSync('tar', ['-xzf', `${name}.tar.gz`, `${name}/${name}-sentences.txt`], { cwd: leipzig });
    const c = counts(readFileSync(sentences, 'utf8'));
    for (const kind of ['words', 'pairs', 'triples']) writeFileSync(path.join(dir, `${lang}.${kind}.tsv.gz`), gzipSync(c[kind], { level: 9 }));
    console.log('word counts', lang);
  }
}

await models();
await wordLists();
await wordCounts();
