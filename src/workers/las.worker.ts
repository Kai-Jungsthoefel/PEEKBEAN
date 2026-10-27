// SPDX-License-Identifier: GPL-3.0-or-later
// Reads LAS 1.0–1.4 point clouds (point formats 0–10) off the main thread; LAZ is decompressed with laz-perf
// (Apache-2.0, WebAssembly). Large clouds are thinned to every Nth point. Positions are stored relative to the center
// of the cloud, so float32 keeps millimeters even in projected coordinates, and sorted by class and grid cell: each
// class becomes one part, and the cells let picking look at a few thousand points instead of millions.
import createLazPerf from 'laz-perf/lib/worker/laz-perf.js';
import wasmUrl from 'laz-perf/lib/worker/laz-perf.wasm?url';

export interface LasRequest {
  file: File;
  /** Most points to keep; more are thinned to every Nth. */
  budget: number;
}

export interface LasHeader {
  version: string;
  pointFormat: number;
  compressed: boolean;
  /** Points in the file. */
  count: number;
  systemId: string;
  software: string;
  /** Unit of the coordinates: from the coordinate system in the file, else meters (the usual case). */
  unit: string;
  unitFromFile: boolean;
  /** Name or EPSG code of the coordinate system, if the file has one. */
  crs: string;
  /** Longitude and latitude, turned into meters east and north of the cloud's center for the view. */
  geographic: boolean;
}

export interface LasClass {
  code: number;
  /** Range of the class in the sorted point arrays. */
  start: number;
  count: number;
  /** Grid cells of the class: first point, number of points, and a bounding sphere (center, radius). */
  cellStart: Uint32Array;
  cellCount: Uint32Array;
  cellSphere: Float32Array;
}

export interface LasResult {
  header: LasHeader;
  /** Every `step`-th point is kept. */
  step: number;
  kept: number;
  /** Real coordinates = origin + position. */
  origin: [number, number, number];
  positions: Float32Array;
  /** Bounding box of the kept points, relative to the origin. */
  min: [number, number, number];
  max: [number, number, number];
  intensity: Uint16Array | null;
  /** 8-bit sRGB. */
  rgb: Uint8Array | null;
  /** Return number in the low 4 bits, number of returns in the high 4 bits. */
  returns: Uint8Array;
  classes: LasClass[];
}

export type LasResponse = ({ ok: true } & LasResult) | { ok: false; error: string } | { ok: 'progress'; message: string; fraction: number };

interface LazModule {
  HEAPU8: Uint8Array;
  _malloc(size: number): number;
  _free(pointer: number): void;
  LASZip: new () => { open(pointer: number, length: number): void; getPoint(pointer: number): void; getCount(): number; delete(): void };
}

const post = (response: LasResponse, transfer: ArrayBuffer[] = []) => (self as unknown as Worker).postMessage(response, transfer);
const progress = (message: string, fraction: number) => post({ ok: 'progress', message, fraction });

const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes).replace(/\0.*$/s, '').trim();

/** Standard record size per point format; files may append extra bytes per point. */
const RECORD_SIZE = [20, 28, 26, 34, 57, 63, 30, 36, 38, 59, 67];
/** Where red, green and blue start in the record, for the formats that have them. */
const RGB_OFFSET: Record<number, number> = { 2: 20, 3: 28, 5: 28, 7: 30, 8: 30, 10: 30 };

// ---- Coordinate system: just enough to tell meters from feet ----------------------------------------------------

const LINEAR_UNITS: Record<number, string> = { 9001: 'm', 9002: 'ft', 9003: 'US ft', 9036: 'km' };

function unitFromFactor(factor: number, name: string): string {
  if (Math.abs(factor - 1) < 1e-9) return 'm';
  if (Math.abs(factor - 0.3048) < 1e-9) return 'ft';
  if (Math.abs(factor - 0.3048006096012192) < 1e-9) return 'US ft';
  if (Math.abs(factor - 1000) < 1e-6) return 'km';
  return name;
}

