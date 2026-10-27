// SPDX-License-Identifier: GPL-3.0-or-later
// Map data as flat typed arrays: compact, quick to draw and hit-test, and transferable from the reader worker.
// Geographic data is stored in Web Mercator meters; data without a known coordinate system in its own coordinates.
import type { Geometry, Position } from 'geojson';
import type { TrackStats } from './geodesy';

export const POINT = 0;
export const LINE = 1;
export const POLYGON = 2;

/** Colors and sizes a file gives its features (KML styles, GeoJSON simplestyle, GPX line extensions). */
export interface FeatureStyle {
  stroke?: string;
  strokeWidth?: number;
  strokeOpacity?: number;
  fill?: string;
  fillOpacity?: number;
  /** Marker color: KML icon color or simplestyle marker-color. */
  marker?: string;
  /** Icon image as referenced by the file; only images inside the file itself are ever shown. */
  icon?: string;
  iconScale?: number;
  /** KML hot spot: [x, y] measured from the lower left corner, with units "fraction" or "pixels". */
  iconAnchor?: [number, number, string, string];
}

export interface MapLayer {
  name: string;
  /** Vertex coordinates, x/y pairs. */
  xy: Float64Array;
  /** First vertex of each part (point run, line or ring), plus the end. */
  parts: Uint32Array;
  /** Per geometry group: kind, first part, end part. */
  groups: Uint32Array;
  /** First group of each feature, plus the end. */
  featureGroups: Uint32Array;
  /** Per feature: min x, min y, max x, max y (NaN without geometry). */
  bbox: Float64Array;
  properties: Record<string, unknown>[];
  /** Distinct styles of the layer; index 0 means "none", the layer's default colors. */
  styles: FeatureStyle[];
  styleOf: Uint32Array;
  /** Bit per geometry kind present (1 << POINT …). */
  kinds: number;
  /** The coordinates are the file's own because its coordinate system is unknown. */
  planar: boolean;
  /** Coordinate system as the file names it, e.g. "ETRS89 / UTM zone 32N". */
  crs?: string;
  /** Starts hidden (KML folders with visibility 0). */
  hidden?: boolean;
  /** GPS tracks and routes: length, duration and elevation by feature index. */
  stats?: Record<number, TrackStats>;
}

export const EARTH_RADIUS = 6378137;
const MAX_LATITUDE = 85.0511287798;
const DEG = Math.PI / 180;

/** WGS84 longitude/latitude in degrees to Web Mercator meters. */
export function mercator(lon: number, lat: number, out: Float64Array | number[]): void {
  const phi = Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, lat)) * DEG;
  out[0] = EARTH_RADIUS * lon * DEG;
  out[1] = EARTH_RADIUS * Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

export function lonLat(x: number, y: number): [number, number] {
  return [x / EARTH_RADIUS / DEG, (2 * Math.atan(Math.exp(y / EARTH_RADIUS)) - Math.PI / 2) / DEG];
}

/** Turns file coordinates into stored coordinates; false drops the vertex. */
export type Projector = (x: number, y: number, out: Float64Array) => boolean;

export const geographic: Projector = (x, y, out) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  mercator(x, y, out);
  return true;
};

export const identity: Projector = (x, y, out) => {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  out[0] = x;
  out[1] = y;
  return true;
};

const COLOR = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const color = (v: unknown) => (typeof v === 'string' && COLOR.test(v.trim()) ? `#${v.trim().replace(/^#/, '')}` : undefined);
const number = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
};

/** Style from simplestyle properties, which is also how togeojson passes on KML and GPX styles. */
export function styleOf(p: Record<string, unknown>): FeatureStyle | null {
  const style: FeatureStyle = {
    stroke: color(p.stroke),
    strokeWidth: number(p['stroke-width']),
    strokeOpacity: number(p['stroke-opacity']),
    fill: color(p.fill),
    fillOpacity: number(p['fill-opacity']),
    marker: color(p['icon-color']) ?? color(p['marker-color']),
    icon: typeof p.icon === 'string' && p.icon.trim() ? p.icon.trim() : undefined,
    iconScale: number(p['icon-scale']),
  };
  const offset = p['icon-offset'];
  const units = p['icon-offset-units'];
  if (Array.isArray(offset) && offset.length === 2 && Array.isArray(units)) {
    style.iconAnchor = [Number(offset[0]), Number(offset[1]), String(units[0] ?? 'fraction'), String(units[1] ?? 'fraction')];
  }
  for (const key of Object.keys(style) as (keyof FeatureStyle)[]) if (style[key] === undefined) delete style[key];
  return Object.keys(style).length ? style : null;
}

/** Collects features into the flat arrays of a MapLayer. */
export class LayerBuilder {
  private xy: number[] = [];
  private parts: number[] = [0];
  private groups: number[] = [];
  private featureGroups: number[] = [0];
  private bbox: number[] = [];
  private readonly properties: Record<string, unknown>[] = [];
  private readonly styleKeys = new Map<string, number>([['', 0]]);
  private readonly styles: FeatureStyle[] = [{}];
  private readonly styleIndex: number[] = [];
  private kinds = 0;
  private readonly at = new Float64Array(2);
  private minX = Infinity;
  private minY = Infinity;
  private maxX = -Infinity;
  private maxY = -Infinity;

  constructor(private readonly project: Projector) {}

  get count(): number {
    return this.properties.length;
  }

