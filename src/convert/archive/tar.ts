// SPDX-License-Identifier: GPL-3.0-or-later
// TAR (POSIX ustar, with a PAX header for names that are too long or not plain ASCII) written straight into the
// browser's gzip compressor, one entry after another, so the uncompressed TAR never exists in memory.
import type { ArchiveWriter } from './pack';

const BLOCK = 512;
const encoder = new TextEncoder();
// The largest number of a 12-byte octal field (11 digits): 8 GiB − 1 bytes, or the year 2242 as a time.
const MAX_OCTAL = 0o77777777777;
const FLUSH_SIZE = 1 << 20;

const plainAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

/** Zero-padded octal digits; the byte after them stays NUL. */
function octal(header: Uint8Array, offset: number, length: number, value: number): void {
  header.set(encoder.encode(value.toString(8).padStart(length - 1, '0')), offset);
}

function header(name: string, prefix: string, type: string, size: number, mtime: number, mode: number): Uint8Array<ArrayBuffer> {
  const block = new Uint8Array(BLOCK);
  block.set(encoder.encode(name), 0);
  octal(block, 100, 8, mode);
  octal(block, 108, 8, 0); // uid
  octal(block, 116, 8, 0); // gid
  if (size <= MAX_OCTAL) octal(block, 124, 12, size);
  else {
    // Files of 8 GiB and more: GNU base-256, a set high bit and the number big-endian in the other 11 bytes.
    block[124] = 0x80;
    for (let i = 135, rest = size; i > 124; i--, rest = Math.floor(rest / 256)) block[i] = rest % 256;
  }
  octal(block, 136, 12, mtime);
  block[156] = type.charCodeAt(0);
  block.set(encoder.encode('ustar\x0000'), 257);
  block.set(encoder.encode(prefix), 345);
  // The checksum is the sum of all bytes with its own field counted as spaces: six digits, NUL, space.
  block.fill(0x20, 148, 156);
  octal(block, 148, 7, block.reduce((sum, byte) => sum + byte, 0));
  block[154] = 0;
  return block;
}

/** Name and prefix fields for a path ("prefix/name", at most 155 and 100 bytes), or null when it needs a PAX header. */
function ustarName(path: string): [string, string] | null {
  if (!plainAscii(path)) return null;
  if (path.length <= 100) return [path, ''];
  for (let slash = path.indexOf('/'); slash >= 0 && slash <= 155; slash = path.indexOf('/', slash + 1)) {
    const name = path.slice(slash + 1);
    if (name && name.length <= 100) return [name, path.slice(0, slash)];
  }
  return null;
}

/** One PAX record, "<length> <key>=<value>\n", whose length counts its own digits. */
function paxRecord(key: string, value: string): Uint8Array<ArrayBuffer> {
  const body = encoder.encode(` ${key}=${value}\n`);
  let length = body.length + 1;
  while (String(length).length + body.length !== length) length = String(length).length + body.length;
  const record = new Uint8Array(length);
  record.set(encoder.encode(String(length)), 0);
  record.set(body, length - body.length);
  return record;
}

const padding = (size: number) => (BLOCK - (size % BLOCK)) % BLOCK;

export function createTarGzWriter(): ArchiveWriter {
  const gzip = new CompressionStream('gzip');
  const result = new Response(gzip.readable).blob();
  result.catch(() => {}); // rejects after abort(), when nobody waits for it
  const out = gzip.writable.getWriter();

  // Headers, small files and padding are collected and handed to the compressor in blocks of about 1 MB; with
  // thousands of small files, one write per piece takes longer than the compression.
  let pending: Uint8Array<ArrayBuffer>[] = [];
  let pendingSize = 0;
  async function flush(): Promise<void> {
    if (pendingSize === 0) return;
    const block = new Uint8Array(pendingSize);
    let offset = 0;
    for (const part of pending) {
      block.set(part, offset);
      offset += part.length;
    }
    pending = [];
    pendingSize = 0;
    await out.write(block);
  }
  async function write(part: Uint8Array<ArrayBuffer>): Promise<void> {
    pending.push(part);
    pendingSize += part.length;
    if (pendingSize >= FLUSH_SIZE) await flush();
  }

  async function entry(path: string, type: '0' | '5', data: Blob | null, modified: Date, mode: number): Promise<void> {
    const mtime = Math.min(Math.max(Math.floor(modified.getTime() / 1000), 0), MAX_OCTAL) || 0;
    const size = data?.size ?? 0;
    let names = ustarName(path);
    if (!names) {
      // The header keeps a readable ASCII stand-in for readers without PAX support; the others take the PAX path.
      const standIn = path.replace(/[^\x20-\x7e]/g, '_').slice(-100);
      const record = paxRecord('path', path);
      await write(header(`PaxHeaders/${standIn.replace(/\/$/, '')}`.slice(0, 100), '', 'x', record.length, mtime, 0o644));
      await write(record);
      await write(new Uint8Array(padding(record.length)));
      names = [standIn, ''];
    }
    await write(header(names[0], names[1], type, size, mtime, mode));
    if (!data) return;
    if (size <= FLUSH_SIZE) await write(new Uint8Array(await data.arrayBuffer()));
    else {
      await flush();
      const reader = data.stream().getReader();
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) await out.write(chunk.value);
    }
    await write(new Uint8Array(padding(size)));
  }

  return {
    folder: (path, modified, mode) => entry(path, '5', null, modified, mode || 0o755),
    file: (path, data, modified, mode) => entry(path, '0', data, modified, mode || 0o644),
    async close() {
      // The end of the archive: two empty blocks.
      await write(new Uint8Array(BLOCK * 2));
      await flush();
      await out.close();
      return new Blob([await result], { type: 'application/gzip' });
    },
    abort: () => void out.abort().catch(() => {}),
  };
}
