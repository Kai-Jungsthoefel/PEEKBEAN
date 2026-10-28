// SPDX-License-Identifier: GPL-3.0-or-later
// GPX 1.1: points become waypoints and lines tracks (routes stay routes), with elevation and time, and the heart
// rate, cadence and temperature of track points in Garmin's track point extension, which sports apps read. Areas have
// no place in GPX and are left out.
import type { Position } from 'geojson';
import { featureName } from '../../viewers/map/model';
import { decimal, partsOf, ticker, type FeatureLayer, type MapFeature, type VertexValues } from './model';
import { dateTime, element, xmlText } from './xml';

const TPX = 'http://www.garmin.com/xmlschemas/TrackPointExtension/v1';

/** Values per point the extension holds: togeojson's names for them, the element, the allowed range; in schema order. */
const EXTENSIONS: { names: string[]; tag: string; min: number; max: number; whole: boolean }[] = [
  { names: ['atemps'], tag: 'atemp', min: -Infinity, max: Infinity, whole: false },
  { names: ['heart', 'heartRates'], tag: 'hr', min: 0, max: 255, whole: true },
  { names: ['cads', 'cadences'], tag: 'cad', min: 0, max: 254, whole: true },
];
const KNOWN = new Set(['times', ...EXTENSIONS.flatMap((e) => e.names)]);

const text = (value: unknown) => ((typeof value === 'string' || typeof value === 'number') && String(value).trim() ? String(value).trim() : undefined);

/** GPX wants longitudes from -180 to 180. */
const longitude = (x: number) => (x >= -180 && x <= 180 ? x : ((((x + 180) % 360) + 360) % 360) - 180);

/** The values of one part of a line, if there is one for each of its `length` vertices. */
function partValues(values: VertexValues | undefined, part: number, length: number): unknown[] | null {
  if (!values) return null;
  const list = Array.isArray(values[0]) ? values[part] : part === 0 ? values : null;
  return Array.isArray(list) && list.length === length ? list : null;
}

/** Name, comment, description, source and links, in the order GPX wants them; `sym` only for waypoints. */
function describe(feature: MapFeature, waypoint: boolean): string {
  const p = feature.properties;
  const links = Array.isArray(p.links)
    ? (p.links as { href?: unknown; text?: unknown; type?: unknown }[])
        .filter((link) => link && typeof link.href === 'string')
        .map((link) => `<link href="${xmlText(link.href as string)}">${element('text', text(link.text))}${element('type', text(link.type))}</link>`)
    : [];
  return [
    element('name', text(p.name) ?? featureName(p)),
    element('cmt', text(p.cmt)),
    element('desc', text(p.desc) ?? text(p.description)),
    element('src', text(p.src)),
    ...links,
    waypoint ? element('sym', text(p.sym)) : '',
    element('type', text(p.type)),
  ].join('');
}

/** The file in lines, a point each; a single string could pass the length JavaScript allows for long tracks. */
export function writeGpx(layers: FeatureLayer[], name: string, progress?: (fraction: number) => void): { lines: string[]; notes: string[] } {
  // GPX wants all waypoints first, then the routes, then the tracks.
  const waypoints: string[] = [];
  const routes: string[] = [];
  const tracks: string[] = [];
  let areas = 0;
  let empty = 0;
  let extended = false;
  const dropped = new Set<string>();
  const bounds = [Infinity, Infinity, -Infinity, -Infinity];
  const tick = ticker(layers.reduce((sum, layer) => sum + layer.features.length, 0), progress);

  const point = (tag: string, p: Position, time: string | undefined, inner: string) => {
    const [lon, lat] = [longitude(p[0]), p[1]];
    bounds[0] = Math.min(bounds[0], lat);
    bounds[1] = Math.min(bounds[1], lon);
    bounds[2] = Math.max(bounds[2], lat);
    bounds[3] = Math.max(bounds[3], lon);
    const content = `${p.length > 2 ? `<ele>${decimal(p[2])}</ele>` : ''}${time ? `<time>${time}</time>` : ''}${inner}`;
    const open = `<${tag} lat="${decimal(lat)}" lon="${decimal(lon)}"`;
    return content ? `${open}>${content}</${tag}>` : `${open}/>`;
  };

  for (const layer of layers) {
    for (const feature of layer.features) {
      tick();
      const { points, lines, polygons } = partsOf(feature.geometry);
      if (!feature.geometry) empty++;
      if (polygons.length) areas++;
      if (points.length) {
        const about = describe(feature, true);
        const time = dateTime(feature.properties.time);
        for (const p of points) waypoints.push(point('wpt', p, time, about));
      }
      if (!lines.length) continue;

      // Values per vertex belong to a LineString or MultiLineString, not to the lines of a collection.
      const values = feature.geometry?.type === 'LineString' || feature.geometry?.type === 'MultiLineString' ? (feature.vertexValues ?? {}) : {};
      for (const key of Object.keys(values)) if (!KNOWN.has(key)) dropped.add(key);
      const route = feature.route && lines.length === 1;
      const out = route ? routes : tracks;
      out.push(`<${route ? 'rte' : 'trk'}>${describe(feature, false)}`);
      lines.forEach((line, part) => {
        const times = partValues(values.times, part, line.length);
        const extensions = EXTENSIONS.map((e) => ({ ...e, values: e.names.map((n) => partValues(values[n], part, line.length)).find(Boolean) ?? null })).filter((e) => e.values);
        if (!route) out.push('<trkseg>');
        line.forEach((p, i) => {
          const tags = extensions
            .map(({ tag, values: list, min, max, whole }) => {
              const v = list![i];
              return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? `<gpxtpx:${tag}>${whole ? Math.round(v) : decimal(v)}</gpxtpx:${tag}>` : '';
            })
            .join('');
          if (tags) extended = true;
          const inner = tags ? `<extensions><gpxtpx:TrackPointExtension>${tags}</gpxtpx:TrackPointExtension></extensions>` : '';
          out.push(point(route ? 'rtept' : 'trkpt', p, dateTime(times?.[i]), inner));
        });
        if (!route) out.push('</trkseg>');
      });
      out.push(route ? '</rte>' : '</trk>');
    }
  }

  if (!waypoints.length && !routes.length && !tracks.length) {
    throw new Error(areas ? 'GPX holds only points and lines, and this file has only areas.' : 'The file has no points or lines to write as GPX.');
  }
  const notes: string[] = [];
  const count = (n: number) => n.toLocaleString('en-US');
  if (areas) notes.push(`${areas === 1 ? 'One area was' : `${count(areas)} areas were`} left out: GPX holds only points and lines.`);
  if (empty) notes.push(`${empty === 1 ? 'One feature' : `${count(empty)} features`} without geometry left out.`);
  if (dropped.size) notes.push(`Values per track point that GPX has no place for are left out: ${[...dropped].join(', ')}.`);

  const locations = `http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd${extended ? ` ${TPX} http://www.garmin.com/xmlschemas/TrackPointExtensionv1.xsd` : ''}`;
  const [minLat, minLon, maxLat, maxLon] = bounds.map(decimal);
  const head = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<gpx version="1.1" creator="Peekbean" xmlns="http://www.topografix.com/GPX/1/1" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"${extended ? ` xmlns:gpxtpx="${TPX}"` : ''} xsi:schemaLocation="${locations}">`,
    `<metadata>${element('name', name)}<bounds minlat="${minLat}" minlon="${minLon}" maxlat="${maxLat}" maxlon="${maxLon}"/></metadata>`,
  ];
  return { lines: head.concat(waypoints, routes, tracks, ['</gpx>']).map((line) => `${line}\n`), notes };
}
