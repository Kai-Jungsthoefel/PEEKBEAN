// SPDX-License-Identifier: GPL-3.0-or-later
// Video and audio metadata: recording time, place and device from MP4/MOV boxes (as written by phones and cameras),
// tags from MP3 (ID3v2) and FLAC, duration and picture size from the browser's media element.
import { formatDate, formatDuration, locationRows, parseIso6709, row, section, type MetaRow, type MetaSection } from './model';

const MAC_EPOCH = Date.UTC(1904, 0, 1);
const MAX_MOOV = 64 * 1024 * 1024;
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'edts', 'dinf']);

const CODECS: Record<string, string> = {
  avc1: 'H.264',
  avc3: 'H.264',
  hvc1: 'H.265 (HEVC)',
  hev1: 'H.265 (HEVC)',
  av01: 'AV1',
  vp08: 'VP8',
  vp09: 'VP9',
  mp4v: 'MPEG-4 Video',
  'apcn': 'Apple ProRes 422',
  'apch': 'Apple ProRes 422 HQ',
  'ap4h': 'Apple ProRes 4444',
  mp4a: 'AAC',
  alac: 'Apple Lossless',
  'ac-3': 'Dolby Digital',
  'ec-3': 'Dolby Digital Plus',
  Opus: 'Opus',
  fLaC: 'FLAC',
  lpcm: 'PCM',
  sowt: 'PCM',
  twos: 'PCM',
};

interface Box {
  type: string;
  start: number;
  end: number;
}

const fourcc = (bytes: Uint8Array, at: number) => String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

