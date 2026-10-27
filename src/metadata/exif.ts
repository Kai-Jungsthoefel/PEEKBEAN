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
import { RAW_EXTENSIONS, inspectRaw, previewBlob, type RawInfo } from '../viewers/camera-raw';
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
  // A string ends at its first NUL; Samsung raws have leftover bytes behind it.
  const make = text(tags.Make).split('\0')[0];
  const model = text(tags.Model).split('\0')[0];
  if (model.toLowerCase().startsWith(make.toLowerCase())) return model;
  return [make, model].filter(Boolean).join(' ');
}

function taken(tags: Tags): MetaRow | null {
  const date = (tags.DateTimeOriginal ?? tags.CreateDate ?? tags.DateCreated) as unknown;
  const shown = text(date);
  if (!shown) return null;
  // Some cameras fill the field with blanks (" :  ").
  const offset = /^[+-]\d\d:\d\d$/.test(text(tags.OffsetTimeOriginal ?? tags.OffsetTime)) ? text(tags.OffsetTimeOriginal ?? tags.OffsetTime) : '';
  // EXIF times are the camera's local time; the offset to UTC is known only when the camera wrote it.
  return { label: 'Taken', value: offset ? `${shown} (UTC${offset})` : shown };
}

function flash(value: unknown): string {
  if (typeof value !== 'number') return '';
  return value & 1 ? 'fired' : 'did not fire';
}

/** The EXIF box of a JPEG XL container: a 4-byte offset to the TIFF header, then the TIFF structure. */
async function jxlExif(file: File): Promise<Uint8Array | null> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  if (String.fromCharCode(...head.subarray(4, 8)) !== 'JXL ') return null;
  for (let pos = 0, i = 0; pos + 8 <= file.size && i < 64; i++) {
    const box = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = box.getUint32(0);
    const type = String.fromCharCode(box.getUint8(4), box.getUint8(5), box.getUint8(6), box.getUint8(7));
    let header = 8;
    if (size === 1) {
      size = Number(box.getBigUint64(8));
      header = 16;
    } else if (size === 0) size = file.size - pos;
    if (size < header) break;
    if (type === 'Exif' && size > header + 4) {
      const data = new Uint8Array(await file.slice(pos + header, pos + size).arrayBuffer());
      return data.subarray(4 + new DataView(data.buffer).getUint32(0));
    }
    pos += size;
  }
  return null;
}

const PARSE_OPTIONS = {
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
};

const parseTags = async (input: Blob | Uint8Array, options: Record<string, unknown> = {}) =>
  ((await parse(input, { ...PARSE_OPTIONS, ...options }).catch(() => null)) ?? {}) as Tags;

/**
 * Canon CR3 keeps IFD0, EXIF and GPS in separate TIFF structures (CMT1, CMT2, CMT4). The latter two are read as the
 * first directory of their TIFF, so their tags are named and revived here with exifr's dictionaries.
 */
async function cr3Tags(file: File, blocks: NonNullable<RawInfo['cr3']>): Promise<Tags> {
  const { tagKeys, tagRevivers } = await import('exifr/src/tags.mjs');
  const block = async (range: [number, number] | undefined, dictionary: 'exif' | 'gps') => {
    if (!range) return {};
    const raw = await parseTags(file.slice(...range), { translateKeys: false, reviveValues: false, exif: false, gps: false, xmp: false, iptc: false });
    const keys = tagKeys.get(dictionary) as Map<number, string> | undefined;
    const revivers = tagRevivers.get(dictionary) as Map<number, (value: unknown) => unknown> | undefined;
    return Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [keys?.get(Number(key)) ?? key, revivers?.get(Number(key))?.(value) ?? value]),
    );
  };
  const tags: Tags = {
    ...(blocks.CMT1 ? await parseTags(file.slice(...blocks.CMT1)) : {}),
    ...(await block(blocks.CMT2, 'exif')),
    ...(await block(blocks.CMT4, 'gps')),
  };
  const degrees = (value: unknown, ref: unknown, negative: string) => {
    if (!Array.isArray(value) || value.length < 3) return NaN;
    const [d, m, s] = value.map(Number);
    return (d + m / 60 + s / 3600) * (String(ref).startsWith(negative) ? -1 : 1);
  };
  tags.latitude = degrees(tags.GPSLatitude, tags.GPSLatitudeRef, 'S');
  tags.longitude = degrees(tags.GPSLongitude, tags.GPSLongitudeRef, 'W');
  return tags;
}

/** Camera raw files: EXIF data in TIFF structures (most raws), CR3 boxes, or an embedded JPEG (RAF, X3F). */
async function rawTags(file: File): Promise<{ tags: Tags; info: RawInfo }> {
  const info = await inspectRaw(file);
  if (info.cr3) return { tags: await cr3Tags(file, info.cr3), info };
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  // Olympus and Panasonic use TIFF magic numbers of their own, which exifr does not check.
  const tiff = info.tiffBlock ? file.slice(...info.tiffBlock) : (head[0] === 0x49 && head[1] === 0x49) || (head[0] === 0x4d && head[1] === 0x4d) ? file : null;
  // Values far into the file (CR2's user comment) need a larger chunk; Panasonic's embedded JPEG (tag 46) is skipped.
  let tags = tiff ? await parseTags(tiff, { chunkSize: 1 << 20, firstChunkSize: 1 << 20, ifd0: { skip: [0x002e] } }) : {};
  // RAF, X3F and some Kodak files keep the shot's EXIF data only in the embedded JPEG.
  const jpeg = info.exifJpeg ? file.slice(...info.exifJpeg) : null;
  const preview = info.previews.find((p) => p.exif.length);
  if (!tags.Model || !tags.ExposureTime) {
    const extra = jpeg ?? (preview ? previewBlob(file, preview, 0) : null);
    if (extra) tags = { ...(await parseTags(extra)), ...tags };
  }
  return { tags, info };
}

export async function imageMetadata(file: File, extension: string): Promise<MetaSection[]> {
  let raw: RawInfo | null = null;
  let tags: Tags;
  if (RAW_EXTENSIONS.includes(extension)) ({ tags, info: raw } = await rawTags(file));
  else {
    const input = extension === 'webp' ? await webpExif(file) : extension === 'jxl' ? await jxlExif(file) : file;
    if (!input) return [];
    tags = await parseTags(input);
  }

  // In raw files IFD0 often describes a thumbnail; when the camera wrote no image size, the largest preview stands in,
  // or the sensor size if there is no preview of at least half of it.
  const preview = raw?.previews[0];
  const full = raw && (!preview || Math.max(preview.width, preview.height) * 2 < Math.max(raw.rawWidth, raw.rawHeight));
  const width = Number(tags.ExifImageWidth ?? tags.PixelXDimension ?? (raw ? (full ? raw.rawWidth : preview?.width) : tags.ImageWidth));
  const height = Number(tags.ExifImageHeight ?? tags.PixelYDimension ?? (raw ? (full ? raw.rawHeight : preview?.height) : tags.ImageHeight));
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
      row('Sensor data', raw?.rawWidth ? `${raw.rawWidth} × ${raw.rawHeight} pixels` : ''),
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
