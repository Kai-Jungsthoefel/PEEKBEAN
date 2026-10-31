// SPDX-License-Identifier: GPL-3.0-or-later
// Pictures and PDFs to Word, plain text or Markdown by text recognition (ocr/, run in workers/ocr.worker.ts). PDF
// pages with a text layer of their own keep it; scans, and scans with invisible text from another program, are read.
// The models (about 60 MB) and the word data of the page's language load from the site on first use.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { levelHeadings, type Block, type Line } from '../../ocr/assemble';
import type { DocxPage } from '../../ocr/export';
import type { Img } from '../../ocr/image';
import { linesFromItems, type TextItem } from '../../ocr/pdftext';
import { DEFAULTS } from '../../ocr/pipeline';
import { decodedSource, openImage } from '../../viewers/image';
import type { OcrPage, OcrRequest, OcrResponse } from '../../workers/ocr.worker';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

const assetUrl = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

/** Photos are handed over this large: the sheet is cut out and flattened at full detail, then reduced to a page */
const PHOTO_SIDE = 3600;

interface PageInput {
  image: Img;
  textLines?: Line[];
  label: string;
  /** The page has a text layer, but with wrong characters: it is recognized instead */
  garbled?: boolean;
}

export async function convert({ file, target, progress }: ConvertContext): Promise<ConvertResult> {
  const worker = new Worker(new URL('../../workers/ocr.worker.ts', import.meta.url), { type: 'module' });
  const pending: { resolve: (page: OcrPage) => void; reject: (error: Error) => void }[] = [];
  let label = '';
  const downloads = new Map<string, [number, number]>();
  worker.onmessage = (e: MessageEvent<OcrResponse>) => {
    const msg = e.data;
    if (msg.kind === 'step') progress(`${label}: ${msg.step.toLowerCase()} …`);
    else if (msg.kind === 'download') {
      downloads.set(msg.key, [msg.loaded, msg.total]);
      const [loaded, total] = [...downloads.values()].reduce(([a, b], [l, t]) => [a + l, b + t], [0, 0]);
      progress(`Loading the text recognition (${Math.round(loaded / 1e6)} of ${Math.round(total / 1e6)} MB, only the first time) …`, total ? loaded / total : undefined);
    } else if (msg.kind === 'page') pending.shift()?.resolve(msg.page);
    else pending.shift()?.reject(new Error(msg.error));
  };
  worker.onerror = (e) => pending.shift()?.reject(new Error(e.message || 'The text recognition stopped.'));
  const read = (input: PageInput) => new Promise<OcrPage>((resolve, reject) => {
    pending.push({ resolve, reject });
    label = input.label;
    const request: OcrRequest = { kind: 'page', image: input.image, textLines: input.textLines };
    worker.postMessage(request, [input.image.data.buffer]);
  });

  try {
    worker.postMessage({ kind: 'init', base: document.baseURI } satisfies OcrRequest);
    const pages: OcrPage[] = [];
    let garbled = 0;
    for await (const input of inputs(file, progress)) {
      if (input.garbled) garbled++;
      pages.push(await read(input));
    }
    progress('Writing …');
    const blocks: Block[][] = pages.map((p) => p.blocks);
    levelHeadings(blocks);
    const notes = summary(pages);
    if (garbled) notes.push(`${garbled === 1 ? 'One page has' : `${garbled} pages have`} a text layer with wrong characters (a font without a proper character map); recognized from the page instead.`);
    if (target === 'docx') {
      const { toDocx } = await import('../../ocr/export');
      const docx = await toDocx(pages.map((p): DocxPage => ({ blocks: p.blocks, header: p.header, footer: p.footer, width: p.img.width, height: p.img.height })), png);
      return { files: [new File([docx], resultName(file.name, 'docx'), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })], notes };
    }
    const { toMarkdown, toText } = await import('../../ocr/export');
    const text = target === 'md' ? toMarkdown(blocks) : toText(blocks);
    return { files: [new File([text], resultName(file.name, target), { type: target === 'md' ? 'text/markdown' : 'text/plain' })], notes };
  } finally {
    worker.terminate();
  }
}

function summary(pages: OcrPage[]): string[] {
  const read = pages.filter((p) => p.recognized).length;
  if (read === pages.length) return [pages.length > 1 ? `The text of all ${pages.length} pages was recognized.` : 'The text was recognized from the picture.'];
  if (read === 0) return ['The PDF has a text layer of its own; it was taken as it is.'];
  return [`${read} of ${pages.length} pages were recognized; the others had a text layer of their own.`];
}