/** WKT 1 or 2: the length unit of the projected system (not of its base geographic system), or degrees. */
function wktUnit(wkt: string): { unit: string; crs: string } | null {
  const projected = /\b(PROJCS|PROJCRS|PROJECTEDCRS)\s*\[\s*"([^"]*)"/i.exec(wkt);
  if (!projected) {
    const geographic = /\b(GEOGCS|GEOGCRS|GEOGRAPHICCRS|GEODCRS)\s*\[\s*"([^"]*)"/i.exec(wkt);
    return geographic ? { unit: '°', crs: geographic[2] } : null;
  }
  // Walk the projected system, skipping nested base systems, to its own UNIT or LENGTHUNIT.
  let depth = 0;
  let skipFrom = -1;
  for (let i = projected.index; i < wkt.length; i++) {
    const c = wkt[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') {
      depth--;
      if (skipFrom >= 0 && depth < skipFrom) skipFrom = -1;
      if (depth === 0) break;
    } else if (depth >= 1 && skipFrom < 0) {
      const rest = wkt.slice(i, i + 24);
      if (/^(GEOGCS|BASEGEOGCRS|BASEGEODCRS|GEOGCRS)\s*\[/i.test(rest)) skipFrom = depth + 1;
      const unit = /^(?:LENGTHUNIT|UNIT)\s*\[\s*"([^"]*)"\s*,\s*([\d.eE+-]+)/i.exec(wkt.slice(i, i + 200));
      if (unit && /^(UNIT|LENGTHUNIT)/i.test(rest) && (i === 0 || !/[A-Z_]/i.test(wkt[i - 1]))) {
        return { unit: unitFromFactor(Number(unit[2]), unit[1]), crs: projected[2] };
      }
    }
  }
  return { unit: 'm', crs: projected[2] };
}

/** GeoTIFF keys (LASF_Projection 34735): model type, projected system code and linear unit. */
function geoKeyUnit(data: DataView): { unit: string; crs: string } | null {
  if (data.byteLength < 8) return null;
  const keys = data.getUint16(6, true);
  let unit = '';
  let crs = '';
  let geographic = false;
  for (let k = 0; k < keys && 8 + k * 8 + 8 <= data.byteLength; k++) {
    const at = 8 + k * 8;
    const id = data.getUint16(at, true);
    const location = data.getUint16(at + 2, true);
    const value = data.getUint16(at + 6, true);
    if (location !== 0) continue;
    if (id === 1024) geographic = value === 2;
    if (id === 3072 && value !== 32767) crs = `EPSG:${value}`;
    if (id === 2048 && !crs && value !== 32767) crs = `EPSG:${value}`;
    if (id === 3076) unit = LINEAR_UNITS[value] ?? '';
  }
  if (geographic) return { unit: '°', crs };
  return unit || crs ? { unit: unit || 'm', crs } : null;
}

// ---- Reading -----------------------------------------------------------------------------------------------------

async function bytes(file: File, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, end).arrayBuffer());
}

