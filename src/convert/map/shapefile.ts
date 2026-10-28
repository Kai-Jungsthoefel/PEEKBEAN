// SPDX-License-Identifier: GPL-3.0-or-later
// Shapefiles as ESRI describes them: a shapefile holds one kind of geometry, so each kind present gets its own set of
// .shp (shapes), .shx (index), .dbf (attributes), .cpg (UTF-8) and .prj (WGS84) files: points, multipoints, lines and
// polygons. Elevations make the Z types; outer rings run clockwise and holes counterclockwise, as the format wants.
import type { Position } from 'geojson';
import { writeDbf } from './dbf';
import { layerAttribute, orient, partsOf, type FeatureLayer } from './model';

/** The .prj ESRI software writes for WGS84 longitude and latitude. */
const WGS84 = 'GEOGCS["GCS_WGS_1984",DATUM["D_WGS_1984",SPHEROID["WGS_1984",6378137.0,298.257223563]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]]';

type Kind = 'points' | 'multipoints' | 'lines' | 'polygons';
const KINDS: Kind[] = ['points', 'multipoints', 'lines', 'polygons'];
const SHAPE_TYPES: Record<Kind, number> = { points: 1, multipoints: 8, lines: 3, polygons: 5 };

interface Shape {
  /** A point: one part of one point; multipoints: one part; lines and polygons: their lines and rings; null: no geometry. */
  parts: Position[][] | null;
  layer: FeatureLayer;
  properties: Record<string, unknown>;
}

/** Bytes of a record's content, without its 8-byte header. M values are optional and left out. */
function contentLength(kind: Kind, parts: Position[][] | null, z: boolean): number {
  if (!parts) return 4;
  const n = parts.reduce((sum, part) => sum + part.length, 0);
  if (kind === 'points') return z ? 28 : 20;
  const zs = z ? 16 + 8 * n : 0;
  if (kind === 'multipoints') return 40 + 16 * n + zs;
  return 44 + 4 * parts.length + 16 * n + zs;
}

/** The .shp and .shx files of one kind. */
function writeShapes(kind: Kind, shapes: Shape[], z: boolean): { shp: Uint8Array; shx: Uint8Array } {
  const type = SHAPE_TYPES[kind] + (z ? 10 : 0);
  const lengths = shapes.map((shape) => contentLength(kind, shape.parts, z));
  const shp = new Uint8Array(100 + lengths.reduce((sum, length) => sum + 8 + length, 0));
  const shx = new Uint8Array(100 + 8 * shapes.length);
  const sv = new DataView(shp.buffer);
  const xv = new DataView(shx.buffer);
  const total = [Infinity, Infinity, -Infinity, -Infinity, Infinity, -Infinity];

  let offset = 100;
  shapes.forEach((shape, index) => {
    const length = lengths[index];
    // Record headers and the index are big-endian and count 16-bit words; the content is little-endian.
    sv.setInt32(offset, index + 1);
    sv.setInt32(offset + 4, length / 2);
    xv.setInt32(100 + 8 * index, offset / 2);
    xv.setInt32(104 + 8 * index, length / 2);
    let at = offset + 8;
    const double = (v: number) => {
      sv.setFloat64(at, v, true);
      at += 8;
    };
    const int = (v: number) => {
      sv.setInt32(at, v, true);
      at += 4;
    };
    offset += 8 + length;
    if (!shape.parts) {
      int(0);
      return;
    }
    int(type);
    const box = [Infinity, Infinity, -Infinity, -Infinity, Infinity, -Infinity];
    let n = 0;
    for (const part of shape.parts) {
      for (const p of part) {
        const pz = p[2] ?? 0;
        box[0] = Math.min(box[0], p[0]);
        box[1] = Math.min(box[1], p[1]);
        box[2] = Math.max(box[2], p[0]);
        box[3] = Math.max(box[3], p[1]);
        box[4] = Math.min(box[4], pz);
        box[5] = Math.max(box[5], pz);
        n++;
      }
    }
    // Minimum x, y, z at 0, 1, 4; maximum at 2, 3, 5.
    for (const i of [0, 1, 4]) total[i] = Math.min(total[i], box[i]);
    for (const i of [2, 3, 5]) total[i] = Math.max(total[i], box[i]);
    if (kind === 'points') {
      const p = shape.parts[0][0];
      double(p[0]);
      double(p[1]);
      if (z) double(p[2] ?? 0);
      return;
    }
    box.slice(0, 4).forEach(double);
    if (kind !== 'multipoints') int(shape.parts.length);
    int(n);
    if (kind !== 'multipoints') {
      let first = 0;
      for (const part of shape.parts) {
        int(first);
        first += part.length;
      }
    }
    for (const part of shape.parts) {
      for (const p of part) {
        double(p[0]);
        double(p[1]);
      }
    }
    if (z) {
      double(box[4]);
      double(box[5]);
      for (const part of shape.parts) for (const p of part) double(p[2] ?? 0);
    }
  });

  // The file header: bounds of all shapes (zeros without any), Z range for the Z types, no M values.
  const bounds = total[0] <= total[2] ? total : [0, 0, 0, 0, 0, 0];
  for (const [view, size] of [[sv, shp.length], [xv, shx.length]] as const) {
    view.setInt32(0, 9994);
    view.setInt32(24, size / 2);
    view.setInt32(28, 1000, true);
    view.setInt32(32, type, true);
    [bounds[0], bounds[1], bounds[2], bounds[3]].forEach((v, i) => view.setFloat64(36 + 8 * i, v, true));
    view.setFloat64(68, z ? bounds[4] : 0, true);
    view.setFloat64(76, z ? bounds[5] : 0, true);
  }
  return { shp, shx };
}

