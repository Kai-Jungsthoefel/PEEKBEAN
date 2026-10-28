// SPDX-License-Identifier: GPL-3.0-or-later
// CSV: a row per feature with all attributes, the geometry as Well-Known Text in a last column named WKT, the name
// GDAL and QGIS pick up as geometry. Rows end in CRLF as RFC 4180 has it.
import type { Geometry, Position } from 'geojson';
import { attributeNames, decimal, everyHasZ, layerAttribute, rightHand, textOf, ticker, uniqueName, type FeatureLayer } from './model';

/** Excel cuts longer cell values off. */
const EXCEL_CELL = 32767;

/** ISO Well-Known Text, with Z when every vertex has an elevation; empty for no geometry. */
export function toWkt(geometry: Geometry | null): string {
  if (!geometry) return '';
  const z = everyHasZ(geometry);
  const position = (p: Position) => (z ? `${decimal(p[0])} ${decimal(p[1])} ${decimal(p[2])}` : `${decimal(p[0])} ${decimal(p[1])}`);
  const sequence = (line: Position[]) => `(${line.map(position).join(', ')})`;
  const polygon = (rings: Position[][]) => `(${rings.map(sequence).join(', ')})`;
  const tag = (name: string) => (z ? `${name} Z ` : `${name} `);
  const write = (g: Geometry): string => {
    switch (g.type) {
      case 'Point':
        return `${tag('POINT')}(${position(g.coordinates)})`;
      case 'MultiPoint':
        return `${tag('MULTIPOINT')}(${g.coordinates.map((p) => `(${position(p)})`).join(', ')})`;
      case 'LineString':
        return `${tag('LINESTRING')}${sequence(g.coordinates)}`;
      case 'MultiLineString':
        return `${tag('MULTILINESTRING')}(${g.coordinates.map(sequence).join(', ')})`;
      case 'Polygon':
        return `${tag('POLYGON')}${polygon(g.coordinates)}`;
      case 'MultiPolygon':
        return `${tag('MULTIPOLYGON')}(${g.coordinates.map(polygon).join(', ')})`;
      case 'GeometryCollection':
        return g.geometries.length ? `${tag('GEOMETRYCOLLECTION')}(${g.geometries.map(write).join(', ')})` : 'GEOMETRYCOLLECTION EMPTY';
    }
  };
  return write(rightHand(geometry));
}

/** The file in rows; a single string could pass the length JavaScript allows for large files. */
export function writeCsv(layers: FeatureLayer[], separator: string, bom: boolean, progress?: (fraction: number) => void): { rows: string[]; notes: string[] } {
  const key = layerAttribute(layers);
  const names = attributeNames(layers);
  const used = new Set([...names, ...(key ? [key] : [])].map((n) => n.toLowerCase()));
  const geometryColumn = uniqueName('WKT', used);
  const quote = (value: string) => (value.includes(separator) || /["\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const rows = [`${bom ? '﻿' : ''}${[...(key ? [key] : []), ...names, geometryColumn].map(quote).join(separator)}\r\n`];
  const tick = ticker(layers.reduce((sum, layer) => sum + layer.features.length, 0), progress);
  let long = 0;
  for (const layer of layers) {
    for (const feature of layer.features) {
      const wkt = toWkt(feature.geometry);
      if (wkt.length > EXCEL_CELL) long++;
      const cells = [...(key ? [layer.name] : []), ...names.map((name) => textOf(feature.properties[name])), wkt];
      rows.push(`${cells.map(quote).join(separator)}\r\n`);
      tick();
    }
  }
  const notes = long
    ? [`${long === 1 ? 'One geometry is' : `${long.toLocaleString('en-US')} geometries are`} longer than the ${EXCEL_CELL.toLocaleString('en-US')} characters Excel keeps in a cell; open the file in a GIS instead.`]
    : [];
  return { rows, notes };
}
