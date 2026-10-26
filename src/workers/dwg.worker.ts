// SPDX-License-Identifier: GPL-3.0-or-later
// Converts DWG to DXF with acadrust (MPL-2.0), compiled to WebAssembly from crates/dwg2dxf. The drawing stays open
// here, so switching between model space and layouts does not read the file again. The viewer starts a fresh
// worker per file and ends it when the tab closes; a reader crash never leaves a broken module behind.
import init, { DwgDrawing } from '../wasm/dwg2dxf/dwg2dxf.js';
import wasmUrl from '../wasm/dwg2dxf/dwg2dxf_bg.wasm?url';

export type DwgRequest = { kind: 'open'; buffer: ArrayBuffer } | { kind: 'model' } | { kind: 'layout'; index: number };

export type DwgResponse =
  | { ok: true; kind: 'open'; release: string; layouts: string[]; warnings: string[]; details: string[]; recovered: boolean; dxf: Uint8Array }
  | { ok: true; kind: 'dxf'; dxf: Uint8Array }
  | { ok: false; error: string };

let drawing: DwgDrawing | null = null;

const post = (response: DwgResponse, transfer: Transferable[] = []) => (self as unknown as Worker).postMessage(response, transfer);

self.onmessage = async (event: MessageEvent<DwgRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'open') {
      await init({ module_or_path: wasmUrl });
      drawing = DwgDrawing.open(new Uint8Array(request.buffer));
      const dxf = drawing.modelDxf();
      post(
        { ok: true, kind: 'open', release: drawing.release, layouts: drawing.layouts(), warnings: drawing.warnings, details: drawing.details, recovered: drawing.recovered, dxf },
        [dxf.buffer as ArrayBuffer],
      );
      return;
    }
    if (!drawing) throw new Error('The drawing is not open.');
    const dxf = request.kind === 'model' ? drawing.modelDxf() : drawing.layoutDxf(request.index);
    post({ ok: true, kind: 'dxf', dxf }, [dxf.buffer as ArrayBuffer]);
  } catch (error) {
    const crashed = error instanceof Error && error.name === 'DwgReaderCrash';
    const message = error instanceof Error ? error.message : String(error);
    post({ ok: false, error: crashed ? `The DWG reader failed at one point in the file (${message}).` : message });
  }
};