async function read({ file, budget }: LasRequest): Promise<{ result: LasResult; transfer: ArrayBuffer[] }> {
  const head = await bytes(file, 0, 375);
  if (head.length < 227 || latin1(head.subarray(0, 4)) !== 'LASF') throw new Error('This is not a LAS file (the "LASF" signature is missing).');
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const major = head[24];
  const minor = head[25];
  const headerSize = view.getUint16(94, true);
  const dataOffset = view.getUint32(96, true);
  const vlrCount = view.getUint32(100, true);
  const formatByte = head[104];
  const pointFormat = formatByte & 0x3f;
  const compressed = (formatByte & 0x80) !== 0;
  const recordLength = view.getUint16(105, true);
  let count = view.getUint32(107, true);
  if (minor >= 4 && headerSize >= 375) count = Number(view.getBigUint64(247, true)) || count;
  if (pointFormat > 10) throw new Error(`Point format ${pointFormat} is not defined in LAS 1.0–1.4.`);
  if (recordLength < RECORD_SIZE[pointFormat]) throw new Error(`The point records are shorter (${recordLength} bytes) than point format ${pointFormat} requires.`);
  const scale = [view.getFloat64(131, true), view.getFloat64(139, true), view.getFloat64(147, true)];
  const offset = [view.getFloat64(155, true), view.getFloat64(163, true), view.getFloat64(171, true)];
  const headerMax = [view.getFloat64(179, true), view.getFloat64(195, true), view.getFloat64(211, true)];
  const headerMin = [view.getFloat64(187, true), view.getFloat64(203, true), view.getFloat64(219, true)];

  // Variable length records: the coordinate system (WKT preferred over GeoTIFF keys), and in LAZ files the laszip record.
  let unit: { unit: string; crs: string } | null = null;
  let wkt: { unit: string; crs: string } | null = null;
  const vlrs = await bytes(file, headerSize, Math.min(dataOffset, headerSize + 4 * 1024 * 1024));
  const vlrView = new DataView(vlrs.buffer, vlrs.byteOffset, vlrs.byteLength);
  for (let i = 0, at = 0; i < vlrCount && at + 54 <= vlrs.length; i++) {
    const user = latin1(vlrs.subarray(at + 2, at + 18));
    const id = vlrView.getUint16(at + 18, true);
    const length = vlrView.getUint16(at + 20, true);
    const body = new DataView(vlrs.buffer, vlrs.byteOffset + at + 54, Math.max(0, Math.min(length, vlrs.length - at - 54)));
    if (user === 'LASF_Projection' && id === 2112) wkt = wktUnit(new TextDecoder().decode(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)));
    if (user === 'LASF_Projection' && id === 34735) unit = geoKeyUnit(body);
    at += 54 + length;
  }
  // LAS 1.4 may keep the WKT in an extended record after the points.
  if (!wkt && minor >= 4 && headerSize >= 375) {
    let at = Number(view.getBigUint64(235, true));
    for (let i = 0; i < view.getUint32(243, true) && at > 0 && at + 60 <= file.size; i++) {
      const evlr = await bytes(file, at, at + 60);
      const ev = new DataView(evlr.buffer);
      const length = Number(ev.getBigUint64(20, true));
      if (latin1(evlr.subarray(2, 18)) === 'LASF_Projection' && ev.getUint16(18, true) === 2112 && length < 1024 * 1024) {
        wkt = wktUnit(new TextDecoder().decode(await bytes(file, at + 60, at + 60 + length)));
      }
      at += 60 + length;
    }
  }
  unit = wkt ?? unit;

  const header: LasHeader = {
    version: `${major}.${minor}`,
    pointFormat,
    compressed,
    count,
    systemId: latin1(head.subarray(26, 58)),
    software: latin1(head.subarray(58, 90)),
    // Most LAS files are in meters; without a coordinate system in the file that is the best guess.
    unit: unit?.unit ?? 'm',
    unitFromFile: Boolean(unit),
    crs: unit?.crs ?? '',
    geographic: false,
  };
  if (count === 0) throw new Error('The file contains no points.');

  const step = Math.max(1, Math.ceil(count / budget));
  const capacity = Math.ceil(count / step);
  const positions = new Float32Array(capacity * 3);
  const intensity = new Uint16Array(capacity);
  const classes = new Uint8Array(capacity);
  const returns = new Uint8Array(capacity);
  const rgbOffset = RGB_OFFSET[pointFormat];
  const rgb16 = rgbOffset !== undefined ? new Uint16Array(capacity * 3) : null;
  const extended = pointFormat >= 6;

  // The cloud's center becomes the origin: from the header when its bounds are sane, else from the first point.
  const sane = headerMin.every((v, k) => Number.isFinite(v) && Number.isFinite(headerMax[k]) && v <= headerMax[k]) && headerMax.some((v, k) => v !== headerMin[k]);
  let origin: [number, number, number] | null = sane ? (headerMin.map((v, k) => (v + headerMax[k]) / 2) as [number, number, number]) : null;
  let kept = 0;
  let maxColor = 0;

  const take = (record: DataView, at: number) => {
    const x = record.getInt32(at, true) * scale[0] + offset[0];
    const y = record.getInt32(at + 4, true) * scale[1] + offset[1];
    const z = record.getInt32(at + 8, true) * scale[2] + offset[2];
    origin ??= [x, y, z];
    positions[kept * 3] = x - origin[0];
    positions[kept * 3 + 1] = y - origin[1];
    positions[kept * 3 + 2] = z - origin[2];
    intensity[kept] = record.getUint16(at + 12, true);
    const flags = record.getUint8(at + 14);
    if (extended) {
      returns[kept] = flags;
      classes[kept] = record.getUint8(at + 16);
    } else {
      returns[kept] = (flags & 7) | (((flags >> 3) & 7) << 4);
      classes[kept] = record.getUint8(at + 15) & 31;
    }
    if (rgb16) {
      for (let c = 0; c < 3; c++) {
        const v = record.getUint16(at + rgbOffset + c * 2, true);
        rgb16[kept * 3 + c] = v;
        if (v > maxColor) maxColor = v;
      }
    }
    kept++;
  };

  const label = compressed ? 'Decompressing points' : 'Reading points';
  if (compressed) {
    const lazPerf = (await (createLazPerf as unknown as (options: { locateFile: () => string }) => Promise<LazModule>)({ locateFile: () => wasmUrl }));
    // laz-perf reads from memory: the whole file goes into the WebAssembly heap (at most 2 GB).
    let pointer = 0;
    try {
      pointer = lazPerf._malloc(file.size);
    } catch {
      pointer = 0;
    }
    if (!pointer) throw new Error('This LAZ file is too large to decompress in the browser (the limit is about 2 GB).');
    const reader = new lazPerf.LASZip();
    const out = lazPerf._malloc(recordLength);
    try {
      const SLICE = 64 * 1024 * 1024;
      for (let at = 0; at < file.size; at += SLICE) {
        lazPerf.HEAPU8.set(await bytes(file, at, Math.min(file.size, at + SLICE)), pointer + at);
        progress('Loading the file …', 0);
      }
      try {
        reader.open(pointer, file.size);
      } catch (error) {
        throw new Error(`The LAZ file could not be opened (${error instanceof Error ? error.message : String(error)}).`);
      }
      const total = Math.min(count, reader.getCount() || count);
      let record = new DataView(lazPerf.HEAPU8.buffer, out, recordLength);
      for (let i = 0; i < total; i++) {
        reader.getPoint(out);
        if (i % step) continue;
        // The heap may grow, which replaces its buffer.
        if (record.buffer !== lazPerf.HEAPU8.buffer) record = new DataView(lazPerf.HEAPU8.buffer, out, recordLength);
        take(record, 0);
        if (kept % 262144 === 0) progress(`${label} …`, i / total);
      }
    } catch (error) {
      // Point formats with waveform data (4, 5, 9, 10) are only partly supported by laz-perf.
      if (kept === 0) throw new Error(`The LAZ data could not be decompressed${pointFormat === 4 || pointFormat === 5 || pointFormat >= 9 ? ' (point formats with waveforms are not supported)' : ''}.`);
      console.warn('LAZ decompression stopped early:', error);
    } finally {
      reader.delete();
      lazPerf._free(out);
      lazPerf._free(pointer);
    }
  } else {
    // Uncompressed: read in slices of whole records.
    const perSlice = Math.max(1, Math.floor((32 * 1024 * 1024) / recordLength));
    for (let first = 0; first < count; first += perSlice) {
      const n = Math.min(perSlice, count - first);
      const start = dataOffset + first * recordLength;
      const chunk = await bytes(file, start, start + n * recordLength);
      const record = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      const available = Math.floor(chunk.length / recordLength);
      // Every step-th point of the whole file, counted from its first point.
      for (let i = (step - (first % step)) % step; i < available; i += step) take(record, i * recordLength);
      progress(`${label} …`, (first + n) / count);
      if (available < n) break;
    }
  }
  if (kept === 0) throw new Error('No points could be read.');

  // 16-bit colors as the format asks for, or 8-bit values written into 16-bit fields (common): detect by the maximum.
  let rgb: Uint8Array | null = null;
  if (rgb16 && maxColor > 0) {
    rgb = new Uint8Array(kept * 3);
    const shift = maxColor > 255 ? 8 : 0;
    for (let i = 0; i < kept * 3; i++) rgb[i] = rgb16[i] >> shift;
  }
  const hasIntensity = intensity.subarray(0, kept).some((v) => v !== 0);
  if (header.unit === '°') toMeters(header, origin!, positions.subarray(0, kept * 3));
  progress('Sorting points …', 1);
  return sortPoints({
    header,
    step,
    kept,
    origin: origin!,
    positions: positions.subarray(0, kept * 3),
    intensity: hasIntensity ? intensity.subarray(0, kept) : null,
    rgb,
    returns: returns.subarray(0, kept),
    classes: classes.subarray(0, kept),
  });
}

