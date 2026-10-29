// SPDX-License-Identifier: GPL-3.0-or-later
import * as THREE from 'three';
import { extensionOf, startsWith } from '../core/bytes';
import type { ViewerContext } from '../core/types';
import type { OcctFormat, OcctMesh, OcctNode, OcctResponse } from '../workers/occt-types';
import type { StepSplitRequest, StepSplitResponse } from '../workers/step-split.worker';
import type { LoadedModel } from './model3d';
import { mountScene } from './three/scene';

function formatOf(file: File, head: Uint8Array): OcctFormat {
  if (startsWith(head, 'ISO-10303-21;')) return 'step';
  if (startsWith(head, 'DBRep_DrawableShape')) return 'brep';
  const ext = extensionOf(file.name);
  if (ext === 'iges' || ext === 'igs') return 'iges';
  if (ext === 'brep' || ext === 'brp') return 'brep';
  return 'step';
}

type Tessellated = Extract<OcctResponse, { ok: true }>;

/** OpenCascade ran out of memory: at its 4 GB limit, or because the browser gave no more. */
class MemoryError extends Error {
  constructor(message: string, readonly kind: 'limit' | 'refused') {
    super(message);
  }
}

/** Reads one file in a worker of its own, which ends afterwards and so gives its memory back. */
function tessellate(format: OcctFormat, buffer: ArrayBuffer, started?: () => void): Promise<Tessellated> {
  const worker = new Worker(new URL('../workers/occt.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<OcctResponse>) => {
      const data = event.data;
      if (data.ok === 'progress') {
        started?.();
        return;
      }
      worker.terminate();
      if (data.ok) resolve(data);
      else reject(data.memory ? new MemoryError(data.error, data.memory) : new Error(data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The CAD kernel could not be loaded.'));
    };
    worker.postMessage({ format, buffer }, [buffer]);
  });
}

// ---- Large STEP files in parts -----------------------------------------------------------------------------------
// OpenCascade needs about 70 times a STEP file's size in memory and has 4 GB. Larger files are split into parts of
// about 24 MB (some 1.7 GB each), which several workers read side by side; see workers/step-split.ts.
const SPLIT_FROM = 32 * 2 ** 20;
const PART_BYTES = 24 * 2 ** 20;

function splitParts(file: Blob, partBytes: number): Promise<Blob[] | null> {
  const worker = new Worker(new URL('../workers/step-split.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<StepSplitResponse>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.parts);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The model could not be split into parts.'));
    };
    worker.postMessage({ file, partBytes } satisfies StepSplitRequest);
  });
}

/** Workers reading at once: each may take close to 2 GB, so the device's memory decides (Chrome reports up to 8). */
function workerCount(): number {
  const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency || 2;
  return Math.max(1, Math.min(memory >= 8 ? 3 : memory >= 4 ? 2 : 1, Math.floor(cores / 2)));
}

/**
 * Adds a part's result to the whole. Every part has the file's full structure, so its nodes are matched by position;
 * where the structures differ, the part's nodes are added as they are.
 */
function join(whole: Tessellated, part: Tessellated): void {
  const offset = whole.meshes.length;
  for (const mesh of part.meshes) whole.meshes.push(mesh);
  const shifted = (node: OcctNode): OcctNode => ({ ...node, meshes: node.meshes.map((m) => m + offset), children: node.children.map(shifted) });
  const merge = (into: OcctNode, from: OcctNode) => {
    for (const m of from.meshes) into.meshes.push(m + offset);
    if (into.children.length === from.children.length && into.children.every((child, i) => child.name === from.children[i].name)) {
      into.children.forEach((child, i) => merge(child, from.children[i]));
    } else {
      into.children.push(...from.children.map(shifted));
    }
  };
  merge(whole.root, part.root);
}

