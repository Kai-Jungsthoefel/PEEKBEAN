// SPDX-License-Identifier: GPL-3.0-or-later
// Decodes image formats browsers cannot show by themselves into RGBA pixels:
// TIFF (UTIF2, MIT), Photoshop (ag-psd, MIT) and HEIC/HEIF (libheif, LGPL-3.0).
import * as UTIF from 'utif2';
import { readPsd } from 'ag-psd';
import type { DecodeRequest, DecodeResponse } from './image-decode-types';

type Pixels = { width: number; height: number; data: Uint8ClampedArray; pages: number };

function decodeTiff(buffer: ArrayBuffer, page: number): Pixels {
  const ifds = UTIF.decode(buffer).filter((ifd) => ifd['t256'] !== undefined);
  if (ifds.length === 0) throw new Error('The TIFF file contains no image.');
  const ifd = ifds[Math.min(page, ifds.length - 1)];
  UTIF.decodeImage(buffer, ifd);
  const rgba = UTIF.toRGBA8(ifd);
  return { width: ifd.width, height: ifd.height, data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength), pages: ifds.length };
}

function decodePsd(buffer: ArrayBuffer): Pixels {
  const psd = readPsd(buffer, { skipLayerImageData: true, skipThumbnail: true, useImageData: true });
  if (!psd.imageData) throw new Error('The PSD file contains no composite image (turn on “Maximize compatibility” in Photoshop).');
  const { width, height, data } = psd.imageData;
  return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), pages: 1 };
}

let libheif: Promise<any> | null = null;

async function decodeHeic(buffer: ArrayBuffer, page: number): Promise<Pixels> {
  libheif ??= import('libheif-js/libheif-wasm/libheif-bundle.mjs').then((m) => m.default());
  const lib = await libheif;
  const images = new lib.HeifDecoder().decode(new Uint8Array(buffer));
  if (!images?.length) throw new Error('The HEIC file contains no readable image.');
  const image = images[Math.min(page, images.length - 1)];
  const width: number = image.get_width();
  const height: number = image.get_height();
  const target = { data: new Uint8ClampedArray(width * height * 4), width, height };
  await new Promise<void>((resolve, reject) =>
    image.display(target, (result: unknown) => (result ? resolve() : reject(new Error('The HEIC image could not be decoded.')))),
  );
  for (const img of images) img.free?.();
  return { ...target, pages: images.length };
}

self.onmessage = async (event: MessageEvent<DecodeRequest>) => {
  const { format, buffer, page } = event.data;
  try {
    const pixels = format === 'tiff' ? decodeTiff(buffer, page) : format === 'psd' ? decodePsd(buffer) : await decodeHeic(buffer, page);
    const response: DecodeResponse = { ok: true, ...pixels };
    (self as unknown as Worker).postMessage(response, [pixels.data.buffer as ArrayBuffer]);
  } catch (error) {
    const response: DecodeResponse = { ok: false, error: error instanceof Error ? error.message : String(error) };
    (self as unknown as Worker).postMessage(response);
  }
};
