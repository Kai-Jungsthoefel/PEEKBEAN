// SPDX-License-Identifier: GPL-3.0-or-later
// Images to PNG, JPG, WebP, PDF or ICO, and by text recognition to Word, text or Markdown (ocr.ts). Every format the image viewer reads works, through the same decoders; the
// picture is redrawn on a canvas and written by the browser. Multi-page TIFF and HEIC files give one picture per page,
// or one PDF with a page each. ICO and CUR files give each of their pictures.
import { extensionOf } from '../../core/bytes';
import { decodedSource, openImage, type Source } from '../../viewers/image';
import { resultName } from '../files';
import { isIcon, readIcon, writeIcon } from '../image/ico';
import type { ConvertContext, ConvertResult } from '../types';
import { canvasFor, encodeCanvas } from './raster';

/** Targets reached by text recognition (ocr.ts) */
const OCR_TARGETS = ['docx', 'txt', 'md'];

/** Formats that store photos lossily; in a PDF their pictures become JPEG again, the rest PNG. */
const PHOTOS = ['jpg', 'jpeg', 'jfif', 'pjpeg', 'heic', 'heif', 'avif'];

async function decode(url: string): Promise<HTMLImageElement> {
  const picture = new Image();
  picture.src = url;
  await picture.decode();
  return picture;
}