/** Reads a STEP file in parts; null when it cannot be split. */
async function readInParts(file: Blob, partBytes: number, progress: ViewerContext['progress']): Promise<Tessellated | null> {
  progress('Splitting the model into parts …');
  const parts = await splitParts(file, partBytes);
  if (!parts) return null;
  const queue = [...parts];
  // Parts the browser had no memory for are read again at the end, one at a time.
  const refused: Blob[] = [];
  let total = parts.length;
  let done = 0;
  let whole: Tessellated | null = null;
  const show = () => progress(`Reading part ${Math.min(done + 1, total)} of ${total} …`, done / total);

  const read = async (part: Blob, alone: boolean): Promise<void> => {
    try {
      const result = await tessellate('step', await part.arrayBuffer());
      if (whole) join(whole, result);
      else whole = result;
      done++;
      show();
    } catch (error) {
      if (!(error instanceof MemoryError)) throw error;
      if (error.kind === 'refused' && !alone) {
        refused.push(part);
        return;
      }
      // Still too large: smaller parts, as long as the part has more than one solid.
      const smaller = error.kind === 'limit' ? await splitParts(part, Math.max(2 ** 20, part.size / 3)) : null;
      if (!smaller) throw error;
      total += smaller.length - 1;
      queue.push(...smaller);
      show();
    }
  };

  show();
  const reader = async (alone: boolean) => {
    for (let part = queue.shift(); part; part = queue.shift()) await read(part, alone);
  };
  await Promise.all(Array.from({ length: Math.min(workerCount(), queue.length) }, () => reader(false)));
  queue.push(...refused);
  await reader(true);
  return whole;
}

// Linear RGB of a neutral steel blue (#98a4b3).
const DEFAULT_COLOR: [number, number, number] = [0.32, 0.37, 0.45];

function material(color: [number, number, number]): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    // OpenCascade hands out linear RGB, which is three.js's working color space.
    color: new THREE.Color().setRGB(...color),
    metalness: 0.1,
    roughness: 0.5,
    side: THREE.DoubleSide,
    // Pushes faces back a little so the edge lines stay visible on top.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

function buildMesh(data: OcctMesh): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  if (data.normal) geometry.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
  else geometry.computeVertexNormals();
  geometry.setIndex(new THREE.BufferAttribute(data.index, 1));

  const base = data.color ?? DEFAULT_COLOR;
  const faceColors = data.faces.filter((f) => f.color);
  if (faceColors.length === 0) return new THREE.Mesh(geometry, material(base));

  // Faces with their own color become material groups.
  const materials: THREE.Material[] = [material(base)];
  const byColor = new Map<string, number>();
  for (const face of data.faces) {
    let index = 0;
    if (face.color) {
      const key = face.color.join(',');
      if (!byColor.has(key)) {
        byColor.set(key, materials.length);
        materials.push(material(face.color));
      }
      index = byColor.get(key)!;
    }
    geometry.addGroup(face.first * 3, (face.last - face.first + 1) * 3, index);
  }
  return new THREE.Mesh(geometry, materials);
}

function buildNode(node: OcctNode, meshes: OcctMesh[]): THREE.Object3D {
  const group = new THREE.Group();
  group.name = node.name;
  for (const index of node.meshes) {
    const mesh = buildMesh(meshes[index]);
    mesh.name = meshes[index].name;
    group.add(mesh);
  }
  for (const child of node.children) group.add(buildNode(child, meshes));
  return group;
}

/** The model tessellated by OpenCascade, as three.js objects; the converter uses this too. */
export async function loadCadModel(file: File, progress: ViewerContext['progress']): Promise<LoadedModel & { title: string }> {
  const format = formatOf(file, new Uint8Array(await file.slice(0, 32).arrayBuffer()));
  progress('Loading CAD kernel …');
  let result: Tessellated | null = null;
  if (format === 'step' && file.size >= SPLIT_FROM) result = await readInParts(file, PART_BYTES, progress);
  if (!result) {
    try {
      result = await tessellate(format, await file.arrayBuffer(), () => progress('Computing geometry …'));
    } catch (error) {
      // Smaller files can need more than 4 GB too, with many curved faces.
      if (!(format === 'step' && error instanceof MemoryError && error.kind === 'limit')) throw error;
      result = await readInParts(file, Math.max(2 ** 20, file.size / 4), progress);
      if (!result) throw error;
    }
  }
  const { root, meshes } = result;
  if (meshes.length === 0) throw new Error('The file contains no surfaces that can be displayed.');
  // OpenCascade delivers millimeters with Z up, like most CAD systems.
  return { object: buildNode(root, meshes), zUp: true, unit: 'mm', title: root.name || file.name };
}

export async function mount(ctx: ViewerContext) {
  const { object, zUp, unit, title } = await loadCadModel(ctx.file, ctx.progress);
  ctx.progress('Building view …');
  return mountScene(ctx, object, { zUp, unit, title });
}