  add(geometry: Geometry | null | undefined, properties: Record<string, unknown>, style: FeatureStyle | null = null): void {
    this.minX = this.minY = Infinity;
    this.maxX = this.maxY = -Infinity;
    if (geometry) this.geometry(geometry);
    this.featureGroups.push(this.groups.length / 3);
    if (this.minX <= this.maxX) this.bbox.push(this.minX, this.minY, this.maxX, this.maxY);
    else this.bbox.push(NaN, NaN, NaN, NaN);
    this.properties.push(properties);
    const key = style ? JSON.stringify(style) : '';
    let index = this.styleKeys.get(key);
    if (index === undefined) {
      index = this.styles.length;
      this.styles.push(style!);
      this.styleKeys.set(key, index);
    }
    this.styleIndex.push(index);
  }

  private geometry(g: Geometry): void {
    switch (g.type) {
      case 'Point':
        this.group(POINT, [[g.coordinates]]);
        break;
      case 'MultiPoint':
        this.group(POINT, [g.coordinates]);
        break;
      case 'LineString':
        this.group(LINE, [g.coordinates]);
        break;
      case 'MultiLineString':
        this.group(LINE, g.coordinates);
        break;
      case 'Polygon':
        this.group(POLYGON, g.coordinates);
        break;
      case 'MultiPolygon':
        this.group(POLYGON, g.coordinates.flat(), g.coordinates.map((p) => p.length));
        break;
      case 'GeometryCollection':
        for (const child of g.geometries ?? []) if (child) this.geometry(child);
        break;
    }
  }

  /**
   * One group of parts. Polygon rings are turned so that outer rings run one way and holes the other; the map then
   * fills all polygons of a style in one go with the nonzero rule, and holes stay open.
   * `ringsPerPolygon` says where each polygon of a MultiPolygon starts (its first ring is the outer one).
   */
  private group(kind: number, lines: Position[][], ringsPerPolygon?: number[]): void {
    if (!Array.isArray(lines)) return;
    const first = this.parts.length - 1;
    const outer = new Set<number>();
    if (ringsPerPolygon) {
      let index = 0;
      for (const count of ringsPerPolygon) {
        outer.add(index);
        index += count;
      }
    } else {
      outer.add(0);
    }
    lines.forEach((line, ringIndex) => {
      if (!Array.isArray(line)) return;
      const start = this.xy.length / 2;
      for (const position of line) {
        if (!Array.isArray(position) || !this.project(Number(position[0]), Number(position[1]), this.at)) continue;
        const [x, y] = this.at;
        this.xy.push(x, y);
        if (x < this.minX) this.minX = x;
        if (x > this.maxX) this.maxX = x;
        if (y < this.minY) this.minY = y;
        if (y > this.maxY) this.maxY = y;
      }
      const count = this.xy.length / 2 - start;
      const enough = kind === POINT ? count >= 1 : kind === LINE ? count >= 2 : count >= 3;
      if (!enough) {
        this.xy.length = start * 2;
        return;
      }
      if (kind === POLYGON) {
        let area = 0;
        for (let i = start, j = start + count - 1; i < start + count; j = i++) {
          area += (this.xy[2 * j] - this.xy[2 * i]) * (this.xy[2 * j + 1] + this.xy[2 * i + 1]);
        }
        // area > 0: counterclockwise. Outer rings run counterclockwise, holes clockwise.
        if (area !== 0 && area > 0 !== outer.has(ringIndex)) reverse(this.xy, start, start + count);
      }
      this.parts.push(this.xy.length / 2);
    });
    const end = this.parts.length - 1;
    if (end > first) {
      this.groups.push(kind, first, end);
      this.kinds |= 1 << kind;
    }
  }

  build(name: string, planar: boolean, crs?: string): MapLayer {
    return {
      name,
      xy: Float64Array.from(this.xy),
      parts: Uint32Array.from(this.parts),
      groups: Uint32Array.from(this.groups),
      featureGroups: Uint32Array.from(this.featureGroups),
      bbox: Float64Array.from(this.bbox),
      properties: this.properties,
      styles: this.styles,
      styleOf: Uint32Array.from(this.styleIndex),
      kinds: this.kinds,
      planar,
      crs,
    };
  }
}

function reverse(xy: number[], start: number, end: number): void {
  for (let i = start, j = end - 1; i < j; i++, j--) {
    const x = xy[2 * i];
    const y = xy[2 * i + 1];
    xy[2 * i] = xy[2 * j];
    xy[2 * i + 1] = xy[2 * j + 1];
    xy[2 * j] = x;
    xy[2 * j + 1] = y;
  }
}

/** Typed arrays of a layer, for transferring it from the worker without copying. */
export function buffersOf(layer: MapLayer): ArrayBuffer[] {
  return [layer.xy, layer.parts, layer.groups, layer.featureGroups, layer.bbox, layer.styleOf].map((a) => a.buffer as ArrayBuffer);
}

/** Do these coordinates look like longitude/latitude in degrees? */
export function looksGeographic(minX: number, minY: number, maxX: number, maxY: number): boolean {
  return minX >= -180.5 && maxX <= 360.5 && minY >= -90.5 && maxY <= 90.5;
}

/** Name of a feature for labels and titles, from the usual attribute names. */
export function featureName(properties: Record<string, unknown>): string | undefined {
  for (const key of Object.keys(properties)) {
    if (!/^(name|title|label|gen|bez|bezeichnung|name_en)$/i.test(key)) continue;
    const value = properties[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}
