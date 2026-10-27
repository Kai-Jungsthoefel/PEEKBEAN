// SPDX-License-Identifier: GPL-3.0-or-later

export type IfcRequest =
  | { kind: 'open'; buffer: ArrayBuffer }
  /** Properties of one product; `token` comes back with the answer. */
  | { kind: 'properties'; id: number; token: number };

/**
 * Spatial structure: project, site, building, storeys (spatial), the elements of one IFC class within a storey
 * (group), elements and their parts (element). Products are numbered in tree order, so every subtree covers a
 * contiguous range of element numbers.
 */
export interface IfcTreeNode {
  kind: 'spatial' | 'group' | 'element';
  /** Express ID; 0 for groups. */
  id: number;
  /** IFC class, e.g. IfcWall; for a group the class of its elements. */
  ifcClass: string;
  name: string;
  children: IfcTreeNode[];
  /** The products in this subtree, itself included, are the elements first … first + count − 1. */
  first: number;
  count: number;
}

/** sRGB 0–1 and opacity, as the file's surface styles give them. */
export interface IfcMaterial {
  color: [number, number, number];
  opacity: number;
}

/** Merged geometry of the elements of one class in one storey, for few draw calls. */
export interface IfcBucket {
  name: string;
  /** Position of the mesh in file coordinates; vertices are relative to it, which keeps float32 exact far from the origin. */
  origin: [number, number, number];
  position: Float32Array;
  normal: Float32Array;
  index: Uint32Array;
  /** Per material: first index, index count, material number. */
  groups: Uint32Array;
  /** Per piece of an element, in index order: element number, first index, index count. */
  chunks: Uint32Array;
  /** Feature edges as line segments (pairs of vertices), relative to `origin` like the faces. */
  edges: Float32Array;
  /** Per element: element number, first edge vertex, vertex count. */
  edgeChunks: Uint32Array;
}

export interface IfcModel {
  /** IFC2X3, IFC4, IFC4X3 … */
  schema: string;
  /** Program that wrote the file, if it says. */
  application: string;
  /** Unit of the coordinates: mm for metric files, ft or in for imperial ones. */
  unit: string;
  root: IfcTreeNode;
  /** Express ID of each element, in tree order. */
  ids: Uint32Array;
  /** IFC class of each element, as an index into `classes`. */
  classOf: Uint16Array;
  classes: string[];
  /** Bounding box of each element in file coordinates (min x, y, z, max x, y, z); NaN without geometry. */
  boxes: Float64Array;
  materials: IfcMaterial[];
  buckets: IfcBucket[];
}

/** A titled list of label / value pairs: attributes, a property set, quantities, materials. */
export interface IfcPropertySection {
  title: string;
  rows: [string, string][];
}

export interface IfcProperties {
  id: number;
  name: string;
  ifcClass: string;
  sections: IfcPropertySection[];
}

export type IfcResponse =
  | { ok: 'progress'; message: string; fraction?: number }
  | { ok: true; kind: 'model'; model: IfcModel }
  | { ok: true; kind: 'properties'; token: number; properties: IfcProperties }
  | { ok: false; error: string; token?: number };
