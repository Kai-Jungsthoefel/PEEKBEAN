// SPDX-License-Identifier: GPL-3.0-or-later
// Map data as the converter passes it from the readers to the writers: GeoJSON geometries in WGS84 longitude and
// latitude, with the elevation as an optional third value, and what the file says about each feature. Plain data and
// plain functions without browser APIs, so all of it can run in a worker.
import type { Geometry, Position } from 'geojson';
import type { FeatureStyle, Projector } from '../../viewers/map/model';

/** Values per vertex of a line, as togeojson gives them: one array for a LineString, one per part for a MultiLineString. */
export type VertexValues = unknown[] | unknown[][];

export interface MapFeature {
  geometry: Geometry | null;
  properties: Record<string, unknown>;
  style?: FeatureStyle;
  /** Values per vertex of lines, togeojson's coordinateProperties: "times" (ISO time stamps), "heart" … */
  vertexValues?: Record<string, VertexValues>;
  /** A GPX route rather than a track. */
  route?: boolean;
}

export interface FeatureLayer {
  name: string;
  features: MapFeature[];
  /** The coordinate system is unknown: the coordinates are the file's own, not longitude and latitude. */
  planar?: boolean;
  /** A KML folder that starts hidden. */
  hidden?: boolean;
}

export interface OutputFile {
  name: string;
  data: Uint8Array;
  type: string;
}

const nonNull = <T>(value: T | null): value is T => value !== null;

/** Coordinates rounded to a billionth of a degree (0.1 mm), so reprojected ones do not carry 17 digits of noise. */
export const rounded = (project: Projector): Projector => (x, y, out) => {
  if (!project(x, y, out)) return false;
  out[0] = Math.round(out[0] * 1e9) / 1e9;
  out[1] = Math.round(out[1] * 1e9) / 1e9;
  return true;
};

/**
 * A geometry ready for writing: only vertices with numbers, lines of at least 2 points, closed rings of at least 4,
 * polygons with their outer ring; empty geometries become null. `project` turns file coordinates into longitude and
 * latitude; the elevation is kept as it is.
 */
export function cleanGeometry(geometry: Geometry | null | undefined, project?: Projector): Geometry | null {
  const at = new Float64Array(2);
  const position = (p: unknown): Position | null => {
    if (!Array.isArray(p) || p.length < 2) return null;
    let x = Number(p[0]);
    let y = Number(p[1]);
    if (project) {
      if (!project(x, y, at)) return null;
      [x, y] = at;
    } else if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return null;
    }
    return typeof p[2] === 'number' && Number.isFinite(p[2]) ? [x, y, p[2]] : [x, y];
  };
  const line = (l: unknown, min: number): Position[] | null => {
    if (!Array.isArray(l)) return null;
    const out = l.map(position).filter(nonNull);
    return out.length >= min ? out : null;
  };
  const ring = (r: unknown): Position[] | null => {
    const out = line(r, 3);
    if (!out) return null;
    const [first, last] = [out[0], out[out.length - 1]];
    if (first[0] !== last[0] || first[1] !== last[1]) out.push([...first]);
    return out.length >= 4 ? out : null;
  };
  const polygon = (rings: unknown): Position[][] | null => {
    if (!Array.isArray(rings)) return null;
    const outer = ring(rings[0]);
    return outer ? [outer, ...rings.slice(1).map(ring).filter(nonNull)] : null;
  };
  const many = <T>(items: unknown, read: (item: unknown) => T | null): T[] => (Array.isArray(items) ? items.map(read).filter(nonNull) : []);

  if (!geometry || typeof geometry !== 'object') return null;
  switch (geometry.type) {
    case 'Point': {
      const coordinates = position(geometry.coordinates);
      return coordinates && { type: 'Point', coordinates };
    }
    case 'MultiPoint': {
      const coordinates = many(geometry.coordinates, position);
      return coordinates.length ? { type: 'MultiPoint', coordinates } : null;
    }
    case 'LineString': {
      const coordinates = line(geometry.coordinates, 2);
      return coordinates && { type: 'LineString', coordinates };
    }
    case 'MultiLineString': {
      const coordinates = many(geometry.coordinates, (l) => line(l, 2));
      return coordinates.length ? { type: 'MultiLineString', coordinates } : null;
    }
    case 'Polygon': {
      const coordinates = polygon(geometry.coordinates);
      return coordinates && { type: 'Polygon', coordinates };
    }
    case 'MultiPolygon': {
      const coordinates = many(geometry.coordinates, polygon);
      return coordinates.length ? { type: 'MultiPolygon', coordinates } : null;
    }
    case 'GeometryCollection': {
      const geometries = many(geometry.geometries, (g) => cleanGeometry(g as Geometry, project));
      return geometries.length ? simplify(geometries) : null;
    }
    default:
      return null;
  }
}

/**
 * A collection of one kind of geometry as the matching Multi geometry: KML's MultiGeometry of lines, as togeojson
 * reads it, is a MultiLineString to GIS software. Mixed collections stay collections.
 */
function simplify(geometries: Geometry[]): Geometry {
  if (geometries.length === 1) return geometries[0];
  const { points, lines, polygons } = partsOf({ type: 'GeometryCollection', geometries });
  const nested = geometries.some((g) => g.type === 'GeometryCollection');
  if (nested || [points.length, lines.length, polygons.length].filter(Boolean).length !== 1) return { type: 'GeometryCollection', geometries };
  if (points.length) return { type: 'MultiPoint', coordinates: points };
  if (lines.length) return { type: 'MultiLineString', coordinates: lines };
  return { type: 'MultiPolygon', coordinates: polygons };
}

