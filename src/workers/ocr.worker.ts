// SPDX-License-Identifier: GPL-3.0-or-later
// Text recognition off the main thread: one page image in, its document blocks out (ocr/pipeline.ts). The models and
// the word data come from the site's own ocr/ folder, onnxruntime's WebAssembly from ort/ (vite.config.ts).
import type { Block, Line, MarginRow } from '../ocr/assemble';
import { walk } from '../ocr/assemble';
import type { Img } from '../ocr/image';
import type { Env, ModelKey, Ort } from '../ocr/models';
import { DEFAULTS, processPage } from '../ocr/pipeline';

export type OcrRequest =
  | { kind: 'init'; base: string }
  | { kind: 'page'; image: Img; textLines?: Line[] };

export interface OcrPage {
  img: Img;
  blocks: Block[];
  header: MarginRow[];
  footer: MarginRow[];
  /** The page was read by recognition (not from a PDF text layer) */
  recognized: boolean;
}

export type OcrResponse =
  | { kind: 'step'; step: string }
  | { kind: 'download'; key: ModelKey; loaded: number; total: number }
  | { kind: 'page'; page: OcrPage }
  | { kind: 'error'; error: string };

const post = (response: OcrResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(response, transfer);

let env: Env | null = null;
let base = '';
/** The page message follows the init message at once; it waits for onnxruntime to load */
let started: Promise<void> | null = null;

/** A file of the site, unpacked when it is gzip (hosts may already have unpacked it on the way) */
async function fetchBytes(url: string, onProgress?: (loaded: number, total: number) => void): Promise<Uint8Array> {
  const res = await fetch(new URL(url, base));
  if (!res.ok || !res.body) throw new Error(`Could not load ${url} (${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    onProgress?.(loaded, total || loaded);
  }
  const bytes = new Uint8Array(loaded);
  let at = 0;
  for (const c of chunks) { bytes.set(c, at); at += c.length; }
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return bytes;
}

async function init(siteBase: string): Promise<void> {
  base = siteBase;
  const ort = await import('onnxruntime-web/wasm');
  ort.env.wasm.wasmPaths = new URL('ort/', base).href;
  // Several threads need a cross-origin isolated page, which the site is not; one thread works everywhere
  ort.env.wasm.numThreads = 1;
  ort.env.logLevel = 'error';
  env = {
    ort: ort as unknown as Ort,
    fetchBytes,
    sessionOptions: { executionProviders: ['wasm'], graphOptimizationLevel: 'all', logSeverityLevel: 3 },
    onDownload: (key, loaded, total) => post({ kind: 'download', key, loaded, total }),
  };
}

self.onmessage = async (e: MessageEvent<OcrRequest>) => {
  const msg = e.data;
  try {
    if (msg.kind === 'init') {
      started = init(msg.base);
      await started;
      return;
    }
    await started;
    if (!env) throw new Error('The text recognition did not start.');
    const r = await processPage(env, msg.image, DEFAULTS, (step) => post({ kind: 'step', step }), msg.textLines);
    const transfer: Transferable[] = [];
    for (const b of walk(r.blocks)) if (b.type === 'image' && b.img) transfer.push(b.img.data.buffer);
    if (r.img !== msg.image) transfer.push(r.img.data.buffer);
    post({ kind: 'page', page: { img: r.img, blocks: r.blocks, header: r.header, footer: r.footer, recognized: !msg.textLines } }, transfer);
  } catch (err) {
    post({ kind: 'error', error: err instanceof Error ? err.message : String(err) });
  }
};
