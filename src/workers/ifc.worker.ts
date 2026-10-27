// SPDX-License-Identifier: GPL-3.0-or-later
// Reads IFC building models with web-ifc (MPL-2.0, WebAssembly) off the main thread. The model stays open after
// loading, so the properties of a selected element can be looked up.
import { IfcAPI, LogLevel } from 'web-ifc';
import wasmUrl from 'web-ifc/web-ifc.wasm?url';
import { IfcReader } from './ifc-reader';
import type { IfcRequest, IfcResponse } from './ifc-types';

const post = (response: IfcResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(response, transfer);
let reader: IfcReader | null = null;

async function open(buffer: ArrayBuffer): Promise<void> {
  const api = new IfcAPI();
  // The single-threaded build: the other one needs SharedArrayBuffer, i.e. a cross-origin isolated page.
  await api.Init(() => wasmUrl, true);
  // Geometry the kernel cannot build is skipped; its log lines would only fill the console.
  api.SetLogLevel(LogLevel.LOG_LEVEL_OFF);
  post({ ok: 'progress', message: 'Reading the file …' });
  const model = api.OpenModel(new Uint8Array(buffer));
  if (model < 0 || !api.IsModelOpen(model)) throw new Error('web-ifc could not open this file; its IFC schema may not be supported.');
  reader = new IfcReader(api, model);
  const result = reader.readModel((message, fraction) => post({ ok: 'progress', message, fraction }));
  post({ ok: true, kind: 'model', model: result.model }, result.transfer);
}

self.onmessage = async (event: MessageEvent<IfcRequest>) => {
  const request = event.data;
  if (request.kind === 'open') {
    try {
      await open(request.buffer);
    } catch (error) {
      post({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  try {
    if (!reader) throw new Error('No model is open.');
    post({ ok: true, kind: 'properties', token: request.token, properties: reader.properties(request.id) });
  } catch (error) {
    post({ ok: false, token: request.token, error: error instanceof Error ? error.message : String(error) });
  }
};