/** The geometry without elevations, when all of them are 0: KML files write ",0" for points on the ground. */
export function withoutZeroElevation(geometry: Geometry | null): Geometry | null {
  if (!geometry) return geometry;
  for (const p of positionsOf(geometry)) if (p.length > 2 && p[2] !== 0) return geometry;
  const flat = (p: Position): Position => [p[0], p[1]];
  switch (geometry.type) {
    case 'Point':
      return { type: 'Point', coordinates: flat(geometry.coordinates) };
    case 'MultiPoint':
      return { type: 'MultiPoint', coordinates: geometry.coordinates.map(flat) };
    case 'LineString':
      return { type: 'LineString', coordinates: geometry.coordinates.map(flat) };
    case 'MultiLineString':
      return { type: 'MultiLineString', coordinates: geometry.coordinates.map((l) => l.map(flat)) };
    case 'Polygon':
      return { type: 'Polygon', coordinates: geometry.coordinates.map((r) => r.map(flat)) };
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((p) => p.map((r) => r.map(flat))) };
    case 'GeometryCollection':
      return { type: 'GeometryCollection', geometries: geometry.geometries.map((g) => withoutZeroElevation(g)!) };
  }
}

/** The parts of a geometry by kind, with collections taken apart. */
export interface Parts {
  points: Position[];
  lines: Position[][];
  /** Each polygon: its outer ring, then its holes. */
  polygons: Position[][][];
}

export function partsOf(geometry: Geometry | null, out: Parts = { points: [], lines: [], polygons: [] }): Parts {
  if (!geometry) return out;
  switch (geometry.type) {
    case 'Point':
      out.points.push(geometry.coordinates);
      break;
    case 'MultiPoint':
      for (const p of geometry.coordinates) out.points.push(p);
      break;
    case 'LineString':
      out.lines.push(geometry.coordinates);
      break;
    case 'MultiLineString':
      for (const l of geometry.coordinates) out.lines.push(l);
      break;
    case 'Polygon':
      out.polygons.push(geometry.coordinates);
      break;
    case 'MultiPolygon':
      for (const p of geometry.coordinates) out.polygons.push(p);
      break;
    case 'GeometryCollection':
      for (const g of geometry.geometries) partsOf(g, out);
      break;
  }
  return out;
}

/** Every vertex of a geometry. */
export function* positionsOf(geometry: Geometry | null): Generator<Position> {
  if (!geometry) return;
  const { points, lines, polygons } = partsOf(geometry);
  yield* points;
  for (const line of lines) yield* line;
  for (const polygon of polygons) for (const ring of polygon) yield* ring;
}

/** Whether every vertex has an elevation (false for no vertices). */
export function everyHasZ(geometry: Geometry | null): boolean {
  let any = false;
  for (const p of positionsOf(geometry)) {
    if (p.length < 3) return false;
    any = true;
  }
  return any;
}

/** Twice the signed area of a ring, x to the right and y up: positive when it runs counterclockwise. */
export function signedArea(ring: Position[]): number {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
  return sum;
}

/** The rings of a polygon turned so the outer ring runs counterclockwise, or clockwise, and the holes the other way. */
export function orient(rings: Position[][], outerClockwise: boolean): Position[][] {
  return rings.map((ring, index) => {
    const clockwise = signedArea(ring) < 0;
    return clockwise === (index === 0 ? outerClockwise : !outerClockwise) ? ring : [...ring].reverse();
  });
}

/** The geometry with its polygons following the right-hand rule of RFC 7946: outer rings counterclockwise, holes clockwise. */
export function rightHand(geometry: Geometry): Geometry {
  switch (geometry.type) {
    case 'Polygon':
      return { type: 'Polygon', coordinates: orient(geometry.coordinates, false) };
    case 'MultiPolygon':
      return { type: 'MultiPolygon', coordinates: geometry.coordinates.map((p) => orient(p, false)) };
    case 'GeometryCollection':
      return { type: 'GeometryCollection', geometries: geometry.geometries.map(rightHand) };
    default:
      return geometry;
  }
}

/** A number without exponent notation, as xsd:decimal and WKT readers expect (1e-7 becomes 0.0000001). */
export function decimal(n: number): string {
  const text = String(n);
  if (!/e/i.test(text)) return text;
  return Math.abs(n) < 1 ? n.toFixed(20).replace(/\.?0+$/, '') : BigInt(Math.round(n)).toString();
}

/** A property value as text: numbers as JavaScript writes them, objects and arrays as JSON, nothing for null. */
export function textOf(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  return JSON.stringify(value) ?? '';
}

/** All attribute names of the features, in order of first appearance. */
export function attributeNames(layers: FeatureLayer[]): string[] {
  const names = new Set<string>();
  for (const layer of layers) for (const feature of layer.features) for (const key of Object.keys(feature.properties)) names.add(key);
  return [...names];
}

/** Name of the attribute that says which layer a feature comes from, when there are several: "layer", unless taken. */
export function layerAttribute(layers: FeatureLayer[]): string | null {
  if (layers.length < 2) return null;
  const used = new Set(attributeNames(layers).map((name) => name.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = n === 1 ? 'layer' : `layer_${n}`;
    if (!used.has(name)) return name;
  }
}

/** A name not in `used` (compared without case): the name itself, else with _2, _3 … */
export function uniqueName(name: string, used: Set<string>): string {
  let result = name;
  for (let n = 2; used.has(result.toLowerCase()); n++) result = `${name}_${n}`;
  used.add(result.toLowerCase());
  return result;
}

/** Reports the share of features done every few thousand features. */
export function ticker(total: number, report?: (fraction: number) => void): () => void {
  let done = 0;
  return () => {
    if (++done % 5000 === 0) report?.(done / total);
  };
}
