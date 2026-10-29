// SPDX-License-Identifier: GPL-3.0-or-later
// Tessellates STEP, IGES and BREP files with OpenCascade (occt-import-js, LGPL-2.1) off the main thread. The module
// is built by scripts/build-occt-wasm.mjs, with up to 4 GB of memory instead of the npm release's 2 GB.
import occtimportjs, { type Occt } from '../wasm/occt/occt-import-js.js';
import wasmUrl from '../wasm/occt/occt-import-js.wasm?url';
import type { OcctBatchRequest, OcctBatchResponse, OcctFormat, OcctRequest, OcctResponse } from './occt-types';

let occt: Promise<Occt> | null = null;

// OpenCascade needs many times the file's size in memory; a large STEP file can use up all of it. It catches the
// failed allocation itself, so without these the model would just fail to read or come out with faces missing.
const MEMORY_ERRORS = {
  limit: 'The model needs more memory than the CAD kernel has in the browser (4 GB). Exported from the CAD program as STL, glTF or 3MF, it can be shown here.',
  refused: 'The browser gave the CAD kernel no more memory. Close other tabs or reload the page and try again.',
};

class MemoryError extends Error {
  constructor(readonly kind: 'limit' | 'refused') {
    super(MEMORY_ERRORS[kind]);
  }
}

function tessellate(kernel: Occt, format: OcctFormat, buffer: ArrayBuffer): { response: Extract<OcctResponse, { ok: true }>; transfer: ArrayBuffer[] } {
  kernel.heapFull = undefined;
  const result = kernel.ReadFile(format, new Uint8Array(buffer), {
    linearUnit: 'millimeter',
    linearDeflectionType: 'bounding_box_ratio',
    linearDeflection: 0.001,
    angularDeflection: 0.5,
  });
  if (kernel.heapFull) throw new MemoryError(kernel.heapFull);
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

const failure = (error: unknown) => ({
  ok: false as const,
  error: error instanceof Error ? error.message : String(error),
  ...(error instanceof MemoryError ? { memory: error.kind } : {}),
});

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
          post({ index, ...failure(error) });
        }
      });
      post({ ok: 'done' });
      return;
    }
    const { response, transfer } = tessellate(kernel, request.format, request.buffer);
    post(response, transfer);
  } catch (error) {
    post(failure(error));
  }
};
