// SPDX-License-Identifier: GPL-3.0-or-later
// Camera raw files. Nearly every raw file carries the camera's own JPEG rendering of the shot, mostly at (near) full
// size; this finds those previews, the orientation and the sensor size without developing the raw data. TIFF-based
// raws (DNG, CR2, NEF, ARW, ORF, RW2, PEF, SRW, 3FR, IIQ …) are walked through their IFDs, sub-IFDs, EXIF and maker
// notes; CR3 (ISO media boxes), RAF, CRW, MRW and X3F have containers of their own.

export interface JpegPreview {
  offset: number;
  length: number;
  width: number;
  height: number;
  /** EXIF orientation written into the JPEG itself, 0 if none. */
  orientation: number;
  /** APP1 EXIF segments of the JPEG as [start, end) file positions. */
  exif: [number, number][];
}

export interface RawInfo {
  /** Valid baseline/progressive JPEG previews, largest first. */
  previews: JpegPreview[];
  /** EXIF orientation of the raw file (1–8), 0 if unknown. */
  orientation: number;
  /** Size of the sensor data, 0 if unknown. */
  rawWidth: number;
  rawHeight: number;
  /** Largest uncompressed RGB thumbnail, the only picture in some medium format raws (3FR, IIQ, DCR). */
  thumbnail: RgbThumbnail | null;
  /** DNG files can be developed when they carry no usable preview. */
  dng: boolean;
  /** CR3 metadata blocks (TIFF structures): CMT1 = IFD0, CMT2 = EXIF, CMT4 = GPS. */
  cr3?: Partial<Record<'CMT1' | 'CMT2' | 'CMT4', [number, number]>>;
  /** RAF and the like: a JPEG whose EXIF describes the shot. */
  exifJpeg?: [number, number];
  /** MRW: the TIFF block with the EXIF data. */
  tiffBlock?: [number, number];
}

export interface RgbThumbnail {
  offset: number;
  width: number;
  height: number;
  /** 8 or 16 bits per sample. */
  bits: number;
  le: boolean;
}

export const RAW_EXTENSIONS = [
  'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2', 'rwl', 'raf', 'pef', 'srw', '3fr', 'iiq',
  'erf', 'kdc', 'dcr', 'mos', 'mrw', 'x3f',
];

const BLOCK = 1 << 16;

/** Random access to a file in cached 64 KB blocks: headers spread over a large raw file cost a few small reads. */
class Bytes {
  readonly file: Blob;
  readonly size: number;
  private readonly blocks = new Map<number, Promise<Uint8Array>>();

  constructor(file: Blob) {
    this.file = file;
    this.size = file.size;
  }

  private block(index: number): Promise<Uint8Array> {
    let block = this.blocks.get(index);
    if (!block) {
      block = this.file.slice(index * BLOCK, (index + 1) * BLOCK).arrayBuffer().then((b) => new Uint8Array(b));
      this.blocks.set(index, block);
    }
    return block;
  }

  /** Up to `length` bytes at `offset`; fewer at the end of the file. */
  async get(offset: number, length: number): Promise<Uint8Array> {
    const end = Math.min(this.size, offset + length);
    if (offset < 0 || offset >= end) return new Uint8Array(0);
    const first = Math.floor(offset / BLOCK);
    const last = Math.floor((end - 1) / BLOCK);
    if (first === last) {
      const block = await this.block(first);
      return block.subarray(offset - first * BLOCK, end - first * BLOCK);
    }
    if (last - first > 4) return new Uint8Array(await this.file.slice(offset, end).arrayBuffer());
    const out = new Uint8Array(end - offset);
    for (let i = first; i <= last; i++) {
      const block = await this.block(i);
      const from = Math.max(offset, i * BLOCK);
      const to = Math.min(end, (i + 1) * BLOCK);
      out.set(block.subarray(from - i * BLOCK, to - i * BLOCK), from - offset);
    }
    return out;
  }
}

