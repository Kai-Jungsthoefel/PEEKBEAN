// SPDX-License-Identifier: GPL-3.0-or-later
// Images to PNG, JPG or WebP. Every format the image viewer reads works, through the same decoders; the picture is
// redrawn on a canvas and written by the browser. Multi-page TIFF and HEIC files give one picture per page.
import { decodedSource, openImage, type Source } from '../../viewers/image';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';
import { canvasFor, encodeCanvas } from './raster';

async function encode(source: Source, target: string, quality: string | undefined, name: string): Promise<File> {
  try {
    const picture = new Image();
    picture.src = source.url;
    await picture.decode();
    // SVGs without a size of their own report 0 × 0; the viewer's size stands in.
    const { canvas, context } = canvasFor(picture.naturalWidth || source.width, picture.naturalHeight || source.height, target);
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return await encodeCanvas(canvas, target, quality, name);
  } finally {
    URL.revokeObjectURL(source.url);
  }
}

export async function convert({ file, target, options, progress }: ConvertContext): Promise<ConvertResult> {
  const { source, format } = await openImage(file, (message) => progress(message));
  // Target ids are the file extensions (catalog.ts).
  const quality = target === 'png' ? undefined : options.quality;
  const notes = source.label && source.title ? [source.title] : [];
  if (source.pages <= 1 || !format) {
    progress('Writing picture …');
    return { files: [await encode(source, target, quality, resultName(file.name, target))], notes };
  }
  const files: File[] = [];
  const digits = String(source.pages).length;
  for (let page = 0; page < source.pages; page++) {
    progress(`Writing page ${page + 1} of ${source.pages} …`, page / source.pages);
    const next = page === 0 ? source : await decodedSource(file, format, page);
    files.push(await encode(next, target, quality, resultName(file.name, target, `page ${String(page + 1).padStart(digits, '0')}`)));
  }
  return { files, notes };
}
