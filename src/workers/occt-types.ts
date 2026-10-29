// SPDX-License-Identifier: GPL-3.0-or-later

export type OcctFormat = 'step' | 'iges' | 'brep';

export interface OcctRequest {
  format: OcctFormat;
  buffer: ArrayBuffer;
}

/** Several files through one kernel instance, e.g. the shapes of a FreeCAD document. */
export interface OcctBatchRequest {
  batch: OcctRequest[];
}

export interface OcctNode {
  name: string;
  meshes: number[];
  children: OcctNode[];
}

export interface OcctMesh {
  name: string;
  color: [number, number, number] | null;
  /** Triangle ranges of the original B-rep faces, each with an optional own color. */
  faces: { first: number; last: number; color: [number, number, number] | null }[];
  position: Float32Array;
  normal: Float32Array | null;
  index: Uint32Array;
}

export type OcctResponse =
  | { ok: true; root: OcctNode; meshes: OcctMesh[] }
  /** `memory` when OpenCascade ran out of memory: at the 4 GB limit, or because the browser gave no more. */
  | { ok: false; error: string; memory?: 'limit' | 'refused' }
  /** Sent once the CAD kernel is loaded and tessellation starts. */
  | { ok: 'progress' };

/** Answers to a batch request: progress, one result per file in request order, then 'done'. */
export type OcctBatchResponse =
  | { ok: 'progress' }
  | ({ index: number } & Exclude<OcctResponse, { ok: 'progress' }>)
  | { ok: 'done' };
