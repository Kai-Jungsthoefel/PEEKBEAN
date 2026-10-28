// SPDX-License-Identifier: GPL-3.0-or-later
import * as THREE from 'three';
import { extensionOf, startsWith } from '../core/bytes';
import type { ViewerContext } from '../core/types';
import type { OcctFormat, OcctMesh, OcctNode, OcctResponse } from '../workers/occt-types';
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

function tessellate(format: OcctFormat, buffer: ArrayBuffer, progress: ViewerContext['progress']): Promise<Extract<OcctResponse, { ok: true }>> {
  const worker = new Worker(new URL('../workers/occt.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<OcctResponse>) => {
      if (event.data.ok === 'progress') {
        progress('Computing geometry …');
        return;
      }
      worker.terminate();
      if (event.data.ok) resolve(event.data);
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The CAD kernel could not be loaded.'));
    };
    worker.postMessage({ format, buffer }, [buffer]);
  });
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
  const buffer = await file.arrayBuffer();
  const format = formatOf(file, new Uint8Array(buffer, 0, Math.min(32, buffer.byteLength)));
  progress('Loading CAD kernel …');
  const { root, meshes } = await tessellate(format, buffer, progress);
  if (meshes.length === 0) throw new Error('The file contains no surfaces that can be displayed.');
  // OpenCascade delivers millimeters with Z up, like most CAD systems.
  return { object: buildNode(root, meshes), zUp: true, unit: 'mm', title: root.name || file.name };
}

export async function mount(ctx: ViewerContext) {
  const { object, zUp, unit, title } = await loadCadModel(ctx.file, ctx.progress);
  ctx.progress('Building view …');
  return mountScene(ctx, object, { zUp, unit, title });
}
