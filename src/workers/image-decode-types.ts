// SPDX-License-Identifier: GPL-3.0-or-later

export type DecodeFormat = 'tiff' | 'psd' | 'heic' | 'tga' | 'dds' | 'exr' | 'hdr' | 'jxl' | 'dng';

export interface DecodeRequest {
  format: DecodeFormat;
  buffer: ArrayBuffer;
  /** Page (TIFF) or image (HEIC) index. */
  page: number;
}

export type DecodeResponse =
  | {
      ok: true;
      width: number;
      height: number;
      /** RGBA pixels, or an encoded PNG (JPEG XL: the browser handles 16 bits and color profiles itself). */
      data: Uint8ClampedArray;
      png?: boolean;
      pages: number;
      /** Shown before the size in the toolbar, e.g. "First frame of 12". */
      note?: string;
    }
  | { ok: false; error: string };