/** Pictures of the document (Word) as PNG */
async function png(img: Img): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

// ---------- Pages ----------

const isPdf = (file: File) => file.type === 'application/pdf' || /\.pdf$/i.test(file.name);

function inputs(file: File, progress: ConvertContext['progress']): AsyncGenerator<PageInput> {
  return isPdf(file) ? pdfPages(file, progress) : pictures(file, progress);
}

/** Every page of a picture (multi-page TIFF and HEIC), white behind transparency, at most PHOTO_SIDE large */
async function* pictures(file: File, progress: ConvertContext['progress']): AsyncGenerator<PageInput> {
  const { source, format } = await openImage(file, (message) => progress(message));
  const count = format ? source.pages : 1;
  for (let page = 0; page < count; page++) {
    const s = page === 0 ? source : await decodedSource(file, format!, page);
    const picture = new Image();
    picture.src = s.url;
    try {
      await picture.decode();
    } finally {
      URL.revokeObjectURL(s.url);
    }
    const width = picture.naturalWidth || s.width, height = picture.naturalHeight || s.height;
    const scale = Math.min(1, PHOTO_SIDE / Math.max(width, height));
    const canvas = new OffscreenCanvas(Math.round(width * scale), Math.round(height * scale));
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    yield { image: context.getImageData(0, 0, canvas.width, canvas.height), label: count > 1 ? `Page ${page + 1} of ${count}` : 'Picture' };
  }
}

/** PDF pages rendered at the size the pipeline works on, with their text layer where it is real text */
async function* pdfPages(file: File, progress: ConvertContext['progress']): AsyncGenerator<PageInput> {
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'),
  });
  progress('Reading PDF …');
  const pdf = await task.promise;
  try {
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: DEFAULTS.pageSide / Math.max(base.width, base.height) });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      context.fillStyle = '#fff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, viewport }).promise;
      const image = context.getImageData(0, 0, canvas.width, canvas.height);
      canvas.width = 0;
      // Invisible text over a scan is another program's recognition, often worse than ours: the scan is read instead
      let textLines: Line[] | undefined;
      let garbled = false;
      if (!(await hiddenTextOverScan(page))) {
        const lines = linesFromItems((await page.getTextContent()).items as TextItem[], viewport.transform, viewport.scale);
        garbled = garbledText(lines.map((l) => l.text).join('\n'));
        if (!garbled && lines.reduce((n, l) => n + l.text.length, 0) >= 40) textLines = lines;
      }
      page.cleanup();
      yield { image, textLines, garbled, label: pdf.numPages > 1 ? `Page ${number} of ${pdf.numPages}` : 'Page' };
    }
  } finally {
    await task.destroy();
  }
}

/**
 * A text layer whose font maps its glyphs to the wrong characters, as some publishers' and TeX fonts do: the page looks
 * right, but its text has "¾hnlich" for "Ähnlich", "¼" for "=", "ð…Þ" for brackets, or control characters. Fractions
 * glued to letters, control characters and stray Icelandic letters are rare in real text; a few of them say enough.
 */
function garbledText(text: string): boolean {
  const glued = text.match(/[¼½¾](?=\p{L})|(?<=\p{L})[¼½¾]/gu)?.length ?? 0;
  const control = text.match(/[\u0000-\u0008\u000e-\u001f]/g)?.length ?? 0;
  // ð and Þ in pairs stand for brackets; in Icelandic or Faroese text they come with other letters of those languages
  const icelandic = /[ðþÞÐ][\p{Ll}]/u.test(text) && /[áéíóúýæ]/i.test(text);
  const eth = icelandic ? 0 : Math.min(text.split('ð').length - 1, text.split('Þ').length - 1);
  return glued + control + eth >= 3;
}

/** A scan with text from another program's recognition: a picture plus text drawn invisibly (render mode 3) */
async function hiddenTextOverScan(page: pdfjsLib.PDFPageProxy): Promise<boolean> {
  const ops = await page.getOperatorList();
  let invisible = false, picture = false;
  ops.fnArray.forEach((fn, i) => {
    if (fn === pdfjsLib.OPS.setTextRenderingMode && ops.argsArray[i][0] === 3) invisible = true;
    if (fn === pdfjsLib.OPS.paintImageXObject || fn === pdfjsLib.OPS.paintInlineImageXObject) picture = true;
  });
  return invisible && picture;
}
