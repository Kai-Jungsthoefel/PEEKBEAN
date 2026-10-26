// SPDX-License-Identifier: GPL-3.0-or-later
// Tessellates STEP, IGES and BREP files with OpenCascade (occt-import-js, LGPL-2.1) off the main thread.
import occtimportjs from 'occt-import-js';
import wasmUrl from 'occt-import-js/dist/occt-import-js.wasm?url';
import type { OcctRequest, OcctResponse } from './occt-types';

let occt: ReturnType<typeof occtimportjs> | null = null;

self.onmessage = async (event: MessageEvent<OcctRequest>) => {
  const { format, buffer } = event.data;
  try {
    occt ??= occtimportjs({ locateFile: () => wasmUrl });
    const kernel = await occt;
    (self as unknown as Worker).postMessage({ ok: 'progress' } satisfies OcctResponse);
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
    const response: OcctResponse = { ok: true, root: result.root, meshes };
    (self as unknown as Worker).postMessage(response, transfer);
  } catch (error) {
    const response: OcctResponse = { ok: false, error: error instanceof Error ? error.message : String(error) };
    (self as unknown as Worker).postMessage(response);
  }
};
