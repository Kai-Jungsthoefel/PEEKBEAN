// SPDX-License-Identifier: GPL-3.0-or-later
// KML 2.2: a folder per layer, a placemark per feature. Attributes go into ExtendedData under one typed Schema, so
// numbers come back as numbers; colors, line widths and icon links become shared styles.
import type { Geometry, Position } from 'geojson';
import { featureName, type FeatureStyle } from '../../viewers/map/model';
import { decimal, orient, textOf, ticker, type FeatureLayer, type MapFeature } from './model';
import { element, xmlText } from './xml';

/** Attributes KML has its own elements for. */
const OWN = ['name', 'description', 'timestamp', 'timespan'];
const INT = 2 ** 31;

/** KML's color order: alpha, blue, green, red. */
function kmlColor(hex: string, opacity = 1): string {
  let rgb = hex.replace('#', '');
  if (rgb.length === 3) rgb = [...rgb].map((c) => c + c).join('');
  const alpha = Math.round(Math.max(0, Math.min(1, opacity)) * 255).toString(16).padStart(2, '0');
  return `${alpha}${rgb.slice(4, 6)}${rgb.slice(2, 4)}${rgb.slice(0, 2)}`.toLowerCase();
}

function styleKml(id: string, s: FeatureStyle): string {
  const parts: string[] = [];
  if (s.marker || s.iconScale !== undefined || s.icon) {
    const anchor = s.icon && s.iconAnchor ? `<hotSpot x="${s.iconAnchor[0]}" y="${s.iconAnchor[1]}" xunits="${xmlText(s.iconAnchor[2])}" yunits="${xmlText(s.iconAnchor[3])}"/>` : '';
    parts.push(
      `<IconStyle>${s.marker ? `<color>${kmlColor(s.marker)}</color>` : ''}${s.iconScale !== undefined ? `<scale>${s.iconScale}</scale>` : ''}${s.icon ? `<Icon><href>${xmlText(s.icon)}</href></Icon>` : ''}${anchor}</IconStyle>`,
    );
  }
  if (s.stroke || s.strokeWidth !== undefined || s.strokeOpacity !== undefined) {
    parts.push(`<LineStyle><color>${kmlColor(s.stroke ?? '#ffffff', s.strokeOpacity)}</color>${s.strokeWidth !== undefined ? `<width>${s.strokeWidth}</width>` : ''}</LineStyle>`);
  }
  if (s.fill || s.fillOpacity !== undefined) {
    // Without an opacity, fills are 60 % opaque, as in GeoJSON's simplestyle.
    const color = s.fill ? `<color>${kmlColor(s.fill, s.fillOpacity ?? 0.6)}</color>` : '';
    parts.push(`<PolyStyle>${color}${s.fillOpacity === 0 ? '<fill>0</fill>' : ''}</PolyStyle>`);
  }
  return parts.length ? `<Style id="${id}">${parts.join('')}</Style>` : '';
}

const coordinates = (line: Position[]) => line.map((p) => p.slice(0, 3).map(decimal).join(',')).join(' ');

function geometryKml(g: Geometry): string {
  const multi = (children: string[]) => (children.length === 1 ? children[0] : `<MultiGeometry>${children.join('')}</MultiGeometry>`);
  const point = (p: Position) => `<Point><coordinates>${coordinates([p])}</coordinates></Point>`;
  const line = (l: Position[]) => `<LineString><tessellate>1</tessellate><coordinates>${coordinates(l)}</coordinates></LineString>`;
  const ring = (r: Position[]) => `<LinearRing><coordinates>${coordinates(r)}</coordinates></LinearRing>`;
  const polygon = (rings: Position[][]) => {
    const [outer, ...holes] = orient(rings, false);
    return `<Polygon><tessellate>1</tessellate><outerBoundaryIs>${ring(outer)}</outerBoundaryIs>${holes.map((h) => `<innerBoundaryIs>${ring(h)}</innerBoundaryIs>`).join('')}</Polygon>`;
  };
  switch (g.type) {
    case 'Point':
      return point(g.coordinates);
    case 'MultiPoint':
      return multi(g.coordinates.map(point));
    case 'LineString':
      return line(g.coordinates);
    case 'MultiLineString':
      return multi(g.coordinates.map(line));
    case 'Polygon':
      return polygon(g.coordinates);
    case 'MultiPolygon':
      return multi(g.coordinates.map(polygon));
    case 'GeometryCollection':
      return `<MultiGeometry>${g.geometries.map(geometryKml).join('')}</MultiGeometry>`;
  }
}

