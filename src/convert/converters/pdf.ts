// SPDX-License-Identifier: GPL-3.0-or-later
// PDF pages to PNG or JPG, rendered by pdf.js at the chosen resolution; one picture per page.
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';
import { canvasFor, encodeCanvas } from './raster';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// Served next to the page like for the PDF viewer (vite.config.ts), so no CDN is asked.
const assetUrl = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

// Browsers refuse canvases much larger than this; large plans at 300 dpi get there.
const MAX_PIXELS = 100_000_000;
const MAX_SIDE = 16_000;

export async function convert({ file, target, options, progress }: ConvertContext): Promise<ConvertResult> {
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'),
  });
  let passwordCancelled = false;
  task.onPassword = (update: (password: string) => void, reason: number) => {
    const password = window.prompt(
      reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD ? 'Wrong password. Please try again:' : `${file.name} is password protected. Password:`,
    );
    if (password === null) {
      passwordCancelled = true;
      void task.destroy();
    } else {
      update(password);
    }
  };
  progress('Reading PDF …');
  let pdf: pdfjsLib.PDFDocumentProxy;
  try {
    pdf = await task.promise;
  } catch (error) {
    if (passwordCancelled) throw new Error('The file cannot be converted without its password.');
    throw error;
  }

  try {
    const scale = Number(options.resolution) / 72;
    const quality = target === 'png' ? undefined : options.quality;
    const digits = String(pdf.numPages).length;
    const files: File[] = [];
    let reduced = 0;
    for (let number = 1; number <= pdf.numPages; number++) {
      progress(`Rendering page ${number} of ${pdf.numPages} …`, (number - 1) / pdf.numPages);
      const page = await pdf.getPage(number);
      let viewport = page.getViewport({ scale });
      const fit = Math.min(1, Math.sqrt(MAX_PIXELS / (viewport.width * viewport.height)), MAX_SIDE / Math.max(viewport.width, viewport.height));
      if (fit < 1) {
        viewport = page.getViewport({ scale: scale * fit });
        reduced++;
      }
      const { canvas } = canvasFor(Math.floor(viewport.width), Math.floor(viewport.height), target);
      await page.render({ canvas, viewport }).promise;
      page.cleanup();
      const suffix = pdf.numPages > 1 ? `page ${String(number).padStart(digits, '0')}` : '';
      files.push(await encodeCanvas(canvas, target, quality, resultName(file.name, target, suffix)));
    }
    const notes = reduced ? [`${reduced === 1 ? 'One page was' : `${reduced} pages were`} too large for the chosen resolution and rendered smaller.`] : [];
    return { files, notes };
  } finally {
    await task.destroy();
  }
}
