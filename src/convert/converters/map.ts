// SPDX-License-Identifier: GPL-3.0-or-later
// Map data (shapefiles, KML, KMZ, GPX, TCX, GeoJSON, TopoJSON) to GeoJSON, KML, GPX, CSV or zipped shapefiles. The
// file is opened as the map viewer opens it; KML, GPX and TCX are read here, as they need the browser's XML parser,
// and the rest is read and written in the worker (src/convert/map/).
import type { MapConvertRequest, MapTarget } from '../map/convert';
import { readSources } from '../map/source';
import { baseName, zipFiles } from '../files';
import type { ConvertContext, ConvertResult } from '../types';
import type { MapConvertResponse } from '../../workers/map-convert.worker';

export async function convert({ file, target, options, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading map data …');
  const sources = await readSources(file, (message) => progress(message));
  // "roads.shp.zip" gives "roads.geojson".
  const name = baseName(file.name).replace(/\.shp$/i, '') || 'map';
  const request: MapConvertRequest = {
    ...sources,
    target: target as MapTarget,
    name,
    separator: options.separator ?? ',',
    bom: options.encoding !== 'plain',
  };
  const transfer = [...sources.shapefiles.flatMap((s) => (s.dbf ? [s.shp, s.dbf] : [s.shp])), ...sources.json.map((j) => j.data)];
  const worker = new Worker(new URL('../../workers/map-convert.worker.ts', import.meta.url), { type: 'module' });
  const result = await new Promise<Extract<MapConvertResponse, { kind: 'done' }>>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<MapConvertResponse>) => {
      const response = event.data;
      if (response.kind === 'progress') progress(response.message, response.fraction);
      else if (response.kind === 'done') resolve(response);
      else reject(new Error(response.error));
    };
    worker.onerror = (event) => reject(new Error(event.message || 'The map converter could not be loaded.'));
    worker.postMessage(request, transfer);
  }).finally(() => worker.terminate());

  const files = result.files.map((f) => new File([f.data as Uint8Array<ArrayBuffer>], f.name, { type: f.type }));
  if (target !== 'shp') return { files, notes: result.notes };
  progress('Packing ZIP …');
  // ".shp.zip": GDAL and QGIS open such a ZIP directly as shapefiles, and it does not clash with a source ZIP's name.
  return { files: [await zipFiles(files, `${name}.shp.zip`)], notes: result.notes };
}
