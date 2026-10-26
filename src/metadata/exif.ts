// SPDX-License-Identifier: GPL-3.0-or-later
// Photo metadata (EXIF, GPS, XMP, IPTC, PNG text) with exifr (MIT). Assembled from exifr's sources with only the
// parts a browser needs: the bundled builds would add Node.js file and network readers.
import { parse } from 'exifr/src/core.mjs';
import 'exifr/src/file-readers/BlobReader.mjs';
import 'exifr/src/file-parsers/jpeg.mjs';
import 'exifr/src/file-parsers/tiff.mjs';
import 'exifr/src/file-parsers/heif.mjs';
import 'exifr/src/file-parsers/png.mjs';
import 'exifr/src/segment-parsers/tiff-exif.mjs';
import 'exifr/src/segment-parsers/xmp.mjs';
import 'exifr/src/segment-parsers/iptc.mjs';
import 'exifr/src/segment-parsers/ihdr.mjs';
import 'exifr/src/dicts/tiff-ifd0-keys.mjs';
import 'exifr/src/dicts/tiff-exif-keys.mjs';
import 'exifr/src/dicts/tiff-gps-keys.mjs';
import 'exifr/src/dicts/tiff-revivers.mjs';
import 'exifr/src/dicts/iptc-keys.mjs';
import 'exifr/src/dicts/ihdr-keys.mjs';
import { formatNumber, locationRows, row, section, text, type MetaRow, type MetaSection } from './model';

type Tags = Record<string, unknown>;

const ORIENTATION: Record<number, string> = {
  1: 'normal',
  2: 'mirrored',
  3: 'rotated 180°',
  4: 'flipped vertically',
  5: 'mirrored and rotated 90° counterclockwise',
  6: 'rotated 90° clockwise',
  7: 'mirrored and rotated 90° clockwise',
  8: 'rotated 90° counterclockwise',
};

/** The EXIF block of a WebP file (RIFF chunk "EXIF"), which exifr cannot find by itself. */
async function webpExif(file: File): Promise<Uint8Array | null> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const view = new DataView(bytes.buffer);
  for (let pos = 12; pos + 8 <= bytes.length; ) {
    const id = String.fromCharCode(...bytes.subarray(pos, pos + 4));
    const size = view.getUint32(pos + 4, true);
    if (id === 'EXIF') {
      let data = bytes.subarray(pos + 8, pos + 8 + size);
      // Some writers keep the "Exif\0\0" prefix of the JPEG segment.
      if (data[0] === 0x45 && data[1] === 0x78 && data[2] === 0x69 && data[3] === 0x66) data = data.subarray(6);
      return data;
    }
    pos += 8 + size + (size & 1);
  }
  return null;
}

function exposure(tags: Tags): string {
  const parts: string[] = [];
  const time = Number(tags.ExposureTime);
  if (time > 0) parts.push(time < 1 ? `1/${Math.round(1 / time)} s` : `${formatNumber(time, 1)} s`);
  if (Number(tags.FNumber) > 0) parts.push(`f/${formatNumber(Number(tags.FNumber), 1)}`);
  const iso = Number(tags.ISO ?? tags.ISOSpeedRatings);
  if (iso > 0) parts.push(`ISO ${iso}`);
  return parts.join(' · ');
}

function focalLength(tags: Tags): string {
  const mm = Number(tags.FocalLength);
  if (!(mm > 0)) return '';
  const full = Number(tags.FocalLengthIn35mmFormat);
  return `${formatNumber(mm, 1)} mm${full > 0 && Math.round(full) !== Math.round(mm) ? ` (${full} mm equivalent)` : ''}`;
}

function camera(tags: Tags): string {
  const make = text(tags.Make);
  const model = text(tags.Model);
  if (model.toLowerCase().startsWith(make.toLowerCase())) return model;
  return [make, model].filter(Boolean).join(' ');
}

function taken(tags: Tags): MetaRow | null {
  const date = (tags.DateTimeOriginal ?? tags.CreateDate ?? tags.DateCreated) as unknown;
  const shown = text(date);
  if (!shown) return null;
  const offset = text(tags.OffsetTimeOriginal ?? tags.OffsetTime);
  // EXIF times are the camera's local time; the offset to UTC is known only when the camera wrote it.
  return { label: 'Taken', value: offset ? `${shown} (UTC${offset})` : shown };
}

function flash(value: unknown): string {
  if (typeof value !== 'number') return '';
  return value & 1 ? 'fired' : 'did not fire';
}

export async function imageMetadata(file: File, extension: string): Promise<MetaSection[]> {
  const input = extension === 'webp' ? await webpExif(file) : file;
  if (!input) return [];
  const tags = ((await parse(input, {
    tiff: true,
    ifd0: true,
    exif: true,
    gps: true,
    ifd1: false,
    interop: false,
    xmp: true,
    iptc: true,
    icc: false,
    jfif: false,
    ihdr: true,
    makerNote: false,
    userComment: true,
    translateValues: false,
    mergeOutput: true,
    silentErrors: true,
  }).catch(() => null)) ?? {}) as Tags;

  const width = Number(tags.ExifImageWidth ?? tags.PixelXDimension ?? tags.ImageWidth);
  const height = Number(tags.ExifImageHeight ?? tags.PixelYDimension ?? tags.ImageHeight);
  const direction = Number(tags.GPSImgDirection);
  // Altitude reference 1 means below sea level; exifr returns it as a byte array.
  const altitudeRef = tags.GPSAltitudeRef instanceof Uint8Array ? tags.GPSAltitudeRef[0] : Number(tags.GPSAltitudeRef);
  const location = locationRows(Number(tags.latitude), Number(tags.longitude), tags.GPSAltitude === undefined ? undefined : Number(tags.GPSAltitude) * (altitudeRef === 1 ? -1 : 1));

  return [
    section('Capture', [
      taken(tags),
      row('Camera', camera(tags)),
      row('Lens', tags.LensModel ?? tags.Lens),
      row('Exposure', exposure(tags)),
      row('Focal length', focalLength(tags)),
      row('Flash', flash(tags.Flash)),
      row('Orientation', typeof tags.Orientation === 'number' ? ORIENTATION[tags.Orientation] : ''),
    ]),
    section('Location', [...location, ...(location.length && Number.isFinite(direction) ? [{ label: 'Direction', value: `${formatNumber(direction, 0)}°` }] : [])]),
    section('Image', [
      row('Dimensions', width > 0 && height > 0 ? `${width} × ${height} pixels` : ''),
      row('Title', tags.title ?? tags.ObjectName ?? tags.Title),
      row('Description', tags.ImageDescription ?? tags.description ?? tags.Caption ?? tags.Description),
      row('Comment', tags.UserComment ?? tags.Comment),
      row('Artist', tags.Artist ?? tags.creator ?? tags.Byline ?? tags.Author),
      row('Copyright', tags.Copyright ?? tags.rights ?? tags.CopyrightNotice),
      row('Keywords', tags.Keywords ?? tags.subject),
      row('Rating', Number(tags.Rating) > 0 ? `${tags.Rating} of 5` : ''),
      row('Software', tags.Software ?? tags.CreatorTool),
      row('Edited', tags.ModifyDate),
      row('Created', tags['Creation Time']),
    ]),
  ].filter((s): s is MetaSection => s !== null);
}