/** Schema type of an attribute: int and double when all its values are such numbers, else string. */
function fieldTypes(layers: FeatureLayer[]): Map<string, string> {
  const types = new Map<string, string>();
  for (const layer of layers) {
    for (const { properties } of layer.features) {
      for (const [key, value] of Object.entries(properties)) {
        if (OWN.includes(key)) continue;
        const known = types.get(key);
        if (value === null || value === undefined) {
          if (!known) types.set(key, 'none');
          continue;
        }
        // Booleans stay text: togeojson reads every non-empty bool, "false" as well, as true.
        const type = typeof value !== 'number' || !Number.isFinite(value) ? 'string' : Number.isInteger(value) && value >= -INT && value < INT ? 'int' : 'double';
        if (!known || known === 'none') types.set(key, type);
        else if (known !== type) types.set(key, known !== 'string' && type !== 'string' ? 'double' : 'string');
      }
    }
  }
  for (const [key, type] of types) if (type === 'none') types.set(key, 'string');
  return types;
}

const TIME = /^-?\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?$/;
const isTime = (value: unknown): value is string => typeof value === 'string' && TIME.test(value.trim());

function placemark(feature: MapFeature, styleId: string | undefined, schema: Map<string, string>): string {
  const p = feature.properties;
  const extra: string[] = [];
  const own = (key: string) => p[key] !== undefined && p[key] !== null;
  const text = (key: string) => typeof p[key] === 'string' || typeof p[key] === 'number';
  // A name of its own, else the attribute a name is usually in, which then stays an attribute as well.
  const name = text('name') ? textOf(p.name) : featureName(p);
  if (own('name') && !text('name')) extra.push(`<Data name="name"><value>${xmlText(textOf(p.name))}</value></Data>`);
  if (own('description') && !text('description')) extra.push(`<Data name="description"><value>${xmlText(textOf(p.description))}</value></Data>`);
  let time = '';
  const span = p.timespan as { begin?: unknown; end?: unknown } | undefined;
  if (isTime(p.timestamp)) time = `<TimeStamp><when>${xmlText(p.timestamp.trim())}</when></TimeStamp>`;
  else if (own('timestamp')) extra.push(`<Data name="timestamp"><value>${xmlText(textOf(p.timestamp))}</value></Data>`);
  // A placemark has one time: a time stamp, else a time span.
  if (!time && span && typeof span === 'object' && (isTime(span.begin) || isTime(span.end))) {
    time = `<TimeSpan>${isTime(span.begin) ? `<begin>${xmlText(span.begin)}</begin>` : ''}${isTime(span.end) ? `<end>${xmlText(span.end)}</end>` : ''}</TimeSpan>`;
  } else if (own('timespan')) {
    extra.push(`<Data name="timespan"><value>${xmlText(textOf(p.timespan))}</value></Data>`);
  }
  const data = Object.entries(p)
    .filter(([key, value]) => schema.has(key) && value !== null && value !== undefined)
    .map(([key, value]) => `<SimpleData name="${xmlText(key)}">${xmlText(typeof value === 'number' ? String(value) : textOf(value))}</SimpleData>`);
  const extended = data.length || extra.length ? `<ExtendedData>${extra.join('')}${data.length ? `<SchemaData schemaUrl="#attributes">${data.join('')}</SchemaData>` : ''}</ExtendedData>` : '';
  return [
    '<Placemark>',
    element('name', name),
    text('description') ? element('description', textOf(p.description)) : '',
    time,
    styleId ? `<styleUrl>#${styleId}</styleUrl>` : '',
    extended,
    feature.geometry ? geometryKml(feature.geometry) : '',
    '</Placemark>',
  ].join('');
}

/** The file in lines, a placemark each; a single string could pass the length JavaScript allows for large files. */
export function writeKml(layers: FeatureLayer[], name: string, progress?: (fraction: number) => void): string[] {
  const styles = new Map<string, string>();
  const styleIds = new Map<string, string>();
  for (const layer of layers) {
    for (const { style } of layer.features) {
      if (!style) continue;
      const key = JSON.stringify(style);
      if (styleIds.has(key)) continue;
      const id = `s${styleIds.size + 1}`;
      const xml = styleKml(id, style);
      styleIds.set(key, xml ? id : '');
      if (xml) styles.set(id, xml);
    }
  }
  const schema = fieldTypes(layers);
  const tick = ticker(layers.reduce((sum, layer) => sum + layer.features.length, 0), progress);
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<kml xmlns="http://www.opengis.net/kml/2.2">',
    '<Document>',
    element('name', name),
    ...styles.values(),
  ];
  if (schema.size) {
    lines.push(`<Schema name="${xmlText(name)}" id="attributes">`);
    for (const [key, type] of schema) lines.push(`  <SimpleField name="${xmlText(key)}" type="${type}"/>`);
    lines.push('</Schema>');
  }
  for (const layer of layers) {
    lines.push('<Folder>', `  ${element('name', layer.name)}${layer.hidden ? '<visibility>0</visibility>' : ''}`);
    for (const feature of layer.features) {
      lines.push(`  ${placemark(feature, feature.style && styleIds.get(JSON.stringify(feature.style)), schema)}`);
      tick();
    }
    lines.push('</Folder>');
  }
  lines.push('</Document>', '</kml>');
  return lines.filter((line) => line !== '').map((line) => `${line}\n`);
}