/** Attribute names of the shapes, in order of first appearance. */
function namesOf(shapes: Shape[]): string[] {
  const names = new Set<string>();
  for (const shape of shapes) for (const key of Object.keys(shape.properties)) names.add(key);
  return [...names];
}

export function writeShapefiles(
  layers: FeatureLayer[],
  base: string,
  progress?: (fraction: number) => void,
): { files: { name: string; data: Uint8Array }[]; notes: string[] } {
  const sets: Record<Kind, Shape[]> = { points: [], multipoints: [], lines: [], polygons: [] };
  const empty: Shape[] = [];
  let mixed = 0;
  for (const layer of layers) {
    for (const feature of layer.features) {
      const { points, lines, polygons } = partsOf(feature.geometry);
      const add = (kind: Kind, parts: Position[][]) => sets[kind].push({ parts, layer, properties: feature.properties });
      if (points.length === 1) add('points', [points]);
      else if (points.length > 1) add('multipoints', [points]);
      if (lines.length) add('lines', lines);
      if (polygons.length) add('polygons', polygons.flatMap((rings) => orient(rings, true)));
      const kinds = Number(points.length > 0) + Number(lines.length > 0) + Number(polygons.length > 0);
      if (kinds > 1) mixed++;
      if (!kinds) empty.push({ parts: null, layer, properties: feature.properties });
    }
  }
  const present = KINDS.filter((kind) => sets[kind].length);
  if (!present.length) throw new Error('The file has no shapes to write as a shapefile, only features without geometry.');
  // Features without geometry become null shapes, which any shapefile may hold, in the first one.
  for (const shape of empty) sets[present[0]].push(shape);

  const key = layerAttribute(layers);
  const files: { name: string; data: Uint8Array }[] = [];
  const renamed = new Map<string, string>();
  const dropped = new Set<string>();
  let cut = 0;
  present.forEach((kind, index) => {
    const shapes = sets[kind];
    const z = shapes.some((shape) => shape.parts?.some((part) => part.some((p) => p.length > 2)));
    const { shp, shx } = writeShapes(kind, shapes, z);
    const columns = [...(key ? [key] : []), ...namesOf(shapes)];
    const rows = key ? shapes.map((shape) => ({ [key]: shape.layer.name, ...shape.properties })) : shapes.map((shape) => shape.properties);
    const table = writeDbf(columns, rows);
    for (const [attribute, field] of table.renamed) renamed.set(attribute, field);
    for (const attribute of table.dropped) dropped.add(attribute);
    cut += table.cut;
    const name = `${base}_${kind}`;
    files.push({ name: `${name}.shp`, data: shp }, { name: `${name}.shx`, data: shx }, { name: `${name}.dbf`, data: table.data }, { name: `${name}.cpg`, data: new TextEncoder().encode('UTF-8') });
    // Coordinates of an unknown system are written as they are, so there is no .prj to say which one it is.
    if (!shapes.some((shape) => shape.layer.planar)) files.push({ name: `${name}.prj`, data: new TextEncoder().encode(WGS84) });
    progress?.((index + 1) / present.length);
  });

  const notes: string[] = [];
  const count = (n: number) => n.toLocaleString('en-US');
  if (present.length > 1) notes.push(`A shapefile holds one kind of geometry, so there is one for each: ${present.map((kind) => `${base}_${kind}`).join(', ')}.`);
  if (mixed) notes.push(`${mixed === 1 ? 'One feature has' : `${count(mixed)} features have`} several kinds of geometry and ${mixed === 1 ? 'is' : 'are'} split across these.`);
  if (empty.length && present.length > 1) notes.push(`Features without geometry are in ${base}_${present[0]}.`);
  if (renamed.size) {
    const list = [...renamed].map(([attribute, field]) => `${attribute} → ${field}`);
    notes.push(`Field names of at most 10 letters for dBASE: ${list.slice(0, 6).join(', ')}${list.length > 6 ? ` and ${count(list.length - 6)} more` : ''}.`);
  }
  if (dropped.size) notes.push(`dBASE holds at most 255 fields; left out: ${[...dropped].slice(0, 6).join(', ')}${dropped.size > 6 ? ' …' : ''}.`);
  if (cut) notes.push(`${cut === 1 ? 'One text was' : `${count(cut)} texts were`} cut to 254 bytes, the most a dBASE field holds.`);
  return { files, notes };
}