const u16 = (b: Uint8Array, o: number, le: boolean) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
const u32 = (b: Uint8Array, o: number, le: boolean) =>
  (le ? b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24) : (b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const ascii = (b: Uint8Array, from = 0, to = b.length) => String.fromCharCode(...b.subarray(from, to));

// ---- TIFF ---------------------------------------------------------------------------------------------------

/** A TIFF structure: offsets inside are relative to `base`. */
interface Tiff {
  base: number;
  le: boolean;
}

interface Entry {
  type: number;
  count: number;
  /** File position of the value (inline values sit in the entry itself). */
  at: number;
}

type Ifd = Map<number, Entry>;

// Bytes per value of each TIFF type (13 = IFD, 16 = LONG8 in BigTIFF).
const TYPE_SIZE = [1, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4, 1, 1, 8];

async function readIfd(r: Bytes, t: Tiff, offset: number): Promise<{ entries: Ifd; next: number } | null> {
  const pos = t.base + offset;
  if (offset <= 0 || pos + 2 > r.size) return null;
  const count = u16(await r.get(pos, 2), 0, t.le);
  if (count === 0 || count > 1000) return null;
  const b = await r.get(pos + 2, count * 12 + 4);
  if (b.length < count * 12) return null;
  const entries: Ifd = new Map();
  for (let i = 0; i < count; i++) {
    const e = i * 12;
    const type = u16(b, e + 2, t.le);
    const n = u32(b, e + 4, t.le);
    const size = (TYPE_SIZE[type] ?? 1) * n;
    entries.set(u16(b, e, t.le), { type, count: n, at: size <= 4 ? pos + 2 + e + 8 : t.base + u32(b, e + 8, t.le) });
  }
  return { entries, next: b.length >= count * 12 + 4 ? u32(b, count * 12, t.le) : 0 };
}

/** Integer values of an entry (BYTE, SHORT, LONG, IFD; rationals as quotients). */
async function values(r: Bytes, t: Tiff, entry: Entry | undefined, max = 64): Promise<number[]> {
  if (!entry) return [];
  const n = Math.min(entry.count, max);
  const size = TYPE_SIZE[entry.type] ?? 1;
  const b = await r.get(entry.at, n * size);
  const out: number[] = [];
  for (let i = 0; i < n && (i + 1) * size <= b.length; i++) {
    const o = i * size;
    if (size === 1) out.push(b[o]);
    else if (size === 2) out.push(u16(b, o, t.le));
    else if (entry.type === 5) out.push(u32(b, o, t.le) / (u32(b, o + 4, t.le) || 1));
    else out.push(u32(b, o, t.le));
  }
  return out;
}

const first = async (r: Bytes, t: Tiff, ifd: Ifd, tag: number) => (await values(r, t, ifd.get(tag), 1))[0] ?? 0;

/** What a scan collects: possible JPEG previews as file position → length, and facts about the raw file. */
class Scan {
  readonly candidates = new Map<number, number>();
  orientation = 0;
  rawWidth = 0;
  rawHeight = 0;
  dng = false;
  thumbnail: RgbThumbnail | null = null;

  add(offset: number, length: number): void {
    if (length >= 512 && offset >= 0) this.candidates.set(offset, Math.max(length, this.candidates.get(offset) ?? 0));
  }

  sensor(width: number, height: number): void {
    if (width * height > this.rawWidth * this.rawHeight) {
      this.rawWidth = width;
      this.rawHeight = height;
    }
  }
}

const CFA = 32803;
const LINEAR_RAW = 34892;

async function scanIfd(r: Bytes, t: Tiff, ifd: Ifd, scan: Scan, depth: number, isIfd0: boolean): Promise<void> {
  if (depth > 5) return;
  const one = (tag: number) => first(r, t, ifd, tag);
  if (isIfd0) {
    const orientation = await one(274);
    if (orientation >= 1 && orientation <= 8) scan.orientation = orientation;
    if (ifd.has(50706)) scan.dng = true;
  }
  // JPEGInterchangeFormat (thumbnails, Nikon and Sony previews), Panasonic's JpgFromRaw (tag 46).
  if (ifd.has(513) && ifd.has(514)) scan.add(t.base + (await one(513)), await one(514));
  const jpgFromRaw = ifd.get(46);
  if (jpgFromRaw && (jpgFromRaw.type === 7 || jpgFromRaw.type === 1)) scan.add(jpgFromRaw.at, jpgFromRaw.count);
  // Leaf MOS: records "PKTS", version, 40-byte name, size, data in tag 0x8606.
  const leaf = ifd.get(0x8606);
  if (leaf) {
    const b = await r.get(leaf.at, Math.min(leaf.count, 1 << 18));
    const at = new TextDecoder('latin1').decode(b).indexOf('JPEG_preview_data\0');
    if (at >= 0) scan.add(leaf.at + at + 44, u32(b, at + 40, false));
  }
  const compression = await one(259);
  const photometric = await one(262);
  const width = await one(256);
  const height = await one(257);
  // A JPEG stored as a single strip (CR2's full-size preview, DNG preview IFDs). Lossless raw data is weeded out later.
  if ((compression === 6 || compression === 7) && ifd.get(273)?.count === 1 && photometric !== CFA && photometric !== LINEAR_RAW) {
    scan.add(t.base + (await one(273)), await one(279));
  }
  const bits = await one(258);
  const samples = ifd.has(277) ? await one(277) : 1;
  // Uncompressed RGB in one block (the strips follow each other in all files seen).
  if (compression === 1 && photometric === 2 && samples === 3 && (bits === 8 || bits === 16) && width * height > (scan.thumbnail ? scan.thumbnail.width * scan.thumbnail.height : 0)) {
    scan.thumbnail = { offset: t.base + (await one(273)), width, height, bits, le: t.le };
  }
  if (photometric === CFA || photometric === LINEAR_RAW || (bits > 8 && photometric !== 2 && compression !== 6 && compression !== 7)) scan.sensor(width, height);
  // Panasonic RW2: sensor size in tags 2 and 3.
  if (isIfd0 && ifd.has(2) && ifd.has(3) && ifd.has(46)) scan.sensor(await one(2), await one(3));

  for (const offset of await values(r, t, ifd.get(330), 16)) {
    const sub = await readIfd(r, t, offset);
    if (sub) await scanIfd(r, t, sub.entries, scan, depth + 1, false);
  }
  const exif = await readIfd(r, t, await one(34665));
  if (exif) await scanIfd(r, t, exif.entries, scan, depth + 1, false);
  const makerNote = ifd.get(37500);
  if (makerNote) await scanMakerNote(r, t, makerNote, scan, depth + 1);
}

/** IFD0, IFD1 … of a TIFF structure. */
async function scanTiff(r: Bytes, t: Tiff, offset: number, scan: Scan, depth = 0): Promise<void> {
  const seen = new Set<number>();
  for (let i = 0; offset && i < 8 && !seen.has(offset); i++) {
    seen.add(offset);
    const ifd = await readIfd(r, t, offset);
    if (!ifd) break;
    await scanIfd(r, t, ifd.entries, scan, depth, i === 0 && depth === 0);
    offset = ifd.next;
  }
}

// Preview start/length tag pairs in maker notes: TIFF thumbnail tags, Olympus, Minolta/Epson, Pentax.
const PREVIEW_TAGS: [number, number][] = [[0x0201, 0x0202], [0x0101, 0x0102], [0x0088, 0x0089], [0x0004, 0x0003]];
// Sub-directories with previews: Nikon PreviewIFD, Olympus CameraSettings.
const PREVIEW_IFDS = [0x0011, 0x2020];

async function scanMakerNoteIfd(r: Bytes, t: Tiff, outer: Tiff, ifd: Ifd, scan: Scan, depth: number): Promise<void> {
  for (const [startTag, lengthTag] of PREVIEW_TAGS) {
    if (!ifd.has(startTag) || !ifd.has(lengthTag)) continue;
    const start = await first(r, t, ifd, startTag);
    const length = await first(r, t, ifd, lengthTag);
    // Whether offsets count from the maker note or the enclosing TIFF differs between makes; wrong ones fail validation.
    scan.add(t.base + start, length);
    if (outer.base !== t.base) scan.add(outer.base + start, length);
  }
  // Previews stored inline: Sony's PreviewImage (0x2001), Olympus/Minolta PreviewImage (0x0081), and others.
  for (const entry of ifd.values()) if ((entry.type === 7 || entry.type === 1) && entry.count >= 4096) scan.add(entry.at, entry.count);
  if (depth > 6) return;
  for (const tag of PREVIEW_IFDS) {
    const entry = ifd.get(tag);
    if (!entry) continue;
    // Either an offset (LONG/IFD) or the directory itself as UNDEFINED bytes.
    const sub = entry.type === 7 ? await readIfd(r, t, entry.at - t.base) : await readIfd(r, t, await first(r, t, ifd, tag));
    if (sub) await scanMakerNoteIfd(r, t, outer, sub.entries, scan, depth + 1);
  }
}

async function scanMakerNote(r: Bytes, t: Tiff, entry: Entry, scan: Scan, depth: number): Promise<void> {
  const at = entry.at;
  const head = await r.get(at, 18);
  const sig = ascii(head);
  const byteOrder = (o: number) => (head[o] === 0x49 ? true : head[o] === 0x4d ? false : t.le);
  let sub: Tiff;
  let offset: number;
  if (sig.startsWith('Nikon\0')) {
    // "Nikon\0", version, then a TIFF header of its own.
    sub = { base: at + 10, le: byteOrder(10) };
    offset = u32(head, 14, sub.le);
  } else if (sig.startsWith('OLYMPUS\0') || sig.startsWith('PENTAX \0')) {
    sub = { base: at, le: byteOrder(8) };
    offset = sig.startsWith('OLYMPUS') ? 12 : 10;
  } else if (sig.startsWith('OM SYSTEM\0')) {
    sub = { base: at, le: byteOrder(12) };
    offset = 16;
  } else {
    // Old Olympus/Epson/Minolta ("OLYMP\0", "EPSON\0"), Pentax "AOC\0", Sony, Panasonic, or a bare IFD (Canon, Samsung).
    sub = t;
    const skip = sig.startsWith('OLYMP\0') || sig.startsWith('EPSON\0') || sig.startsWith('SEMC MS\0') ? 8 : sig.startsWith('AOC\0') ? 6 : sig.startsWith('SONY') || sig.startsWith('Panasonic\0') ? 12 : 0;
    offset = at + skip - t.base;
  }
  const ifd = await readIfd(r, sub, offset);
  if (ifd) await scanMakerNoteIfd(r, sub, t, ifd.entries, scan, depth);
}

// ---- JPEG ---------------------------------------------------------------------------------------------------

/** Orientation tag of the TIFF structure at `pos` (inside an EXIF segment). */
async function tiffOrientation(r: Bytes, pos: number): Promise<number> {
  const head = await r.get(pos, 8);
  if (head.length < 8) return 0;
  const t: Tiff = { base: pos, le: head[0] === 0x49 };
  const ifd = await readIfd(r, t, u32(head, 4, t.le));
  return ifd ? first(r, t, ifd.entries, 274) : 0;
}

interface JpegScan {
  preview: JpegPreview | null;
  /** Further images listed in a Multi-Picture Format index (larger previews of Fujifilm, Pentax …). */
  more: [number, number][];
  /** Lossless JPEG (raw data): its frame size. */
  lossless?: [number, number];
}

async function scanJpeg(r: Bytes, offset: number, length: number): Promise<JpegScan> {
  const none: JpegScan = { preview: null, more: [] };
  length = Math.min(length, r.size - offset);
  const soi = await r.get(offset, 3);
  // Epson and Minolta previews start with a wrong first byte (0xEE, 0x02); the rest of the structure must be right.
  if (soi[1] !== 0xd8 || soi[2] !== 0xff) return none;
  const end = offset + length;
  const exif: [number, number][] = [];
  const more: [number, number][] = [];
  let orientation = 0;
  for (let pos = offset + 2, i = 0; pos + 4 <= end && i < 256; i++) {
    const m = await r.get(pos, 4);
    if (m[0] !== 0xff) return none;
    const marker = m[1];
    if (marker === 0xff) {
      pos++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const size = (m[2] << 8) | m[3];
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const sof = await r.get(pos + 4, 6);
      const height = (sof[1] << 8) | sof[2];
      const width = (sof[3] << 8) | sof[4];
      // Only 8-bit baseline, extended and progressive JPEGs are pictures a browser shows.
      if (marker > 0xc2 || sof[0] !== 8) return { preview: null, more: [], lossless: [width * sof[5], height] };
      if (!width || !height) return none;
      return { preview: { offset, length, width, height, orientation, exif }, more };
    }
    if (marker === 0xe1) {
      if (ascii(await r.get(pos + 4, 6)) === 'Exif\0\0') {
        exif.push([pos, pos + 2 + size]);
        orientation = await tiffOrientation(r, pos + 10);
      }
    } else if (marker === 0xe2 && ascii(await r.get(pos + 4, 4)) === 'MPF\0') {
      // MP index: entries of 16 bytes (attributes, size, offset from the MPF TIFF header); the first is this image.
      const t: Tiff = { base: pos + 8, le: (await r.get(pos + 8, 1))[0] === 0x49 };
      const index = await readIfd(r, t, u32(await r.get(pos + 12, 4), 0, t.le));
      const entries = index?.entries.get(0xb002);
      if (entries) {
        const b = await r.get(entries.at, Math.min(entries.count, 16 * 16));
        for (let e = 16; e + 16 <= b.length; e += 16) {
          const imageSize = u32(b, e + 4, t.le);
          const imageOffset = u32(b, e + 8, t.le);
          if (imageOffset) more.push([t.base + imageOffset, imageSize]);
        }
      }
    }
    pos += 2 + size;
  }
  return none;
}

// ---- Other containers ---------------------------------------------------------------------------------------

/** ISO media boxes in [from, to): type → [content start, end]; repeated types get a numeric suffix (trak, trak2 …). */
async function boxes(r: Bytes, from: number, to: number): Promise<Map<string, [number, number]>> {
  const out = new Map<string, [number, number]>();
  for (let pos = from, i = 0; pos + 8 <= to && i < 256; i++) {
    const b = await r.get(pos, 16);
    let size = u32(b, 0, false);
    let header = 8;
    if (size === 1) {
      size = u32(b, 8, false) * 2 ** 32 + u32(b, 12, false);
      header = 16;
    } else if (size === 0) size = to - pos;
    if (size < header) break;
    let type = ascii(b, 4, 8);
    if (type === 'uuid') {
      type = Array.from(await r.get(pos + header, 16), (x) => x.toString(16).padStart(2, '0')).join('');
      header += 16;
    }
    let key = type;
    for (let n = 2; out.has(key); n++) key = `${type}${n}`;
    out.set(key, [pos + header, Math.min(to, pos + size)]);
    pos += size;
  }
  return out;
}

const CANON_UUID = '85c0b687820f11e08111f4ce462b6a48';
const CANON_PREVIEW_UUID = 'eaf42b5e1c984b88b9fbb7dc406e4d16';

/** Canon CR3: the first track holds the full-size JPEG, a "PRVW" box a smaller one, CMT boxes the metadata. */
async function scanCr3(r: Bytes, scan: Scan, info: Partial<RawInfo>): Promise<void> {
  const top = await boxes(r, 0, r.size);
  const moov = top.get('moov');
  if (moov) {
    const inner = await boxes(r, moov[0], moov[1]);
    const canon = inner.get(CANON_UUID);
    if (canon) {
      const cmt = await boxes(r, canon[0], canon[1]);
      info.cr3 = {};
      for (const name of ['CMT1', 'CMT2', 'CMT4'] as const) {
        const box = cmt.get(name);
        if (box) info.cr3[name] = box;
      }
      const ifd0 = cmt.get('CMT1');
      if (ifd0) {
        const le = (await r.get(ifd0[0], 1))[0] === 0x49;
        const t: Tiff = { base: ifd0[0], le };
        const ifd = await readIfd(r, t, u32(await r.get(ifd0[0] + 4, 4), 0, le));
        const orientation = ifd ? await first(r, t, ifd.entries, 274) : 0;
        if (orientation >= 1 && orientation <= 8) scan.orientation = orientation;
      }
    }
    for (const [key, [start, end]] of inner) {
      if (!key.startsWith('trak')) continue;
      const mdia = (await boxes(r, start, end)).get('mdia');
      const minf = mdia && (await boxes(r, mdia[0], mdia[1])).get('minf');
      const stbl = minf && (await boxes(r, minf[0], minf[1])).get('stbl');
      if (!stbl) continue;
      const table = await boxes(r, stbl[0], stbl[1]);
      const stsd = table.get('stsd');
      // Sample description "CRAW" (a visual sample entry): width and height after 24 bytes of fields.
      const entry = stsd && (await r.get(stsd[0] + 8, 44));
      if (entry && ascii(entry, 4, 8) === 'CRAW' && key !== 'trak') scan.sensor(u16(entry, 32, false), u16(entry, 34, false));
      if (key !== 'trak') continue;
      const stsz = table.get('stsz');
      const co64 = table.get('co64');
      const stco = table.get('stco');
      if (!stsz || (!co64 && !stco)) continue;
      const sizes = await r.get(stsz[0], 16);
      const size = u32(sizes, 4, false) || u32(sizes, 12, false);
      const offsets = await r.get((co64 ?? stco)![0], 16);
      const offset = co64 ? u32(offsets, 8, false) * 2 ** 32 + u32(offsets, 12, false) : u32(offsets, 8, false);
      scan.add(offset, size);
    }
  }
  const preview = top.get(CANON_PREVIEW_UUID);
  if (preview) {
    const prvw = (await boxes(r, preview[0] + 8, preview[1])).get('PRVW');
    if (prvw) scan.add(prvw[0] + 16, u32(await r.get(prvw[0] + 12, 4), 0, false));
  }
}

/** Fujifilm RAF: a header with the position of a JPEG (with the shot's EXIF data) and the sensor data. */
async function scanRaf(r: Bytes, scan: Scan, info: Partial<RawInfo>): Promise<void> {
  const head = await r.get(0, 108);
  const offset = u32(head, 84, false);
  const length = u32(head, 88, false);
  scan.add(offset, length);
  info.exifJpeg = [offset, offset + length];
  // CFA header: records of tag, size, data; 0x100 is the full raw size (height, width).
  const cfa = await r.get(u32(head, 92, false), Math.min(u32(head, 96, false), 4096));
  for (let pos = 4, n = 0, count = u32(cfa, 0, false); n < count && pos + 4 <= cfa.length; n++) {
    const tag = u16(cfa, pos, false);
    const size = u16(cfa, pos + 2, false);
    if (tag === 0x100 && size >= 4) scan.sensor(u16(cfa, pos + 6, false), u16(cfa, pos + 4, false));
    pos += 4 + size;
  }
}

/** Canon CRW (CIFF): nested heaps; tag 0x2007 is the full-size JPEG. */
async function scanCiffHeap(r: Bytes, start: number, end: number, scan: Scan, depth: number): Promise<void> {
  if (depth > 4 || end - start < 6) return;
  const dir = start + u32(await r.get(end - 4, 4), 0, true);
  const count = u16(await r.get(dir, 2), 0, true);
  const b = await r.get(dir + 2, Math.min(count, 512) * 10);
  for (let i = 0; i + 10 <= b.length; i += 10) {
    const tag = u16(b, i, true);
    const size = u32(b, i + 2, true);
    const offset = start + u32(b, i + 6, true);
    if (tag & 0xc000) continue;
    if ((tag & 0x3fff) === 0x2007) scan.add(offset, size);
    else if ((tag & 0x3800) === 0x2800 || (tag & 0x3800) === 0x3000) await scanCiffHeap(r, offset, offset + size, scan, depth + 1);
  }
}

/** Minolta MRW: blocks "\0PRD" (sensor size), "\0TTW" (a TIFF with EXIF and a maker note with the preview) … */
async function scanMrw(r: Bytes, scan: Scan, info: Partial<RawInfo>): Promise<void> {
  const end = 8 + u32(await r.get(4, 4), 0, false);
  for (let pos = 8, i = 0; pos + 8 <= end && i < 32; i++) {
    const b = await r.get(pos, 8);
    const name = ascii(b, 0, 4);
    const size = u32(b, 4, false);
    if (name === '\0PRD') {
      const prd = await r.get(pos + 8, 12);
      scan.sensor(u16(prd, 10, false), u16(prd, 8, false));
    } else if (name === '\0TTW') {
      info.tiffBlock = [pos + 8, pos + 8 + size];
      const le = (await r.get(pos + 8, 1))[0] === 0x49;
      await scanTiff(r, { base: pos + 8, le }, u32(await r.get(pos + 12, 4), 0, le), scan);
    }
    pos += 8 + size;
  }
}

/** Sigma X3F: a section directory at the end; image sections of format 18 are JPEG. */
async function scanX3f(r: Bytes, scan: Scan): Promise<void> {
  const dir = u32(await r.get(r.size - 4, 4), 0, true);
  const head = await r.get(dir, 12);
  if (ascii(head, 0, 4) !== 'SECd') return;
  const count = Math.min(u32(head, 8, true), 256);
  const b = await r.get(dir + 12, count * 12);
  for (let i = 0; i + 12 <= b.length; i += 12) {
    const offset = u32(b, i, true);
    const length = u32(b, i + 4, true);
    const type = ascii(b, i + 8, i + 12);
    if (type !== 'IMA2' && type !== 'IMAG') continue;
    const section = await r.get(offset, 28);
    const format = u32(section, 12, true);
    if (format === 18) scan.add(offset + 28, length - 28);
    else scan.sensor(u32(section, 16, true), u32(section, 20, true));
  }
}

// ---- Entry points -------------------------------------------------------------------------------------------

/** Finds the camera's JPEG previews and what else the viewer needs to know about a raw file. */
export async function inspectRaw(file: Blob): Promise<RawInfo> {
  const r = new Bytes(file);
  const scan = new Scan();
  const info: Partial<RawInfo> = {};
  const head = await r.get(0, 32);
  const sig = ascii(head, 0, 16);
  if (head[0] === 0xff && head[1] === 0xd8) scan.add(0, r.size); // a JPEG with a raw extension
  else if (sig.startsWith('FUJIFILMCCD-RAW')) await scanRaf(r, scan, info);
  else if (ascii(head, 4, 12) === 'ftypcrx ') await scanCr3(r, scan, info);
  else if (sig.startsWith('FOVb')) await scanX3f(r, scan);
  else if (sig.startsWith('\0MRM')) await scanMrw(r, scan, info);
  else if (ascii(head, 6, 14) === 'HEAPCCDR') await scanCiffHeap(r, u32(head, 2, true), r.size, scan, 0);
  else if (sig.startsWith('II') || sig.startsWith('MM')) {
    // Standard TIFF magic 42, Olympus "RO"/"RS"/"OR", Panasonic 0x55.
    const le = head[0] === 0x49;
    await scanTiff(r, { base: 0, le }, u32(head, 4, le), scan);
  }

  const previews: JpegPreview[] = [];
  const seen = new Set<number>();
  const queue = [...scan.candidates];
  while (queue.length) {
    const [offset, length] = queue.shift()!;
    if (seen.has(offset)) continue;
    seen.add(offset);
    const jpeg = await scanJpeg(r, offset, length);
    if (jpeg.preview) previews.push(jpeg.preview);
    // Canon CR2 has no sensor size tags; its lossless JPEG frame tells it.
    if (jpeg.lossless) scan.sensor(...jpeg.lossless);
    queue.push(...jpeg.more);
  }
  previews.sort((a, b) => b.width * b.height - a.width * a.height || b.length - a.length);
  const { orientation, rawWidth, rawHeight, thumbnail, dng } = scan;
  return { ...info, previews, orientation, rawWidth, rawHeight, thumbnail, dng };
}

/** RGBA pixels of an uncompressed thumbnail. */
export async function thumbnailPixels(file: Blob, thumb: RgbThumbnail): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const { offset, width, height, bits, le } = thumb;
  const step = bits / 8;
  const b = new Uint8Array(await file.slice(offset, offset + width * height * 3 * step).arrayBuffer());
  const count = Math.min(width * height * 3, Math.floor(b.length / step));
  const samples = new Uint16Array(count);
  for (let i = 0; i < count; i++) samples[i] = step === 1 ? b[i] : le ? b[2 * i] | (b[2 * i + 1] << 8) : (b[2 * i] << 8) | b[2 * i + 1];
  // 16-bit thumbnails (Kodak) hold dark linear values: scaled so that the brightest half percent clips, then sRGB-encoded.
  let encode = (v: number) => v;
  if (step === 2) {
    const sorted = samples.filter((_, i) => i % 7 === 0).sort();
    const white = Math.max(1, sorted[Math.floor(sorted.length * 0.995)] ?? 1);
    encode = (v) => {
      const x = Math.min(1, v / white);
      return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
    };
  }
  const out = new Uint8ClampedArray(width * height * 4);
  for (let p = 0; p < width * height; p++) {
    out[p * 4] = encode(samples[p * 3] ?? 0);
    out[p * 4 + 1] = encode(samples[p * 3 + 1] ?? 0);
    out[p * 4 + 2] = encode(samples[p * 3 + 2] ?? 0);
    out[p * 4 + 3] = 255;
  }
  return out;
}

