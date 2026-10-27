// SPDX-License-Identifier: GPL-3.0-or-later
// Shapefiles (geometry via shpjs, MIT; attributes via our dBASE reader), GeoJSON and TopoJSON (topojson-client, ISC)
// into map layers. Runs in the reader worker.
import { parseShp } from 'shpjs';
import { feature as topoFeature } from 'topojson-client';
import type { Feature, GeoJsonObject, Geometry } from 'geojson';
import type { Topology } from 'topojson-specification';
import { fromCrsName, fromWkt, type CoordinateSystem } from './crs';
import { readDbf } from './dbf';
import { LayerBuilder, geographic, identity, looksGeographic, styleOf, type MapLayer } from './model';

export interface ShapefileSource {
  name: string;
  shp: ArrayBuffer;
  dbf?: ArrayBuffer;
  prj?: string;
  cpg?: string;
}

export interface JsonSource {
  name: string;
  data: ArrayBuffer;
}

export interface VectorRequest {
  shapefiles: ShapefileSource[];
  json: JsonSource[];
}

export interface VectorResult {
  layers: MapLayer[];
  notes: string[];
}

const SHAPE_TYPES: Record<number, string> = { 31: 'MultiPatch (3D surfaces)' };

/** Bounds of the raw coordinates from the shapefile header (x min, y min, x max, y max). */
function headerBounds(shp: ArrayBuffer): [number, number, number, number] {
  const view = new DataView(shp);
  return [view.getFloat64(36, true), view.getFloat64(44, true), view.getFloat64(52, true), view.getFloat64(60, true)];
}

function readShapefile(source: ShapefileSource, notes: string[]): MapLayer | null {
  if (source.shp.byteLength < 100 || new DataView(source.shp).getInt32(0) !== 9994) {
    notes.push(`${source.name}.shp is not a shapefile.`);
    return null;
  }
  const type = new DataView(source.shp).getInt32(32, true);
  if (SHAPE_TYPES[type]) {
    notes.push(`${source.name}: ${SHAPE_TYPES[type]} shapes cannot be shown.`);
    return null;
  }
  const shapes = (type === 0 ? [] : parseShp(source.shp)) as (Geometry | null)[];
  const table = source.dbf ? readDbf(source.dbf, source.cpg) : null;

  let system: CoordinateSystem | null = null;
  if (source.prj) {
    system = fromWkt(source.prj);
    if (!system) notes.push(`${source.name}: the coordinate system in the .prj file is not supported.`);
  }
  const [minX, minY, maxX, maxY] = headerBounds(source.shp);
  const planar = !system && !(shapes.length === 0 || looksGeographic(minX, minY, maxX, maxY));
  const builder = new LayerBuilder(system?.project ?? (planar ? identity : geographic));
  const count = Math.max(shapes.length, table?.records.length ?? 0);
  for (let i = 0; i < count; i++) builder.add(shapes[i] ?? null, table?.records[i] ?? {});
  return builder.build(source.name, planar, system?.name ?? (planar ? undefined : 'WGS 84 (assumed)'));
}

const STYLE_KEYS = ['stroke', 'stroke-width', 'stroke-opacity', 'fill', 'fill-opacity', 'marker-color'];

function readGeoJson(name: string, root: GeoJsonObject & { crs?: { properties?: { name?: string } } }, notes: string[]): MapLayer {
  const crsName = root.crs?.properties?.name;
  const system = crsName ? fromCrsName(crsName) : null;
  if (crsName && !system) notes.push(`${name}: the coordinate system ${crsName} is not supported; coordinates are shown as they are.`);
  const features: Feature[] =
    root.type === 'FeatureCollection' ? ((root as { features?: Feature[] }).features ?? [])
      : root.type === 'Feature' ? [root as Feature]
        : [{ type: 'Feature', geometry: root as Geometry, properties: {} }];
  const planar = !!crsName && !system;
  const builder = new LayerBuilder(system?.project ?? (planar ? identity : geographic));
  for (const f of features) {
    if (!f || typeof f !== 'object') continue;
    const properties = f.properties && typeof f.properties === 'object' ? { ...f.properties } : {};
    if (f.id !== undefined && !('id' in properties)) properties.id = f.id;
    const styled = STYLE_KEYS.some((key) => key in properties);
    builder.add(f.geometry, properties, styled ? styleOf(properties) : null);
  }
  return builder.build(name, planar, system?.name ?? (planar ? crsName : undefined));
}

function readJson(source: JsonSource, notes: string[]): MapLayer[] {
  const text = new TextDecoder().decode(source.data).replace(/^﻿/, '');
  let root: GeoJsonObject;
  try {
    root = JSON.parse(text);
  } catch (error) {
    throw new Error(`${source.name} is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  if (!root || typeof root !== 'object' || typeof root.type !== 'string') throw new Error(`${source.name} is not GeoJSON or TopoJSON.`);
  if ((root.type as string) === 'Topology') {
    const topology = root as unknown as Topology;
    return Object.entries(topology.objects ?? {}).map(([key, object]) => {
      const converted = topoFeature(topology, object) as GeoJsonObject;
      return readGeoJson(key, converted, notes);
    });
  }
  return [readGeoJson(source.name, root, notes)];
}

export function readVector(request: VectorRequest): VectorResult {
  const notes: string[] = [];
  const layers: MapLayer[] = [];
  // One broken file in an archive only costs its own layers.
  const single = request.shapefiles.length + request.json.length === 1;
  const attempt = (name: string, read: () => void) => {
    try {
      read();
    } catch (error) {
      if (single) throw error;
      notes.push(`${name} could not be read: ${error instanceof Error ? error.message : error}`);
    }
  };
  for (const source of request.shapefiles) {
    attempt(`${source.name}.shp`, () => {
      const layer = readShapefile(source, notes);
      if (layer) layers.push(layer);
    });
  }
  for (const source of request.json) attempt(source.name, () => layers.push(...readJson(source, notes)));
  return { layers, notes };
}
