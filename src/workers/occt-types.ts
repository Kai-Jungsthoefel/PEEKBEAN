// SPDX-License-Identifier: GPL-3.0-or-later

export type OcctFormat = 'step' | 'iges' | 'brep';

export interface OcctRequest {
  format: OcctFormat;
  buffer: ArrayBuffer;
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
  | { ok: false; error: string }
  /** Sent once the CAD kernel is loaded and tessellation starts. */
  | { ok: 'progress' };
