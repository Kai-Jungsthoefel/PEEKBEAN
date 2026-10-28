// SPDX-License-Identifier: GPL-3.0-or-later
// Map data to GeoJSON, KML, GPX, CSV or shapefiles: reads the shapefiles and JSON files, adds the layers read from
// KML, GPX and TCX on the main thread, and writes the target. No browser APIs, so it runs in the worker.
import type { JsonSource, ShapefileSource } from '../../viewers/map/vector';
import { writeCsv } from './csv';
import { writeGeoJson } from './geojson';
import { writeGpx } from './gpx';
import { writeKml } from './kml';
import { layerAttribute, type FeatureLayer, type OutputFile } from './model';
import { writeShapefiles } from './shapefile';
import { readVectorLayers } from './vector';

export type MapTarget = 'geojson' | 'kml' | 'gpx' | 'csv' | 'shp';

export interface MapConvertRequest {
  /** Layers of KML, GPX and TCX files, already read. */
  layers: FeatureLayer[];
  shapefiles: ShapefileSource[];
  json: JsonSource[];
  /** Notes from reading so far. */
  notes: string[];
  target: MapTarget;
  /** The file's name without extension, for the files written and the names inside them. */
  name: string;
  separator: string;
  /** Starts CSV with a byte order mark, so Excel reads it as UTF-8. */
  bom: boolean;
}

export interface MapConvertResult {
  files: OutputFile[];
  notes: string[];
}

const LABELS: Record<MapTarget, string> = { geojson: 'GeoJSON', kml: 'KML', gpx: 'GPX', csv: 'CSV', shp: 'shapefiles' };

/** UTF-8 bytes of text written in pieces, encoded about a megabyte at a time. */
function encode(pieces: string[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  let batch: string[] = [];
  let length = 0;
  const flush = () => {
    chunks.push(encoder.encode(batch.join('')));
    batch = [];
    length = 0;
  };
  for (const piece of pieces) {
    batch.push(piece);
    length += piece.length;
    if (length > 1 << 20) flush();
  }
  flush();
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
const list = (names: string[]) => (names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', '));

export function convertMap(request: MapConvertRequest, progress: (message: string, fraction?: number) => void): MapConvertResult {
  const { target, name } = request;
  const notes = [...request.notes];
  if (request.shapefiles.length || request.json.length) progress(request.shapefiles.length ? 'Reading shapes and attributes …' : 'Reading features …');
  const vector = readVectorLayers({ shapefiles: request.shapefiles, json: request.json }, notes);
  let layers = [...request.layers, ...vector].filter((layer) => layer.features.length);
  if (!layers.length) throw new Error('The file contains no features.');

  // Without a known coordinate system there is no longitude and latitude to give.
  const planar = layers.filter((layer) => layer.planar).map((layer) => layer.name);
  if (planar.length && (target === 'kml' || target === 'gpx')) {
    layers = layers.filter((layer) => !layer.planar);
    if (!layers.length) throw new Error(`The coordinate system of this file is unknown or not supported, so its coordinates cannot be turned into the longitude and latitude ${LABELS[target]} needs.`);
    notes.push(`Left out, as their coordinate system is unknown or not supported: ${list(planar)}.`);
  } else if (planar.length) {
    notes.push(`${list(planar)}: without a known coordinate system, the coordinates are kept as they are rather than turned into longitude and latitude.`);
  }

  const key = target === 'kml' || target === 'gpx' ? null : layerAttribute(layers);
  if (key) notes.push(`The ${layers.length.toLocaleString('en-US')} layers are merged; the attribute "${key}" names the layer of each feature.`);
  if (target !== 'geojson' && target !== 'gpx' && layers.some((layer) => layer.features.some((f) => f.vertexValues))) {
    notes.push('Time stamps and other values per track point are not kept.');
  }

  const writing = (fraction: number) => progress(`Writing ${LABELS[target]} …`, fraction);
  writing(0);
  switch (target) {
    case 'geojson':
      return { files: [{ name: `${name}.geojson`, data: encode(writeGeoJson(layers, name, writing)), type: 'application/geo+json' }], notes };
    case 'kml':
      return { files: [{ name: `${name}.kml`, data: encode(writeKml(layers, name, writing)), type: 'application/vnd.google-earth.kml+xml' }], notes };
    case 'gpx': {
      const result = writeGpx(layers, name, writing);
      return { files: [{ name: `${name}.gpx`, data: encode(result.lines), type: 'application/gpx+xml' }], notes: [...notes, ...result.notes] };
    }
    case 'csv': {
      const result = writeCsv(layers, request.separator, request.bom, writing);
      return { files: [{ name: `${name}.csv`, data: encode(result.rows), type: 'text/csv' }], notes: [...notes, ...result.notes] };
    }
    case 'shp': {
      // File names inside the ZIP without characters other systems trip over.
      const base = name.replace(/[\\/:*?"<>|\s]+/g, '_') || 'map';
      const result = writeShapefiles(layers, base, writing);
      return { files: result.files.map((file) => ({ ...file, type: 'application/octet-stream' })), notes: [...notes, ...result.notes] };
    }
  }
}
