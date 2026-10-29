// SPDX-License-Identifier: GPL-3.0-or-later
// Pictures to one PDF, one page per picture, written by pdf-lib. A JPEG goes in as it is (PDF keeps JPEG data
// unchanged), so nothing is compressed a second time; the image converter prepares everything else.
import { PDFDocument } from '@cantoo/pdf-lib';

export interface PdfPicture {
  /** JPEG or PNG data. */
  bytes: Uint8Array;
  type: 'jpg' | 'png';
  /** Size in pixels. */
  width: number;
  height: number;
}

/** Page sizes in points, portrait; a picture wider than high turns the page. */
const PAGES: Record<string, [number, number]> = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};
const MARGIN = 36;
// A picture is shown at 96 pixels per inch (the size browsers give it), smaller when that does not fit the page.
const POINTS_PER_PIXEL = 72 / 96;

/** `page` is "picture" for pages as large as their picture, or a key of PAGES. */
export async function writePdf(pictures: PdfPicture[], page: string, title: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('Peekbean');
  pdf.setProducer('Peekbean');
  for (const picture of pictures) {
    const image = picture.type === 'jpg' ? await pdf.embedJpg(picture.bytes) : await pdf.embedPng(picture.bytes);
    const natural = [picture.width * POINTS_PER_PIXEL, picture.height * POINTS_PER_PIXEL];
    const size = PAGES[page];
    if (!size) {
      pdf.addPage(natural as [number, number]).drawImage(image, { x: 0, y: 0, width: natural[0], height: natural[1] });
      continue;
    }
    const [width, height] = picture.width > picture.height ? [size[1], size[0]] : size;
    const scale = Math.min(1, (width - 2 * MARGIN) / natural[0], (height - 2 * MARGIN) / natural[1]);
    const [w, h] = [natural[0] * scale, natural[1] * scale];
    pdf.addPage([width, height]).drawImage(image, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h });
  }
  return pdf.save();
}

/**
 * Whether a JPEG can go into the PDF as it is: baseline or progressive with gray or RGB colors, and upright. Turned
 * photos (EXIF orientation), CMYK and arithmetic coding are drawn anew instead, as PDF readers would not turn them or
 * show the colors inverted.
 */
export function plainJpeg(bytes: Uint8Array): boolean {
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let upright = true;
  for (let offset = 2; offset + 4 <= bytes.length; ) {
    if (bytes[offset] !== 0xff) return false;
    const marker = bytes[offset + 1];
    // Fill bytes before a marker.
    if (marker === 0xff) {
      offset++;
      continue;
    }
    const length = view.getUint16(offset + 2);
    if (marker === 0xe1 && String.fromCharCode(...bytes.subarray(offset + 4, offset + 10)) === 'Exif\0\0') {
      upright = exifOrientation(view, offset + 10, offset + 2 + length) <= 1;
    } else if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const components = bytes[offset + 9];
      return upright && marker <= 0xc2 && (components === 1 || components === 3);
    }
    offset += 2 + length;
  }
  return false;
}

/** Orientation tag (0x0112) of the first IFD of the TIFF structure at `start`; 0 without one. */
function exifOrientation(view: DataView, start: number, end: number): number {
  if (start + 8 > end) return 0;
  const little = view.getUint16(start) === 0x4949;
  const ifd = start + view.getUint32(start + 4, little);
  if (ifd + 2 > end) return 0;
  const count = view.getUint16(ifd, little);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > end) break;
    if (view.getUint16(entry, little) === 0x0112) return view.getUint16(entry + 8, little);
  }
  return 0;
}