/** The picture of a source drawn on a canvas, at the picture's own size. */
async function draw(source: Source, target: string): Promise<HTMLCanvasElement> {
  try {
    const picture = await decode(source.url);
    // SVGs without a size of their own report 0 × 0; the viewer's size stands in.
    const { canvas, context } = canvasFor(picture.naturalWidth || source.width, picture.naturalHeight || source.height, target);
    context.drawImage(picture, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(source.url);
  }
}

/** The pages of a picture: one, or each page of a multi-page TIFF or HEIC file. */
async function* pages(file: File, progress: ConvertContext['progress']): AsyncGenerator<{ source: Source; page: number; count: number; notes: string[] }> {
  const { source, format } = await openImage(file, (message) => progress(message));
  const notes = source.label && source.title ? [source.title] : [];
  const count = format ? source.pages : 1;
  for (let page = 0; page < count; page++) yield { source: page === 0 ? source : await decodedSource(file, format!, page), page, count, notes };
}

export async function convert(ctx: ConvertContext): Promise<ConvertResult> {
  const { file, target } = ctx;
  if (OCR_TARGETS.includes(target)) return (await import('./ocr')).convert(ctx);
  if (target === 'pdf') return toPdf(ctx);
  if (target === 'ico') return toIcon(ctx);
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (isIcon(head)) return iconPictures(ctx);
  // Target ids are the file extensions (catalog.ts).
  const quality = target === 'png' ? undefined : ctx.options.quality;
  const files: File[] = [];
  let notes: string[] = [];
  for await (const { source, page, count, notes: own } of pages(file, ctx.progress)) {
    notes = own;
    const digits = String(count).length;
    ctx.progress(count > 1 ? `Writing page ${page + 1} of ${count} …` : 'Writing picture …', count > 1 ? page / count : undefined);
    const suffix = count > 1 ? `page ${String(page + 1).padStart(digits, '0')}` : '';
    files.push(await encodeCanvas(await draw(source, target), target, quality, resultName(file.name, target, suffix)));
  }
  return { files, notes };
}

/** One PDF with a page per picture. A JPEG goes in as it is; other pictures are drawn and written as JPEG or PNG. */
async function toPdf({ file, options, progress }: ConvertContext): Promise<ConvertResult> {
  const { plainJpeg, writePdf } = await import('../image/pdf');
  const photo = PHOTOS.includes(extensionOf(file.name));
  const pictures: Parameters<typeof writePdf>[0] = [];
  let notes: string[] = [];
  let kept = false;
  for await (const { source, page, count, notes: own } of pages(file, progress)) {
    notes = own;
    progress(count > 1 ? `Reading page ${page + 1} of ${count} …` : 'Reading picture …', count > 1 ? page / count : undefined);
    const bytes = count === 1 && photo ? new Uint8Array(await file.arrayBuffer()) : null;
    if (bytes && plainJpeg(bytes)) {
      // The viewer's object URL is not needed for the size: the picture is decoded once anyway.
      const picture = await decode(source.url).finally(() => URL.revokeObjectURL(source.url));
      pictures.push({ bytes, type: 'jpg', width: picture.naturalWidth, height: picture.naturalHeight });
      kept = true;
      continue;
    }
    // Photos become JPEG at high quality; drawings, screenshots and pictures with transparency stay lossless.
    const type = photo || source.label ? 'jpg' : 'png';
    const canvas = await draw(source, type);
    const [width, height] = [canvas.width, canvas.height];
    const written = await encodeCanvas(canvas, type, type === 'jpg' ? '0.92' : undefined, 'page');
    pictures.push({ bytes: new Uint8Array(await written.arrayBuffer()), type, width, height });
  }
  progress('Writing PDF …');
  const pdf = await writePdf(pictures, options.page, file.name);
  if (kept) notes = [...notes, 'The JPEG is inside the PDF unchanged, without compressing it again.'];
  return { files: [new File([pdf as Uint8Array<ArrayBuffer>], resultName(file.name, 'pdf'), { type: 'application/pdf' })], notes };
}

/** Square pictures in the chosen sizes, none larger than the source; a picture that is not square gets a border. */
async function toIcon({ file, options, progress }: ConvertContext): Promise<ConvertResult> {
  let picture: HTMLImageElement | HTMLCanvasElement | null = null;
  let notes: string[] = [];
  for await (const { source, page, notes: own } of pages(file, progress)) {
    if (page > 0) break;
    notes = own;
    picture = await draw(source, 'png');
  }
  const largest = Math.max(picture!.width, picture!.height);
  const wanted = options.sizes.split(',').map(Number);
  // Enlarged pictures only look blurred; the smallest size is made in any case.
  const sizes = wanted.filter((size, i) => size <= largest || i === 0);
  const written: { size: number; png: Uint8Array }[] = [];
  for (const size of sizes) {
    progress(`Writing ${size} × ${size} …`);
    const png = await encodeCanvas(scaled(picture!, size), 'png', undefined, 'icon');
    written.push({ size, png: new Uint8Array(await png.arrayBuffer()) });
  }
  if (sizes.length < wanted.length) notes = [...notes, `Sizes above ${largest} × ${largest} pixels are left out, as the picture is not larger.`];
  if (picture!.width !== picture!.height) notes = [...notes, 'The picture is not square; it is centered with a transparent border.'];
  return { files: [new File([writeIcon(written) as Uint8Array<ArrayBuffer>], resultName(file.name, 'ico'), { type: 'image/x-icon' })], notes };
}

/** The picture fitted into a transparent square; halved step by step, as one large step leaves out pixels. */
function scaled(picture: HTMLImageElement | HTMLCanvasElement, size: number): HTMLCanvasElement {
  let current: HTMLImageElement | HTMLCanvasElement = picture;
  while (Math.max(current.width, current.height) >= size * 4) {
    const { canvas, context } = canvasFor(Math.ceil(current.width / 2), Math.ceil(current.height / 2), 'png');
    context.imageSmoothingQuality = 'high';
    context.drawImage(current, 0, 0, canvas.width, canvas.height);
    current = canvas;
  }
  const scale = size / Math.max(current.width, current.height);
  const [width, height] = [current.width * scale, current.height * scale];
  const { canvas, context } = canvasFor(size, size, 'png');
  context.imageSmoothingQuality = 'high';
  context.drawImage(current, (size - width) / 2, (size - height) / 2, width, height);
  return canvas;
}

/** Each picture of an icon or cursor file, named by its size. */
async function iconPictures({ file, target, options, progress }: ConvertContext): Promise<ConvertResult> {
  const pictures = readIcon(new Uint8Array(await file.arrayBuffer()));
  if (pictures.length === 0) throw new Error('The icon file contains no pictures.');
  const quality = target === 'png' ? undefined : options.quality;
  const files: File[] = [];
  for (const [i, picture] of pictures.entries()) {
    progress(`Writing picture ${i + 1} of ${pictures.length} …`, i / pictures.length);
    const url = URL.createObjectURL(picture.blob);
    const decoded = await decode(url).finally(() => URL.revokeObjectURL(url));
    const { canvas, context } = canvasFor(decoded.naturalWidth, decoded.naturalHeight, target);
    context.drawImage(decoded, 0, 0);
    // Pictures of the same size differ in their colors, e.g. 16 and 256 colors.
    const twin = pictures.some((p) => p !== picture && p.width === picture.width && p.height === picture.height);
    const suffix = pictures.length === 1 ? '' : `${canvas.width}x${canvas.height}${twin && picture.bits ? ` ${picture.bits}-bit` : ''}`;
    files.push(await encodeCanvas(canvas, target, quality, resultName(file.name, target, suffix)));
  }
  return { files, notes: [] };
}
