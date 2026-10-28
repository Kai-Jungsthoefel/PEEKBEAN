// SPDX-License-Identifier: GPL-3.0-or-later
// Opens a map file for the converter on the main thread, as the viewer does: unpacks ZIP and KMZ archives and reads
// KML, GPX and TCX with togeojson, which needs the browser's XML parser. Shapefiles, GeoJSON and TopoJSON go on to the
// worker unread. Nothing the file links to is loaded.
import type { F } from '@tmcw/togeojson';
import type { Geometry } from 'geojson';
import { styleOf, type FeatureStyle } from '../../viewers/map/model';
import { attributes, collectSources, decodeXml, gpsGroups, kmlGroups, parseXml } from '../../viewers/map/read';
import type { JsonSource, ShapefileSource } from '../../viewers/map/vector';
import { cleanGeometry, withoutZeroElevation, type FeatureLayer, type MapFeature, type VertexValues } from './model';

export interface MapSources {
  /** Layers of the KML, GPX and TCX files, already read. */
  layers: FeatureLayer[];
  shapefiles: ShapefileSource[];
  json: JsonSource[];
  notes: string[];
}

interface Skipped {
  networkLinks: number;
  overlays: number;
  icons: number;
}

/** Icons the KML file links to outside itself keep working; those inside a KMZ do not travel into a plain KML. */
const portableIcon = (href: string) => /^(https?:\/\/|data:image\/)/i.test(href);

/** Lengths of the parts of a line, to recognize arrays that hold one value per vertex. */
function lineLengths(geometry: Geometry | null): number[] | null {
  if (geometry?.type === 'LineString') return [geometry.coordinates.length];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates.map((line) => line.length);
  return null;
}

function perVertex(value: unknown, lengths: number[]): value is VertexValues {
  if (!Array.isArray(value)) return false;
  if (lengths.length === 1) return value.length === lengths[0] && value.every((v) => v === null || typeof v === 'number');
  return value.length === lengths.length && value.every((part, i) => Array.isArray(part) && part.length === lengths[i]);
}

function featureOf(f: F, skipped: Skipped, kml: boolean): MapFeature | null {
  const raw = (f.properties ?? {}) as Record<string, unknown>;
  const type = raw['@geometry-type'];
  if (type === 'networklink') {
    skipped.networkLinks++;
    return null;
  }
  let style: FeatureStyle | null = styleOf(raw);
  if (type === 'groundoverlay') {
    // The overlay's image does not come along; its box stays as an outline, as the viewer draws it.
    skipped.overlays++;
    style = { stroke: '#8c939b', strokeWidth: 1, fillOpacity: 0 };
  } else if (style?.icon && !portableIcon(style.icon)) {
    skipped.icons++;
    delete style.icon;
    delete style.iconAnchor;
    if (!Object.keys(style).length) style = null;
  }
  // KML writes ",0" for the ground; GPX and TCX elevations are real ones, even at sea level.
  const geometry = kml ? withoutZeroElevation(cleanGeometry(f.geometry)) : cleanGeometry(f.geometry);
  const properties = attributes(raw);
  const vertexValues: Record<string, VertexValues> = {};
  const coordinateProperties = raw.coordinateProperties;
  if (coordinateProperties && typeof coordinateProperties === 'object') {
    for (const [key, value] of Object.entries(coordinateProperties)) if (Array.isArray(value)) vertexValues[key] = value;
  }
  // TCX laps list cadence, speed and power per track point among their attributes.
  const lengths = lineLengths(geometry);
  if (lengths) {
    for (const [key, value] of Object.entries(properties)) {
      if (perVertex(value, lengths)) {
        vertexValues[key] = value;
        delete properties[key];
      }
    }
  }
  return {
    geometry,
    properties,
    ...(style && { style }),
    ...(Object.keys(vertexValues).length ? { vertexValues } : {}),
    ...(raw._gpxType === 'rte' && { route: true }),
  };
}

function layerOf(name: string, list: F[], skipped: Skipped, kml: boolean, hidden = false): FeatureLayer | null {
  const features = list.map((f) => featureOf(f, skipped, kml)).filter((f): f is MapFeature => f !== null);
  return features.length ? { name, features, ...(hidden && { hidden }) } : null;
}

export async function readSources(file: File, progress: (message: string) => void): Promise<MapSources> {
  const sources = await collectSources(file, progress);
  // Everything needed is read from the archive by now; icons inside it are not carried over.
  await sources.zip?.close();
  const layers: FeatureLayer[] = [];
  const skipped: Skipped = { networkLinks: 0, overlays: 0, icons: 0 };
  const add = (layer: FeatureLayer | null) => layer && layers.push(layer);
  for (const source of sources.xml) {
    progress(`Reading ${source.name} …`);
    const doc = parseXml(decodeXml(source.bytes), source.name);
    const root = doc.documentElement.localName;
    if (root === 'kml') {
      for (const group of kmlGroups(doc, source.name)) add(layerOf(group.name, group.features, skipped, true, group.hidden));
    } else if (root === 'gpx' || root === 'TrainingCenterDatabase') {
      const prefix = sources.xml.length > 1 ? source.name : '';
      for (const group of gpsGroups(doc, root === 'gpx' ? 'gpx' : 'tcx', prefix)) add(layerOf(group.name, group.features, skipped, false));
    } else if (sources.xml.length === 1 && !sources.shapefiles.length && !sources.json.length) {
      throw new Error(`This XML file (<${root}>) is not KML, GPX or TCX.`);
    } else {
      sources.notes.push(`${source.name}: <${root}> is not KML, GPX or TCX.`);
    }
  }
  const { networkLinks, overlays, icons } = skipped;
  if (networkLinks) sources.notes.push(networkLinks === 1 ? 'A network link was left out: it loads content from another server.' : `${networkLinks.toLocaleString('en-US')} network links were left out: they load content from other servers.`);
  if (overlays) sources.notes.push(overlays === 1 ? 'The image of a ground overlay is not kept, only its outline.' : `The images of ${overlays.toLocaleString('en-US')} ground overlays are not kept, only their outlines.`);
  if (icons) sources.notes.push('Icon images that come with the file are not kept; points keep their colors.');
  return { layers, shapefiles: sources.shapefiles, json: sources.json, notes: sources.notes };
}
