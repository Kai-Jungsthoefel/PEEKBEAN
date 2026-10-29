// SPDX-License-Identifier: GPL-3.0-or-later
// Types for occt-import-js.js: OpenCascade's STEP, IGES and BREP import, built by scripts/build-occt-wasm.mjs with
// up to 4 GB of memory.

export interface OcctResult {
  success: boolean;
  root: { name: string; meshes: number[]; children: OcctResult['root'][] };
  meshes: {
    name: string;
    color?: [number, number, number];
    brep_faces: { first: number; last: number; color: [number, number, number] | null }[];
    attributes: { position: { array: number[] }; normal?: { array: number[] } };
    index: { array: number[] };
  }[];
}

export interface Occt {
  ReadFile(format: 'step' | 'iges' | 'brep', content: Uint8Array, params: Record<string, unknown> | null): OcctResult;
  /**
   * Set by the glue when the memory could not grow: "limit" when the 4 GB are used up, "refused" when the browser
   * gave no more. OpenCascade then fails without saying why. Never cleared by the module itself.
   */
  heapFull?: 'limit' | 'refused';
}

export default function occtimportjs(overrides?: { locateFile?: (path: string) => string }): Promise<Occt>;
