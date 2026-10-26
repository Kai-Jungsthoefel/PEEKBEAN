// SPDX-License-Identifier: GPL-3.0-or-later

export type DecodeFormat = 'tiff' | 'psd' | 'heic';

export interface DecodeRequest {
  format: DecodeFormat;
  buffer: ArrayBuffer;
  /** Page (TIFF) or image (HEIC) index. */
  page: number;
}

export type DecodeResponse =
  | { ok: true; width: number; height: number; data: Uint8ClampedArray; pages: number }
  | { ok: false; error: string };