function* children(bytes: Uint8Array, start: number, end: number): Generator<Box> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let pos = start; pos + 8 <= end; ) {
    let size = view.getUint32(pos);
    let header = 8;
    if (size === 1 && pos + 16 <= end) {
      size = Number(view.getBigUint64(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return;
    yield { type: fourcc(bytes, pos + 4), start: pos + header, end: pos + size };
    pos += size;
  }
}

/** Finds the top-level "moov" box by reading only box headers, so large videos are not loaded completely. */
async function readMoov(file: File): Promise<Uint8Array | null> {
  for (let pos = 0; pos + 8 <= file.size; ) {
    const head = new DataView(await file.slice(pos, pos + 16).arrayBuffer());
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    if (size === 1) size = Number(head.getBigUint64(8));
    else if (size === 0) size = file.size - pos;
    if (size < 8) return null;
    if (type === 'moov') return size <= MAX_MOOV ? new Uint8Array(await file.slice(pos, pos + size).arrayBuffer()) : null;
    pos += size;
  }
  return null;
}

/** Text of an iTunes-style "data" box (type 1 = UTF-8). */
function dataValue(bytes: Uint8Array, item: Box): string {
  for (const data of children(bytes, item.start, item.end)) {
    if (data.type !== 'data' || data.end - data.start < 8) continue;
    const kind = new DataView(bytes.buffer, bytes.byteOffset).getUint32(data.start) & 0xffffff;
    const payload = bytes.subarray(data.start + 8, data.end);
    if (kind === 1) return new TextDecoder().decode(payload);
    if (kind === 2) return new TextDecoder('utf-16be').decode(payload);
  }
  return '';
}

interface BmffInfo {
  created?: Date;
  duration?: number;
  width?: number;
  height?: number;
  codecs: string[];
  tags: Map<string, string>;
}

function parseMoov(bytes: Uint8Array): BmffInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const info: BmffInfo = { codecs: [], tags: new Map() };
  const tag = (key: string, value: string) => {
    if (value.trim() && !info.tags.has(key)) info.tags.set(key, value.trim());
  };

  const meta = (box: Box) => {
    // MP4 "meta" is a full box with version and flags, QuickTime's is not.
    let start = box.start;
    if (fourcc(bytes, start + 4) !== 'hdlr' && fourcc(bytes, start + 8) === 'hdlr') start += 4;
    const keys: string[] = [];
    for (const child of children(bytes, start, box.end)) {
      if (child.type === 'keys') {
        let pos = child.start + 8;
        for (let i = 0; i < view.getUint32(child.start + 4) && pos + 8 <= child.end; i++) {
          const size = view.getUint32(pos);
          keys.push(new TextDecoder().decode(bytes.subarray(pos + 8, pos + size)));
          pos += size;
        }
      } else if (child.type === 'ilst') {
        for (const item of children(bytes, child.start, child.end)) {
          // Items are either named (©nam) or numbered entries of the "keys" box (Apple).
          const index = view.getUint32(item.start - 4);
          const name = keys.length && index >= 1 && index <= keys.length ? keys[index - 1] : item.type;
          tag(name, dataValue(bytes, item));
        }
      }
    }
  };

  const walk = (start: number, end: number, path: string) => {
    for (const box of children(bytes, start, end)) {
      const at = `${path}/${box.type}`;
      if (box.type === 'mvhd') {
        const v1 = bytes[box.start] === 1;
        const created = v1 ? Number(view.getBigUint64(box.start + 4)) : view.getUint32(box.start + 4);
        const scale = view.getUint32(box.start + (v1 ? 20 : 12));
        const duration = v1 ? Number(view.getBigUint64(box.start + 24)) : view.getUint32(box.start + 16);
        if (created > 0) info.created = new Date(MAC_EPOCH + created * 1000);
        if (scale > 0) info.duration = duration / scale;
      } else if (box.type === 'tkhd') {
        const width = view.getUint32(box.end - 8) / 65536;
        const height = view.getUint32(box.end - 4) / 65536;
        if (width > 0 && height > 0 && !info.width) {
          info.width = Math.round(width);
          info.height = Math.round(height);
        }
      } else if (box.type === 'stsd' && box.end - box.start >= 16) {
        const codec = fourcc(bytes, box.start + 12);
        info.codecs.push(CODECS[codec] ?? codec.trim());
      } else if (box.type === 'meta') {
        meta(box);
      } else if (path.endsWith('/udta') && box.type.charCodeAt(0) === 0xa9) {
        // QuickTime user data text: 16-bit length, 16-bit language, text.
        const length = view.getUint16(box.start);
        if (length && box.start + 4 + length <= box.end) tag(box.type, new TextDecoder().decode(bytes.subarray(box.start + 4, box.start + 4 + length)));
        else tag(box.type, dataValue(bytes, box));
      } else if (CONTAINERS.has(box.type)) {
        walk(box.start, box.end, at);
      }
    }
  };
  for (const moov of children(bytes, 0, bytes.length)) if (moov.type === 'moov') walk(moov.start, moov.end, '/moov');
  return info;
}

async function bmffSections(file: File): Promise<MetaSection[]> {
  const moov = await readMoov(file);
  if (!moov) return [];
  const info = parseMoov(moov);
  const t = (...keys: string[]) => keys.map((k) => info.tags.get(k)).find(Boolean) ?? '';
  const appleDate = t('com.apple.quicktime.creationdate');
  const location = parseIso6709(t('com.apple.quicktime.location.ISO6709', '©xyz'));
  const device = [t('com.apple.quicktime.make', '©mak'), t('com.apple.quicktime.model', '©mod')].filter(Boolean);
  const recorded: MetaRow | null = appleDate
    ? { label: 'Recorded', value: appleDate.replace(/^(\d{4}-\d\d-\d\d)T(\d\d:\d\d:\d\d)([+-]\d\d)(\d\d)$/, '$1 $2 (UTC$3:$4)') }
    : info.created
      ? { label: 'Created', value: formatDate(info.created) }
      : null;
  return [
    section('Recording', [
      recorded,
      row('Device', device.length === 2 && device[1].startsWith(device[0]) ? device[1] : device.join(' ')),
      row('Software', t('com.apple.quicktime.software', '©swr', '©too')),
    ]),
    section('Location', location ? locationRows(location.latitude, location.longitude, location.altitude) : []),
    section('Tags', [
      row('Title', t('©nam', 'com.apple.quicktime.title')),
      row('Artist', t('©ART')),
      row('Album', t('©alb')),
      row('Year', t('©day')),
      row('Genre', t('©gen')),
      row('Comment', t('©cmt', 'com.apple.quicktime.description')),
    ]),
    section('Technical', [
      row('Duration', info.duration ? formatDuration(info.duration) : ''),
      row('Frame size', info.width ? `${info.width} × ${info.height} pixels` : ''),
      row('Codecs', [...new Set(info.codecs)].join(', ')),
    ]),
  ].filter((s): s is MetaSection => s !== null);
}

/** ID3v2.3/2.4 text frames of an MP3 file. */
async function id3Sections(file: File): Promise<MetaSection[]> {
  const head = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (fourcc(head, 0).slice(0, 3) !== 'ID3' || (head[3] !== 3 && head[3] !== 4)) return [];
  const syncsafe = (b: Uint8Array, at: number) => (b[at] << 21) | (b[at + 1] << 14) | (b[at + 2] << 7) | b[at + 3];
  const size = syncsafe(head, 6);
  const bytes = new Uint8Array(await file.slice(10, 10 + size).arrayBuffer());
  const view = new DataView(bytes.buffer);
  const frames = new Map<string, string>();
  let cover = false;
  const decode = (data: Uint8Array) => {
    const encoding = data[0];
    const body = data.subarray(1);
    const decoder = encoding === 1 ? new TextDecoder('utf-16') : encoding === 2 ? new TextDecoder('utf-16be') : encoding === 3 ? new TextDecoder() : new TextDecoder('latin1');
    return decoder.decode(body);
  };
  const list = (value: string) => value.split('\0').map((v) => v.trim()).filter(Boolean).join(' / ');
  for (let pos = 0; pos + 10 <= bytes.length; ) {
    const id = fourcc(bytes, pos);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const length = head[3] === 4 ? syncsafe(bytes, pos + 4) : view.getUint32(pos + 4);
    const data = bytes.subarray(pos + 10, pos + 10 + length);
    if (id === 'APIC') cover = true;
    // Comment: language, short description, then the text after the description's terminator.
    else if (id === 'COMM' && data.length > 4 && !frames.has(id)) frames.set(id, decode(new Uint8Array([data[0], ...data.subarray(4)])).replace(/^[^\0]*\0+/, '').trim());
    else if (id[0] === 'T' && id !== 'TXXX' && !frames.has(id)) frames.set(id, list(decode(data)));
    pos += 10 + length;
  }
  const f = (id: string) => frames.get(id) ?? '';
  return [
    section('Tags', [
      row('Title', f('TIT2')),
      row('Artist', f('TPE1')),
      row('Album', f('TALB')),
      row('Album artist', f('TPE2')),
      row('Year', f('TDRC') || f('TYER')),
      row('Track', f('TRCK')),
      row('Genre', f('TCON')),
      row('Composer', f('TCOM')),
      row('Comment', f('COMM')),
      row('Cover', cover ? 'embedded' : ''),
      row('Encoded with', f('TSSE') || f('TENC')),
    ]),
  ].filter((s): s is MetaSection => s !== null);
}

/** Vorbis comments of a FLAC file. */
async function flacSections(file: File): Promise<MetaSection[]> {
  const bytes = new Uint8Array(await file.slice(0, Math.min(file.size, 4 * 1024 * 1024)).arrayBuffer());
  if (fourcc(bytes, 0) !== 'fLaC') return [];
  const view = new DataView(bytes.buffer);
  const tags = new Map<string, string>();
  for (let pos = 4; pos + 4 <= bytes.length; ) {
    const last = bytes[pos] & 0x80;
    const type = bytes[pos] & 0x7f;
    const length = (bytes[pos + 1] << 16) | (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (type === 4 && pos + 4 + length <= bytes.length) {
      let at = pos + 4;
      at += 4 + view.getUint32(at, true);
      const count = view.getUint32(at, true);
      at += 4;
      for (let i = 0; i < count && at + 4 <= pos + 4 + length; i++) {
        const size = view.getUint32(at, true);
        const entry = new TextDecoder().decode(bytes.subarray(at + 4, at + 4 + size));
        const eq = entry.indexOf('=');
        if (eq > 0 && !tags.has(entry.slice(0, eq).toUpperCase())) tags.set(entry.slice(0, eq).toUpperCase(), entry.slice(eq + 1));
        at += 4 + size;
      }
    }
    if (last) break;
    pos += 4 + length;
  }
  const t = (key: string) => tags.get(key) ?? '';
  return [
    section('Tags', [
      row('Title', t('TITLE')),
      row('Artist', t('ARTIST')),
      row('Album', t('ALBUM')),
      row('Year', t('DATE')),
      row('Track', t('TRACKNUMBER')),
      row('Genre', t('GENRE')),
      row('Comment', t('COMMENT') || t('DESCRIPTION')),
    ]),
  ].filter((s): s is MetaSection => s !== null);
}

/** Duration and picture size as the browser reads them; works for every format it can play. */
function elementInfo(file: File): Promise<{ duration: number; width: number; height: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    const done = (value: { duration: number; width: number; height: number } | null) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 4000);
    video.preload = 'metadata';
    video.muted = true;
    video.onloadedmetadata = () => done({ duration: video.duration, width: video.videoWidth, height: video.videoHeight });
    video.onerror = () => done(null);
    video.src = url;
  });
}

export async function mediaMetadata(file: File, extension: string): Promise<MetaSection[]> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const sections =
    fourcc(head, 4) === 'ftyp' || ['mov', 'qt'].includes(extension)
      ? await bmffSections(file)
      : extension === 'mp3' || fourcc(head, 0).startsWith('ID3')
        ? await id3Sections(file)
        : fourcc(head, 0) === 'fLaC'
          ? await flacSections(file)
          : [];
  if (!sections.some((s) => s.title === 'Technical')) {
    const media = await elementInfo(file);
    const tech = media && section('Technical', [
      row('Duration', formatDuration(media.duration)),
      row('Frame size', media.width ? `${media.width} × ${media.height} pixels` : ''),
    ]);
    if (tech) sections.push(tech);
  }
  return sections;
}
