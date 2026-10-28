// SPDX-License-Identifier: GPL-3.0-or-later
// Converts map data off the main thread: reading a large shapefile and writing its features takes a while.
import { convertMap, type MapConvertRequest, type MapConvertResult } from '../convert/map/convert';

export type MapConvertResponse =
  | { kind: 'progress'; message: string; fraction?: number }
  | ({ kind: 'done' } & MapConvertResult)
  | { kind: 'error'; error: string };

const post = (response: MapConvertResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(response, transfer);

self.onmessage = (event: MessageEvent<MapConvertRequest>) => {
  try {
    const result = convertMap(event.data, (message, fraction) => post({ kind: 'progress', message, fraction }));
    post({ kind: 'done', ...result }, result.files.map((file) => file.data.buffer as ArrayBuffer));
  } catch (error) {
    post({ kind: 'error', error: error instanceof Error ? error.message : String(error) });
  }
};
