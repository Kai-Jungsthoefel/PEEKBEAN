// SPDX-License-Identifier: GPL-3.0-or-later
// shpjs ships no types; only the shape reader is used (attributes come from our own dBASE reader).

declare module 'shpjs' {
  /** Shapes of a .shp file as GeoJSON geometries (null for null shapes), reprojected with proj4 if a .prj text is given. */
  export function parseShp(shp: ArrayBuffer | DataView, prj?: string): unknown[];
}
