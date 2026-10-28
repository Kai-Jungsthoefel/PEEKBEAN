// SPDX-License-Identifier: GPL-3.0-or-later
// Compound File Binary (OLE2) containers, read-only: SolidWorks up to 2014, Inventor, Solid Edge and old Office files
// keep their streams in one. Layout per [MS-CFB]: a FAT of sector chains, a directory tree, and a mini stream for
// streams below 4 KB.

export interface CfbEntry {
  /** Path from the root without the root's name, parts joined by "/". */
  path: string;
  name: string;
  kind: 'storage' | 'stream';
  size: number;
}

export interface Cfb {
  entries: CfbEntry[];
  /** Bytes of a stream by path (case-insensitive), or null. */
  read(path: string): Uint8Array | null;
}

const SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const NO_STREAM = 0xffffffff;

export function isCfb(head: Uint8Array): boolean {
  return SIGNATURE.every((b, i) => head[i] === b);
}

export function readCfb(data: Uint8Array): Cfb {
  if (!isCfb(data)) throw new Error('Not an OLE compound file.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const u32 = (offset: number) => view.getUint32(offset, true);
  const sectorSize = 1 << view.getUint16(0x1e, true);
  const miniSectorSize = 1 << view.getUint16(0x20, true);
  const miniCutoff = u32(0x38);
  const perSector = sectorSize / 4;
  const sectorOffset = (sector: number) => (sector + 1) * sectorSize;
  const maxSectors = Math.ceil(data.length / sectorSize);

  // The FAT's own sectors are listed in the header (109) and in a chain of DIFAT sectors.
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const sector = u32(0x4c + i * 4);
    if (sector < maxSectors) fatSectors.push(sector);
  }
  let difat = u32(0x44);
  for (let guard = 0; difat < maxSectors && guard < maxSectors; guard++) {
    const base = sectorOffset(difat);
    for (let i = 0; i < perSector - 1; i++) {
      const sector = u32(base + i * 4);
      if (sector < maxSectors) fatSectors.push(sector);
    }
    difat = u32(base + sectorSize - 4);
  }
  const fat = new Uint32Array(fatSectors.length * perSector);
  fatSectors.forEach((sector, i) => {
    const base = sectorOffset(sector);
    for (let j = 0; j < perSector && base + j * 4 + 4 <= data.length; j++) fat[i * perSector + j] = u32(base + j * 4);
  });

  /** Concatenated sectors of a chain; a damaged chain (loop, out of range) simply ends. */
  function chain(table: Uint32Array, start: number, read: (sector: number) => Uint8Array, limit: number): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    const seen = new Set<number>();
    for (let sector = start; sector !== END_OF_CHAIN && sector < table.length && !seen.has(sector) && total < limit; sector = table[sector]) {
      seen.add(sector);
      const part = read(sector);
      parts.push(part);
      total += part.length;
    }
    const out = new Uint8Array(Math.min(total, limit));
    let offset = 0;
    for (const part of parts) {
      const take = Math.min(part.length, out.length - offset);
      out.set(part.subarray(0, take), offset);
      offset += take;
    }
    return out;
  }
  const bigSector = (sector: number) => data.subarray(sectorOffset(sector), Math.min(data.length, sectorOffset(sector) + sectorSize));

  const directory = chain(fat, u32(0x30), bigSector, Infinity);
  const dirView = new DataView(directory.buffer, directory.byteOffset, directory.byteLength);
  const count = Math.floor(directory.length / 128);
  const entry = (i: number) => {
    const base = i * 128;
    const nameLength = Math.max(0, Math.min(64, dirView.getUint16(base + 0x40, true)) - 2);
    let name = '';
    for (let j = 0; j < nameLength; j += 2) name += String.fromCharCode(dirView.getUint16(base + j, true));
    return {
      name,
      type: directory[base + 0x42],
      left: dirView.getUint32(base + 0x44, true),
      right: dirView.getUint32(base + 0x48, true),
      child: dirView.getUint32(base + 0x4c, true),
      start: dirView.getUint32(base + 0x74, true),
      // Version 3 files may leave junk in the high half of the size.
      size: sectorSize === 512 ? dirView.getUint32(base + 0x78, true) : dirView.getUint32(base + 0x78, true) + dirView.getUint32(base + 0x7c, true) * 2 ** 32,
    };
  };
  if (!count) throw new Error('The OLE compound file has no directory.');
  const root = entry(0);

  // Small streams live in the mini stream (the root entry's data), cut into 64-byte sectors listed in the mini FAT.
  const miniStream = root.start < maxSectors ? chain(fat, root.start, bigSector, root.size) : new Uint8Array(0);
  const miniFatBytes = chain(fat, u32(0x3c), bigSector, Infinity);
  const miniFat = new Uint32Array(Math.floor(miniFatBytes.length / 4));
  const miniFatView = new DataView(miniFatBytes.buffer, miniFatBytes.byteOffset, miniFatBytes.byteLength);
  for (let i = 0; i < miniFat.length; i++) miniFat[i] = miniFatView.getUint32(i * 4, true);
  const miniSector = (sector: number) => miniStream.subarray(sector * miniSectorSize, (sector + 1) * miniSectorSize);

  const entries: CfbEntry[] = [];
  const starts = new Map<string, { start: number; size: number }>();
  const visited = new Set<number>();
  // The children of a storage form a red-black tree over left/right siblings; the order does not matter here.
  function walk(index: number, parent: string): void {
    const stack = [index];
    while (stack.length) {
      const i = stack.pop()!;
      if (i === NO_STREAM || i >= count || visited.has(i)) continue;
      visited.add(i);
      const e = entry(i);
      stack.push(e.left, e.right);
      if (e.type !== 1 && e.type !== 2) continue;
      const path = parent ? `${parent}/${e.name}` : e.name;
      entries.push({ path, name: e.name, kind: e.type === 1 ? 'storage' : 'stream', size: e.size });
      if (e.type === 2) starts.set(path.toLowerCase(), { start: e.start, size: e.size });
      else walk(e.child, path);
    }
  }
  walk(root.child, '');

  return {
    entries,
    read(path) {
      const found = starts.get(path.toLowerCase());
      if (!found) return null;
      if (found.size < miniCutoff) return chain(miniFat, found.start, miniSector, found.size);
      return chain(fat, found.start, bigSector, found.size);
    },
  };
}