/**
 * Degrees would squash the cloud (a degree is about 100 km, heights are in meters): longitude and latitude become
 * meters east and north of the center (ellipsoid lengths of a degree at the center's latitude). Files that only claim
 * a geographic system but hold other numbers keep them, without a unit.
 */
function toMeters(header: LasHeader, origin: [number, number, number], positions: Float32Array): void {
  let span = 0;
  for (let i = 0; i < positions.length; i += 3) span = Math.max(span, Math.abs(positions[i]), Math.abs(positions[i + 1]));
  if (Math.abs(origin[1]) > 90 || Math.abs(origin[0]) > 360 || span > 5) {
    header.unit = '';
    return;
  }
  const phi = (origin[1] * Math.PI) / 180;
  const east = 111412.84 * Math.cos(phi) - 93.5 * Math.cos(3 * phi) + 0.118 * Math.cos(5 * phi);
  const north = 111132.92 - 559.82 * Math.cos(2 * phi) + 1.175 * Math.cos(4 * phi) - 0.0023 * Math.cos(6 * phi);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] *= east;
    positions[i + 1] *= north;
  }
  origin[0] = 0;
  origin[1] = 0;
  header.unit = 'm';
  header.geographic = true;
}

// ---- Sorting by class and grid cell -----------------------------------------------------------------------------

