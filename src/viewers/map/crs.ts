// SPDX-License-Identifier: GPL-3.0-or-later
// Coordinate systems via proj4 (MIT): .prj files (WKT), GeoJSON "crs" members and the systems a user can pick for
// files without one. Everything is computed here; proj4 never loads grids or definitions from anywhere.
import proj4 from 'proj4';
import { geographic, mercator, type Projector } from './model';

export interface CoordinateSystem {
  /** Name to show, e.g. "ETRS89 / UTM zone 32N". */
  name: string;
  /** File coordinates → Web Mercator meters. */
  project: Projector;
}

/**
 * Datum shifts to WGS84 that ESRI-style .prj files leave out. Without them positions are off by up to 150 m.
 * Values as in the EPSG transformations most software uses by default.
 */
const DATUM_SHIFTS: [RegExp, string][] = [
  [/Deutsches_Hauptdreiecksnetz|DHDN|Potsdam/i, '598.1,73.7,418.2,0.202,0.045,-2.455,6.7'],
  [/OSGB.?1936/i, '446.448,-125.157,542.06,0.15,0.247,0.842,-20.489'],
  [/CH1903/i, '674.374,15.056,405.346,0,0,0,0'],
  [/Amersfoort/i, '565.4171,50.3319,465.5524,1.9342,-1.6677,9.1019,4.0725'],
  [/MGI|Militar_Geographische/i, '577.326,90.129,463.919,5.137,1.474,5.297,2.4232'],
];

const utm = (zone: number, south: string, datum: string) => `+proj=utm +zone=${zone}${south} ${datum} +units=m +no_defs`;
const gaussKrueger = (zone: number) =>
  `+proj=tmerc +lat_0=0 +lon_0=${zone * 3} +k=1 +x_0=${zone * 1e6 + 500000} +y_0=0 +ellps=bessel +towgs84=${DATUM_SHIFTS[0][1]} +units=m +no_defs`;

/** proj4 definitions of EPSG codes common in exchanged files (Germany and neighbors, UTM, Web Mercator). */
function epsgDefinition(code: number): string | null {
  if ([4326, 4258, 4269, 4979, 4937].includes(code)) return '+proj=longlat +datum=WGS84 +no_defs';
  if ([3857, 900913, 3785, 102100, 102113].includes(code)) return '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +no_defs';
  if (code >= 25828 && code <= 25838) return utm(code - 25800, '', '+ellps=GRS80');
  if (code >= 32601 && code <= 32660) return utm(code - 32600, '', '+datum=WGS84');
  if (code >= 32701 && code <= 32760) return utm(code - 32700, ' +south', '+datum=WGS84');
  if (code >= 31466 && code <= 31469) return gaussKrueger(code - 31464);
  if (code === 4647) return '+proj=tmerc +lat_0=0 +lon_0=9 +k=0.9996 +x_0=32500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
  if (code === 5650) return '+proj=tmerc +lat_0=0 +lon_0=15 +k=0.9996 +x_0=33500000 +y_0=0 +ellps=GRS80 +units=m +no_defs';
  if (code === 2056) return `+proj=somerc +lat_0=46.9524055555556 +lon_0=7.43958333333333 +k_0=1 +x_0=2600000 +y_0=1200000 +ellps=bessel +towgs84=${DATUM_SHIFTS[2][1]} +units=m +no_defs`;
  if (code === 27700) return `+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=${DATUM_SHIFTS[1][1]} +units=m +no_defs`;
  if (code === 28992) return `+proj=sterea +lat_0=52.1561605555556 +lon_0=5.38763888888889 +k=0.9999079 +x_0=155000 +y_0=463000 +ellps=bessel +towgs84=${DATUM_SHIFTS[3][1]} +units=m +no_defs`;
  if (code === 2154) return '+proj=lcc +lat_0=46.5 +lon_0=3 +lat_1=49 +lat_2=44 +x_0=700000 +y_0=6600000 +ellps=GRS80 +units=m +no_defs';
  return null;
}

