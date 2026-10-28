// SPDX-License-Identifier: GPL-3.0-or-later
// Shapefiles, GeoJSON and TopoJSON for the converter, with the readers and coordinate systems of the map viewer
// (viewers/map/vector.ts); the features stay GeoJSON in longitude and latitude, with their elevations, instead of
// becoming map layers. Runs in the converter's worker.
import { parseShp } from 'shpjs';
import { feature as topoFeature } from 'topojson-client';
import type { Feature, GeoJsonObject, Geometry } from 'geojson';
import type { Topology } from 'topojson-specification';
import { fromCrsName, fromWkt, type CoordinateSystem } from '../../viewers/map/crs';
import { readDbf } from '../../viewers/map/dbf';
import { identity, looksGeographic, styleOf, type Projector } from '../../viewers/map/model';
import type { JsonSource, VectorRequest } from '../../viewers/map/vector';
import { cleanGeometry, rounded, type FeatureLayer, type MapFeature, type VertexValues } from './model';

/** Longitude and latitude stay as they are; anything else is converted and rounded. */
const projectorOf = (system: CoordinateSystem | null): Projector | undefined =>
  system && system.toLonLat !== identity ? rounded(system.toLonLat) : undefined;

function readShapefile(source: VectorRequest['shapefiles'][number], notes: string[]): FeatureLayer | null {
  const view = new DataView(source.shp);
  if (source.shp.byteLength < 100 || view.getInt32(0) !== 9994) {
    notes.push(`${source.name}.shp is not a shapefile.`);
    return null;
  }
  const type = view.getInt32(32, true);
  if (type === 31) {
    notes.push(`${source.name}: MultiPatch (3D surfaces) shapes cannot be converted.`);
    return null;
  }
  const shapes = (type === 0 ? [] : parseShp(source.shp)) as (Geometry | null)[];
  const table = source.dbf ? readDbf(source.dbf, source.cpg) : null;

  let system: CoordinateSystem | null = null;
  if (source.prj) {
    system = fromWkt(source.prj);
    if (!system) notes.push(`${source.name}: the coordinate system in the .prj file is not supported.`);
  }
  // Bounds from the header, as the viewer decides: without a known system, coordinates in degrees are longitude/latitude.
  const bounds = [36, 44, 52, 60].map((at) => view.getFloat64(at, true)) as [number, number, number, number];
  const planar = !system && !(shapes.length === 0 || looksGeographic(...bounds));
  const project = projectorOf(system);
  const features: MapFeature[] = [];
  const count = Math.max(shapes.length, table?.records.length ?? 0);
  for (let i = 0; i < count; i++) features.push({ geometry: cleanGeometry(shapes[i], project), properties: table?.records[i] ?? {} });
  return { name: source.name, features, planar };
}

const STYLE_KEYS = ['stroke', 'stroke-width', 'stroke-opacity', 'fill', 'fill-opacity', 'marker-color'];

/** togeojson's values per vertex ("coordinateProperties"), which GeoJSON written by it or by us carries. */
function vertexValuesOf(value: unknown): Record<string, VertexValues> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, VertexValues] => Array.isArray(entry[1]));
  return entries.length ? Object.fromEntries(entries) : undefined;
}

function readGeoJson(name: string, root: GeoJsonObject & { crs?: { properties?: { name?: string } } }, notes: string[]): FeatureLayer {
  const crsName = root.crs?.properties?.name;
  const system = crsName ? fromCrsName(crsName) : null;
  if (crsName && !system) notes.push(`${name}: the coordinate system ${crsName} is not supported.`);
  const list: Feature[] =
    root.type === 'FeatureCollection' ? ((root as { features?: Feature[] }).features ?? [])
      : root.type === 'Feature' ? [root as Feature]
        : [{ type: 'Feature', geometry: root as Geometry, properties: {} }];
  const project = projectorOf(system);
  const features: MapFeature[] = [];
  for (const f of list) {
    if (!f || typeof f !== 'object') continue;
    const properties: Record<string, unknown> = f.properties && typeof f.properties === 'object' ? { ...f.properties } : {};
    if (f.id !== undefined && !('id' in properties)) properties.id = f.id;
    const vertexValues = vertexValuesOf(properties.coordinateProperties);
    if (vertexValues) delete properties.coordinateProperties;
    const style = STYLE_KEYS.some((key) => key in properties) ? styleOf(properties) : null;
    features.push({ geometry: cleanGeometry(f.geometry, project), properties, ...(style && { style }), ...(vertexValues && { vertexValues }) });
  }
  return { name, features, planar: !!crsName && !system };
}

function readJson(source: JsonSource, notes: string[]): FeatureLayer[] {
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
    return Object.entries(topology.objects ?? {}).map(([key, object]) => readGeoJson(key, topoFeature(topology, object) as GeoJsonObject, notes));
  }
  return [readGeoJson(source.name, root, notes)];
}

/** The layers of shapefiles and JSON files; one broken file among several only costs its own layers. */
export function readVectorLayers(request: VectorRequest, notes: string[]): FeatureLayer[] {
  const layers: FeatureLayer[] = [];
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
  return layers;
}
