// SPDX-License-Identifier: GPL-3.0-or-later
// Tessellates STEP, IGES and BREP files with OpenCascade (occt-import-js, LGPL-2.1) off the main thread.
import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import type { OcctBatchRequest, OcctBatchResponse, OcctFormat, OcctRequest, OcctResponse } from './occt-types';

let occt: ReturnType<typeof occtimportjs> | null = null;

type Kernel = Awaited<ReturnType<typeof occtimportjs>>;

function tessellate(kernel: Kernel, format: OcctFormat, buffer: ArrayBuffer): { response: Extract<OcctResponse, { ok: true }>; transfer: ArrayBuffer[] } {
  const result = kernel.ReadFile(format, new Uint8Array(buffer), {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.001,
    angularDeflection: 0.5,
  });
  if (!result.success) throw new Error('OpenCascade could not read the file.');

  // Typed arrays can be transferred instead of copied.
  const transfer: ArrayBuffer[] = [];
  const meshes = result.meshes.map((mesh) => {
    const position = new Float32Array(mesh.attributes.position.array);
    const normal = mesh.attributes.normal ? new Float32Array(mesh.attributes.normal.array) : null;
    const index = new Uint32Array(mesh.index.array);
    transfer.push(position.buffer, index.buffer, ...(normal ? [normal.buffer] : []));
    return { name: mesh.name, color: mesh.color ?? null, faces: mesh.brep_faces, position, normal, index };
  });
  return { response: { ok: true, root: result.root, meshes }, transfer };
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

self.onmessage = async (event: MessageEvent<OcctRequest | OcctBatchRequest>) => {
  const post = (response: OcctResponse | OcctBatchResponse, transfer: ArrayBuffer[] = []) => (self as unknown as Worker).postMessage(response, transfer);
  const request = event.data;
  try {
    occt ??= occtimportjs({ locateFile: () => wasmUrl });
    const kernel = await occt;
    post({ ok: 'progress' });
    if ('batch' in request) {
      // One answer per file as soon as it is done, so the caller can show progress; a broken file fails alone.
      request.batch.forEach(({ format, buffer }, index) => {
        try {
          const { response, transfer } = tessellate(kernel, format, buffer);
          post({ index, ...response }, transfer);
        } catch (error) {
          post({ index, ok: false, error: message(error) });
        }
      });
      post({ ok: 'done' });
      return;
    }
    const { response, transfer } = tessellate(kernel, request.format, request.buffer);
    post(response, transfer);
  } catch (error) {
    post({ ok: false, error: message(error) });
  }
};