/** EXIF segment with nothing but an orientation tag. */
function orientationSegment(orientation: number): Uint8Array<ArrayBuffer> {
  // APP1, length 34: "Exif\0\0", big-endian TIFF header, one IFD entry (0x0112, SHORT, 1, value), no next IFD.
  return new Uint8Array([
    0xff, 0xe1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0x00, 0x00, 0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08,
    0x00, 0x01, 0x01, 0x12, 0x00, 0x03, 0x00, 0x00, 0x00, 0x01, 0x00, orientation, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  ]);
}

/**
 * The preview as a JPEG blob, turned like the raw file says: previews are mostly stored as the sensor saw the scene,
 * and the orientation belongs to the raw file. The browser applies the EXIF orientation of the JPEG it shows, so the
 * preview's own EXIF segments give way to one carrying the raw file's orientation. The image data is not copied.
 */
export function previewBlob(file: Blob, preview: JpegPreview, orientation: number): Blob {
  const { offset, length } = preview;
  // A fresh start-of-image marker repairs the previews that begin with a wrong byte.
  const parts: BlobPart[] = [new Uint8Array([0xff, 0xd8])];
  let pos = offset + 2;
  if (orientation && orientation !== (preview.orientation || 1)) {
    parts.push(orientationSegment(orientation));
    for (const [start, end] of preview.exif) {
      parts.push(file.slice(pos, start));
      pos = end;
    }
  }
  parts.push(file.slice(pos, offset + length));
  return new Blob(parts, { type: 'image/jpeg' });
}
