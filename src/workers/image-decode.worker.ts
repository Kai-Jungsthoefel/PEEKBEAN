// SPDX-License-Identifier: GPL-3.0-or-later
// Decodes image formats browsers cannot show by themselves into RGBA pixels:
// TIFF (UTIF2, MIT), Photoshop (ag-psd, MIT), HEIC/HEIF (libheif, LGPL-3.0), TGA, DDS, OpenEXR and Radiance HDR
// (three.js loaders, MIT; DXT blocks via decode-dxt, MIT), DNG raw data (raw-develop.ts) and JPEG XL (jxl-oxide, MIT OR
// Apache-2.0; handed back as PNG). High dynamic range images are tone mapped.
import * as UTIF from 'utif2';
import { readPsd } from 'ag-psd';
import decodeDxt from 'decode-dxt';
import { FloatType, RGBAFormat, RGBA_S3TC_DXT3_Format, RGBA_S3TC_DXT5_Format, RGB_S3TC_DXT1_Format, RGFormat } from 'three';
import { DDSLoader } from 'three/addons/loaders/DDSLoader.js';
import { EXRLoader } from 'three/addons/loaders/EXRLoader.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { TGALoader } from 'three/addons/loaders/TGALoader.js';
import type { DecodeRequest, DecodeResponse } from './image-decode-types';
import { developRaw } from './raw-develop';
import { toneMap } from './tonemap';

type Pixels = { width: number; height: number; data: Uint8ClampedArray; pages: number; png?: boolean; note?: string };

function decodeTga(buffer: ArrayBuffer): Pixels {
  // Rows come out top first, whatever origin the file uses.
  const { data, width, height } = new TGALoader().parse(buffer) as { data: Uint8Array; width: number; height: number };
  return { width, height, data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), pages: 1 };
}

const DXT: Record<number, string> = { [RGB_S3TC_DXT1_Format]: 'dxt1', [RGBA_S3TC_DXT3_Format]: 'dxt3', [RGBA_S3TC_DXT5_Format]: 'dxt5' };

function decodeDds(buffer: ArrayBuffer): Pixels {
  const dds = new DDSLoader().parse(buffer, false) as { mipmaps: { data: Uint8Array; width: number; height: number }[]; format: number | null; isCubemap: boolean };
  // A cube map shows its first face.
  const top = dds.mipmaps[0];
  if (!top || dds.format === null) throw new Error('This DDS file uses a format that is not supported (only DXT1/3/5 and uncompressed RGB(A)).');
  const { width, height } = top;
  if (dds.format === RGBAFormat) return { width, height, data: new Uint8ClampedArray(top.data.buffer, top.data.byteOffset, top.data.byteLength), pages: 1 };
  const dxt = DXT[dds.format];
  if (!dxt) throw new Error('This DDS compression (BC6H or ETC1) cannot be decoded yet.');
  // Block formats cover whole 4×4 blocks; decode the padded size and crop.
  const paddedWidth = Math.ceil(width / 4) * 4;
  const paddedHeight = Math.ceil(height / 4) * 4;
  const rgba = decodeDxt(new DataView(top.data.buffer, top.data.byteOffset, top.data.byteLength), paddedWidth, paddedHeight, dxt);
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) data.set(rgba.subarray(y * paddedWidth * 4, (y * paddedWidth + width) * 4), y * width * 4);
  return { width, height, data, pages: 1 };
}

function decodeExr(buffer: ArrayBuffer): Pixels {
  const loader = new EXRLoader().setDataType(FloatType);
  const { data, width, height, format } = loader.parse(buffer) as unknown as { data: Float32Array; width: number; height: number; format: number };
  const channels = format === RGBAFormat ? 4 : format === RGFormat ? 2 : 1;
  // The loader stores the bottom row first, as WebGL textures expect.
  return { width, height, data: toneMap(data, width, height, channels, true), pages: 1 };
}

function decodeHdr(buffer: ArrayBuffer): Pixels {
  const loader = new HDRLoader().setDataType(FloatType);
  const { data, width, height } = loader.parse(buffer) as unknown as { data: Float32Array; width: number; height: number };
  return { width, height, data: toneMap(data, width, height, 4), pages: 1 };
}

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
    const decoders: Record<DecodeRequest['format'], () => Pixels | Promise<Pixels>> = {
      tiff: () => decodeTiff(buffer, page),
      psd: () => decodePsd(buffer),
      heic: () => decodeHeic(buffer, page),
      tga: () => decodeTga(buffer),
      dds: () => decodeDds(buffer),
      exr: () => decodeExr(buffer),
      hdr: () => decodeHdr(buffer),
      jxl: async () => ({ ...(await (await import('./jxl-decode')).decodeJxl(buffer)), pages: 1 }),
      dng: () => ({ ...developRaw(buffer), pages: 1, note: 'Developed from raw' }),
    };
    const pixels = await decoders[format]();
    const response: DecodeResponse = { ok: true, ...pixels };
    (self as unknown as Worker).postMessage(response, [pixels.data.buffer as ArrayBuffer]);
  } catch (error) {
    const response: DecodeResponse = { ok: false, error: error instanceof Error ? error.message : String(error) };
    (self as unknown as Worker).postMessage(response);
  }
};