/** Points per cell aimed at: picking tests the points of the few cells near the pointer ray. */
const CELL_POINTS = 4096;

function sortPoints(input: Omit<LasResult, 'classes' | 'min' | 'max'> & { classes: Uint8Array }): { result: LasResult; transfer: ArrayBuffer[] } {
  const { kept: n, positions } = input;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i++) {
    const v = positions[i];
    const k = i % 3;
    if (v < min[k]) min[k] = v;
    if (v > max[k]) max[k] = v;
  }
  const extent = max.map((v, k) => v - min[k]);
  const largest = Math.max(...extent, 1e-6);
  const dims = extent.map((e) => Math.max(e, largest * 1e-3));
  // Classes present, each a slot; cells sized so that a cell holds about CELL_POINTS points.
  const classCounts = new Uint32Array(256);
  for (let i = 0; i < n; i++) classCounts[input.classes[i]]++;
  const codes = [...classCounts.keys()].filter((c) => classCounts[c] > 0);
  const slotOf = new Uint8Array(256);
  codes.forEach((c, i) => (slotOf[c] = i));
  let size = Math.cbrt((dims[0] * dims[1] * dims[2] * CELL_POINTS) / Math.max(n, 1));
  let grid = dims.map((d) => Math.max(1, Math.ceil(d / size)));
  while (grid[0] * grid[1] * grid[2] * codes.length > 4_000_000) {
    size *= 1.5;
    grid = dims.map((d) => Math.max(1, Math.ceil(d / size)));
  }
  const cells = grid[0] * grid[1] * grid[2];
  const buckets = cells * codes.length;
  const key = new Uint32Array(n);
  const counts = new Uint32Array(buckets + 1);
  for (let i = 0; i < n; i++) {
    const ix = Math.min(grid[0] - 1, Math.floor((positions[i * 3] - min[0]) / size));
    const iy = Math.min(grid[1] - 1, Math.floor((positions[i * 3 + 1] - min[1]) / size));
    const iz = Math.min(grid[2] - 1, Math.floor((positions[i * 3 + 2] - min[2]) / size));
    const k = slotOf[input.classes[i]] * cells + (ix * grid[1] + iy) * grid[2] + iz;
    key[i] = k;
    counts[k + 1]++;
  }
  for (let b = 1; b <= buckets; b++) counts[b] += counts[b - 1];
  const starts = counts.slice(0, buckets);

  const sortedPositions = new Float32Array(n * 3);
  const sortedIntensity = input.intensity ? new Uint16Array(n) : null;
  const sortedRgb = input.rgb ? new Uint8Array(n * 3) : null;
  const sortedReturns = new Uint8Array(n);
  const cursor = counts; // reused as write positions
  for (let i = 0; i < n; i++) {
    const to = cursor[key[i]]++;
    sortedPositions[to * 3] = positions[i * 3];
    sortedPositions[to * 3 + 1] = positions[i * 3 + 1];
    sortedPositions[to * 3 + 2] = positions[i * 3 + 2];
    if (sortedIntensity) sortedIntensity[to] = input.intensity![i];
    if (sortedRgb) {
      sortedRgb[to * 3] = input.rgb![i * 3];
      sortedRgb[to * 3 + 1] = input.rgb![i * 3 + 1];
      sortedRgb[to * 3 + 2] = input.rgb![i * 3 + 2];
    }
    sortedReturns[to] = input.returns[i];
  }

  // Per class: its range and its non-empty cells with bounding spheres.
  const classes: LasClass[] = codes.map((code, slot) => {
    const first = starts[slot * cells];
    const cellStart: number[] = [];
    const cellCount: number[] = [];
    const spheres: number[] = [];
    for (let c = 0; c < cells; c++) {
      const s = starts[slot * cells + c];
      const e = slot * cells + c + 1 < buckets ? starts[slot * cells + c + 1] : n;
      if (e <= s) continue;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = s; i < e; i++) {
        for (let k = 0; k < 3; k++) {
          const v = sortedPositions[i * 3 + k];
          if (v < lo[k]) lo[k] = v;
          if (v > hi[k]) hi[k] = v;
        }
      }
      cellStart.push(s - first);
      cellCount.push(e - s);
      spheres.push((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
    }
    return { code, start: first, count: classCounts[code], cellStart: Uint32Array.from(cellStart), cellCount: Uint32Array.from(cellCount), cellSphere: Float32Array.from(spheres) };
  });

  const result: LasResult = {
    header: input.header,
    step: input.step,
    kept: n,
    origin: input.origin,
    positions: sortedPositions,
    min,
    max,
    intensity: sortedIntensity,
    rgb: sortedRgb,
    returns: sortedReturns,
    classes,
  };
  const transfer = [sortedPositions, sortedIntensity, sortedRgb, sortedReturns, ...classes.flatMap((c) => [c.cellStart, c.cellCount, c.cellSphere])]
    .filter((a): a is NonNullable<typeof a> => a !== null)
    .map((a) => a.buffer as ArrayBuffer);
  return { result, transfer };
}

self.onmessage = async (event: MessageEvent<LasRequest>) => {
  try {
    const { result, transfer } = await read(event.data);
    post({ ok: true, ...result }, transfer);
  } catch (error) {
    post({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
