// SPDX-License-Identifier: GPL-3.0-or-later
// Splits a large STEP file into smaller ones that OpenCascade can read one at a time. OpenCascade needs about 70 times a
// file's size in memory and has at most 4 GB, so assemblies from about 50 MB on cannot be read in one piece.
//
// Each part keeps the whole skeleton of the file: products, assembly structure, placements, contexts and styles. Of the
// geometry it keeps only some of the solids. References to the solids of other parts are taken out of their lists
// (representation items, styled item lists, layers); entities that need such a solid itself (a style of one of its
// faces) are left out. OpenCascade then places every part as in the whole file, and the results only need joining.

/** Representation items that carry the geometry; everything they reference belongs to them. */
const SOLIDS = new Set(['MANIFOLD_SOLID_BREP', 'BREP_WITH_VOIDS', 'FACETED_BREP', 'SHELL_BASED_SURFACE_MODEL']);

const HASH = 0x23;
const QUOTE = 0x27;
const OPEN = 0x28;
const CLOSE = 0x29;
const STAR = 0x2a;
const COMMA = 0x2c;
const SLASH = 0x2f;
const SEMICOLON = 0x3b;
const EQUALS = 0x3d;

const isDigit = (c: number) => c >= 0x30 && c <= 0x39;
const isSpace = (c: number) => c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09;