/** Coordinate systems offered for files that do not say which one they use. */
export const PICKABLE: { code: number; name: string }[] = [
  { code: 25832, name: 'ETRS89 / UTM zone 32N' },
  { code: 25833, name: 'ETRS89 / UTM zone 33N' },
  { code: 4647, name: 'ETRS89 / UTM zone 32N (zE-N)' },
  { code: 5650, name: 'ETRS89 / UTM zone 33N (zE-N)' },
  { code: 31466, name: 'DHDN / Gauss-Krüger zone 2' },
  { code: 31467, name: 'DHDN / Gauss-Krüger zone 3' },
  { code: 31468, name: 'DHDN / Gauss-Krüger zone 4' },
  { code: 31469, name: 'DHDN / Gauss-Krüger zone 5' },
  { code: 32632, name: 'WGS 84 / UTM zone 32N' },
  { code: 32633, name: 'WGS 84 / UTM zone 33N' },
  { code: 3857, name: 'WGS 84 / Pseudo-Mercator' },
  { code: 2056, name: 'CH1903+ / LV95 (Switzerland)' },
  { code: 27700, name: 'OSGB 1936 / British National Grid' },
  { code: 28992, name: 'Amersfoort / RD New (Netherlands)' },
  { code: 2154, name: 'RGF93 / Lambert-93 (France)' },
];

function fromDefinition(definition: string, name: string): CoordinateSystem {
  if (definition.startsWith('+proj=longlat +datum=WGS84')) return { name, project: geographic };
  const converter = proj4(definition);
  const lonLat = [0, 0];
  return {
    name,
    project: (x, y, out) => {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
      lonLat[0] = x;
      lonLat[1] = y;
      const p = converter.inverse(lonLat);
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) return false;
      mercator(p[0], p[1], out);
      return true;
    },
  };
}

export function fromEpsg(code: number): CoordinateSystem | null {
  const definition = epsgDefinition(code);
  if (!definition) return null;
  return fromDefinition(definition, PICKABLE.find((c) => c.code === code)?.name ?? `EPSG:${code}`);
}

/** The "crs" member of older GeoJSON files, e.g. "urn:ogc:def:crs:EPSG::25832" or "EPSG:4326". */
export function fromCrsName(name: string): CoordinateSystem | null {
  if (/CRS84$/i.test(name)) return { name: 'WGS 84', project: geographic };
  const code = /EPSG:{1,2}(?:[\d.]*:)?(\d+)$/i.exec(name.trim())?.[1];
  return code ? fromEpsg(Number(code)) : null;
}

/** A .prj file. Returns null when proj4 cannot read it. */
export function fromWkt(wkt: string): CoordinateSystem | null {
  let text = wkt.trim().replace(/^﻿/, '');
  if (!text) return null;
  const name = (/^\s*[A-Z]+\["([^"]*)"/.exec(text)?.[1] ?? 'Unnamed coordinate system').replace(/_/g, ' ');
  if (!/TOWGS84/i.test(text)) {
    text = text.replace(/(DATUM\[\s*"([^"]*)"\s*,\s*SPHEROID\[[^\]]*\])/i, (match, _datum: string, datumName: string) => {
      const shift = DATUM_SHIFTS.find(([pattern]) => pattern.test(datumName))?.[1];
      return shift ? `${match},TOWGS84[${shift}]` : match;
    });
  }
  // Longitude/latitude on WGS84 or ETRS89 (the same within a meter) needs no conversion.
  if (/^\s*GEOGC(?:S|RS)\[/i.test(text) && /DATUM\[\s*"(?:D_)?(?:WGS_?1984|WGS 84|World Geodetic System 1984|ETRS_?1989|European Terrestrial Reference System 1989)/i.test(text)) {
    return { name, project: geographic };
  }
  try {
    return fromDefinition(text, name);
  } catch {
    return null;
  }
}
