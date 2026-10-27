// SPDX-License-Identifier: GPL-3.0-or-later
// Reads shapefiles, GeoJSON and TopoJSON off the main thread; country outlines or road networks run to millions of points.
import { buffersOf } from '../viewers/map/model';
import { readVector, type VectorRequest, type VectorResult } from '../viewers/map/vector';

export type MapResponse = ({ ok: true } & VectorResult) | { ok: false; error: string };

self.onmessage = (event: MessageEvent<VectorRequest>) => {
  try {
    const result = readVector(event.data);
    (self as unknown as Worker).postMessage({ ok: true, ...result } satisfies MapResponse, result.layers.flatMap(buffersOf));
  } catch (error) {
    (self as unknown as Worker).postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) } satisfies MapResponse);
  }
};