/** Index of an ASCII text in the bytes, or -1. */
function find(bytes: Uint8Array, text: string, from: number): number {
  const first = text.charCodeAt(0);
  outer: for (let i = from; i <= bytes.length - text.length; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < text.length; j++) if (bytes[i + j] !== text.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** A Uint32Array that grows. */
class Numbers {
  data: Uint32Array;
  length = 0;
  constructor(capacity: number) {
    this.data = new Uint32Array(Math.max(1024, capacity));
  }
  push(value: number): void {
    if (this.length === this.data.length) {
      const grown = new Uint32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length++] = value;
  }
}

/** The entities of the DATA section: where each one is, and which entities it references. */
interface Entities {
  count: number;
  start: Uint32Array;
  end: Uint32Array;
  /** Refs of entity k: refTarget/refInList from refFrom[k] to refFrom[k + 1]. Targets are entity indices or -1. */
  refFrom: Uint32Array;
  refTarget: Int32Array;
  /** 1 when the reference sits in a list (an aggregate), where it can be taken out. */
  refInList: Uint8Array;
  solids: number[];
  /** Entity number (#123) to index, -1 when the file has no such entity. */
  indexOf(id: number): number;
}

function readEntities(bytes: Uint8Array, from: number, to: number): Entities {
  const ids = new Numbers(bytes.length / 60);
  const start = new Numbers(bytes.length / 60);
  const end = new Numbers(bytes.length / 60);
  const refFrom = new Numbers(bytes.length / 60);
  const refIds = new Numbers(bytes.length / 15);
  const listFlags = new Numbers(bytes.length / 15);
  const solidAt: number[] = [];
  let maxId = 0;
  let i = from;
  while (i < to) {
    let c = bytes[i];
    if (c === SLASH && bytes[i + 1] === STAR) {
      const close = find(bytes, '*/', i + 2);
      i = close < 0 ? to : close + 2;
      continue;
    }
    if (c !== HASH) {
      i++;
      continue;
    }
    let id = 0;
    let j = i + 1;
    while (isDigit((c = bytes[j]))) id = id * 10 + c - 0x30, j++;
    while (j < to && bytes[j] !== EQUALS) j++;
    j++;
    while (isSpace(bytes[j])) j++;
    // Simple instances start with NAME(, complex ones with (NAME(…) NAME(…)); their lists sit one level deeper.
    const complex = bytes[j] === OPEN;
    const listDepth = complex ? 2 : 1;
    if (!complex) {
      let name = '';
      for (let k = j; k < j + 40 && bytes[k] !== OPEN && !isSpace(bytes[k]); k++) name += String.fromCharCode(bytes[k]);
      if (SOLIDS.has(name)) solidAt.push(ids.length);
    }
    ids.push(id);
    start.push(i);
    refFrom.push(refIds.length);
    let depth = 0;
    for (; j < to; j++) {
      c = bytes[j];
      if (c === QUOTE) {
        // A quote inside a string is written twice.
        for (j++; j < to; j++) {
          if (bytes[j] === QUOTE) {
            if (bytes[j + 1] === QUOTE) j++;
            else break;
          }
        }
      } else if (c === SLASH && bytes[j + 1] === STAR) {
        const close = find(bytes, '*/', j + 2);
        j = close < 0 ? to : close + 1;
      } else if (c === OPEN) depth++;
      else if (c === CLOSE) depth--;
      else if (c === SEMICOLON && depth <= 0) break;
      else if (c === HASH) {
        let ref = 0;
        while (isDigit(bytes[j + 1])) ref = ref * 10 + bytes[++j] - 0x30;
        refIds.push(ref);
        listFlags.push(depth > listDepth ? 1 : 0);
      }
    }
    end.push(j + 1);
    maxId = Math.max(maxId, id);
    i = j + 1;
  }
  const count = ids.length;
  refFrom.push(refIds.length);

  // Entity numbers to indices: an array when the numbers are dense enough, as they nearly always are.
  let indexOf: (id: number) => number;
  if (maxId <= count * 8 + 1_000_000) {
    const table = new Int32Array(maxId + 1).fill(-1);
    for (let k = 0; k < count; k++) table[ids.data[k]] = k;
    indexOf = (id) => (id <= maxId ? table[id] : -1);
  } else {
    const map = new Map<number, number>();
    for (let k = 0; k < count; k++) map.set(ids.data[k], k);
    indexOf = (id) => map.get(id) ?? -1;
  }
  const refTarget = new Int32Array(refIds.length);
  for (let r = 0; r < refIds.length; r++) refTarget[r] = indexOf(refIds.data[r]);
  return {
    count,
    start: start.data.subarray(0, count),
    end: end.data.subarray(0, count),
    refFrom: refFrom.data.subarray(0, count + 1),
    refTarget,
    refInList: Uint8Array.from(listFlags.data.subarray(0, listFlags.length)),
    solids: solidAt,
    indexOf,
  };
}

/**
 * The solid each entity belongs to (its index in `solids`), -2 for entities several solids share and -1 for those
 * that belong to none (the skeleton); and the bytes each solid's own geometry takes.
 */
function ownership(e: Entities): { owner: Int32Array; size: Float64Array } {
  const owner = new Int32Array(e.count).fill(-1);
  const size = new Float64Array(e.solids.length);
  const stack: number[] = [];
  e.solids.forEach((root, s) => {
    stack.push(root);
    while (stack.length) {
      const k = stack.pop()!;
      const o = owner[k];
      if (o === s || o === -2) continue;
      // Reached from an earlier solid too: shared, and so is everything below it.
      if (o === -1) {
        owner[k] = s;
        size[s] += e.end[k] - e.start[k];
      } else owner[k] = -2;
      for (let r = e.refFrom[k]; r < e.refFrom[k + 1]; r++) if (e.refTarget[r] >= 0) stack.push(e.refTarget[r]);
    }
  });
  return { owner, size };
}

/** Who references each entity: referrer and whether from inside a list, as offsets into flat arrays. */
function referrers(e: Entities): { from: Uint32Array; source: Uint32Array; inList: Uint8Array } {
  const from = new Uint32Array(e.count + 1);
  for (const t of e.refTarget) if (t >= 0) from[t + 1]++;
  for (let k = 0; k < e.count; k++) from[k + 1] += from[k];
  const fill = from.slice(0, e.count);
  const source = new Uint32Array(from[e.count]);
  const inList = new Uint8Array(from[e.count]);
  for (let k = 0; k < e.count; k++) {
    for (let r = e.refFrom[k]; r < e.refFrom[k + 1]; r++) {
      const t = e.refTarget[r];
      if (t < 0) continue;
      source[fill[t]] = k;
      inList[fill[t]++] = e.refInList[r];
    }
  }
  return { from, source, inList };
}

/** An entity's text with the references to dropped entities taken out of their lists, commas included. */
function withoutRefs(bytes: Uint8Array, start: number, end: number, gone: (id: number) => boolean): Uint8Array {
  const out = new Uint8Array(end - start);
  let w = 0;
  let skipComma = false;
  for (let i = start; i < end; i++) {
    const c = bytes[i];
    if (c === QUOTE) {
      let j = i + 1;
      for (; j < end; j++) {
        if (bytes[j] === QUOTE) {
          if (bytes[j + 1] === QUOTE) j++;
          else break;
        }
      }
      out.set(bytes.subarray(i, j + 1), w);
      w += j + 1 - i;
      i = j;
      skipComma = false;
      continue;
    }
    if (c === HASH && w > 0) {
      let id = 0;
      let j = i + 1;
      while (j < end && isDigit(bytes[j])) id = id * 10 + bytes[j++] - 0x30;
      if (gone(id)) {
        // "(#1,#2)" without #2 drops the comma before it; without #1, the comma after it.
        let p = w - 1;
        while (p >= 0 && isSpace(out[p])) p--;
        if (out[p] === COMMA) w = p;
        else skipComma = true;
        i = j - 1;
        continue;
      }
    }
    if (skipComma && !isSpace(c)) {
      skipComma = false;
      if (c === COMMA) continue;
    }
    out[w++] = c;
  }
  return out.subarray(0, w);
}

export interface SplitStep {
  /** Number of parts. */
  count: number;
  /** The parts as complete STEP files, made one at a time. */
  parts: Generator<Uint8Array<ArrayBuffer>>;
}

/**
 * Splits a STEP file into parts of about `partBytes` each (the skeleton included). Null when that gives fewer than
 * two parts: too few solids, or a file this splitter does not understand (several data sections).
 */
export function splitStep(bytes: Uint8Array, partBytes: number): SplitStep | null {
  const data = find(bytes, 'DATA;', 0);
  if (data < 0) return null;
  const from = data + 5;
  const endsec = find(bytes, 'ENDSEC;', from);
  if (endsec < 0 || find(bytes, 'DATA', endsec) >= 0) return null;
  const e = readEntities(bytes, from, endsec);
  if (e.solids.length < 2) return null;
  const { owner, size } = ownership(e);

  // Solids in file order; what the skeleton takes in every part is left for geometry. Styles of single faces belong
  // to the part of their solid, not to the skeleton.
  let skeleton = 0;
  for (let k = 0; k < e.count; k++) {
    if (owner[k] !== -1) continue;
    let own = true;
    for (let r = e.refFrom[k]; r < e.refFrom[k + 1]; r++) if (!e.refInList[r] && e.refTarget[r] >= 0 && owner[e.refTarget[r]] >= 0) own = false;
    if (own) skeleton += e.end[k] - e.start[k];
  }
  const budget = Math.max(partBytes - skeleton, partBytes / 6);
  const partOf = new Int32Array(e.solids.length);
  let count = 0;
  let filled = 0;
  size.forEach((bytesOfSolid, s) => {
    if (filled > 0 && filled + bytesOfSolid > budget) count++, (filled = 0);
    partOf[s] = count;
    filled += bytesOfSolid;
  });
  count++;
  if (count < 2) return null;

  const refs = referrers(e);
  const header = bytes.subarray(0, from);
  const trailer = new TextEncoder().encode('\nENDSEC;\nEND-ISO-10303-21;\n');

  function* parts(): Generator<Uint8Array<ArrayBuffer>> {
    const dropped = new Uint8Array(e.count);
    const kept = new Uint8Array(e.count);
    const stack: number[] = [];
    for (let part = 0; part < count; part++) {
      dropped.fill(0);
      kept.fill(0);
      // The geometry of the other parts' solids, and whatever needs one of those entities outside a list.
      for (let k = 0; k < e.count; k++) {
        if (owner[k] >= 0 && partOf[owner[k]] !== part) {
          dropped[k] = 1;
          stack.push(k);
        }
      }
      while (stack.length) {
        const k = stack.pop()!;
        for (let r = refs.from[k]; r < refs.from[k + 1]; r++) {
          const s = refs.source[r];
          if (!refs.inList[r] && !dropped[s]) {
            dropped[s] = 1;
            stack.push(s);
          }
        }
      }
      // Kept is what the file's top entities reach without passing a dropped one.
      for (let k = 0; k < e.count; k++) if (refs.from[k] === refs.from[k + 1] && !dropped[k]) stack.push(k);
      while (stack.length) {
        const k = stack.pop()!;
        if (kept[k]) continue;
        kept[k] = 1;
        for (let r = e.refFrom[k]; r < e.refFrom[k + 1]; r++) {
          const t = e.refTarget[r];
          if (t >= 0 && !dropped[t] && !kept[t]) stack.push(t);
        }
      }
      const pieces: Uint8Array[] = [header];
      let length = header.length + trailer.length;
      const newline = trailer.subarray(0, 1);
      for (let k = 0; k < e.count; k++) {
        if (!kept[k]) continue;
        let loses = false;
        for (let r = e.refFrom[k]; r < e.refFrom[k + 1]; r++) if (e.refTarget[r] >= 0 && dropped[e.refTarget[r]]) loses = true;
        const text = loses ? withoutRefs(bytes, e.start[k], e.end[k], isDropped) : bytes.subarray(e.start[k], e.end[k]);
        pieces.push(newline, text);
        length += 1 + text.length;
      }
      pieces.push(trailer);
      const out = new Uint8Array(length);
      let offset = 0;
      for (const piece of pieces) {
        out.set(piece, offset);
        offset += piece.length;
      }
      yield out;
    }

    function isDropped(id: number): boolean {
      const k = e.indexOf(id);
      return k >= 0 && dropped[k] === 1;
    }
  }

  return { count, parts: parts() };
}
