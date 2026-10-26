// SPDX-License-Identifier: GPL-3.0-or-later
import * as THREE from 'three';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { extensionOf, startsWith } from '../core/bytes';
import type { ViewerContext } from '../core/types';
import { mountScene } from './three/scene';

interface LoadedModel {
  object: THREE.Object3D;
  zUp: boolean;
}

function defaultMaterial(vertexColors: boolean): THREE.Material {
  // Double-sided because STL exports frequently have inconsistent winding.
  return new THREE.MeshStandardMaterial({
    color: vertexColors ? 0xffffff : 0x98a4b3,
    metalness: 0.05,
    roughness: 0.55,
    side: THREE.DoubleSide,
    vertexColors,
  });
}

function fromGeometry(geometry: THREE.BufferGeometry, isPointCloud = false): THREE.Object3D {
  const hasColors = geometry.hasAttribute('color');
  if (isPointCloud) {
    return new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0, sizeAttenuation: false, vertexColors: hasColors }));
  }
  if (!geometry.hasAttribute('normal')) geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, defaultMaterial(hasColors));
}

/** Embedded .gltf files work; ones that reference sibling .bin or texture files cannot be resolved from a single file. */
function assertSelfContainedGltf(buffer: ArrayBuffer): void {
  const json = JSON.parse(new TextDecoder().decode(buffer)) as { buffers?: { uri?: string }[]; images?: { uri?: string }[] };
  const external = [...(json.buffers ?? []), ...(json.images ?? [])].some((r) => r.uri && !r.uri.startsWith('data:'));
  if (external) {
    throw new Error('This .gltf file refers to external files (.bin, textures). Please export it as .glb.');
  }
}

async function loadModel(file: File): Promise<LoadedModel> {
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength));
  const ext = extensionOf(file.name);

  if (ext === 'glb' || ext === 'gltf' || startsWith(head, 'glTF')) {
    if (!startsWith(head, 'glTF')) assertSelfContainedGltf(buffer);
    try {
      const gltf = await new GLTFLoader().parseAsync(buffer, '');
      return { object: gltf.scene, zUp: false };
    } catch (error) {
      if (/draco|meshopt|ktx2/i.test(String(error))) {
        throw new Error('Compressed glTF files (Draco, Meshopt, KTX2) are not supported yet.');
      }
      throw error;
    }
  }
  if (ext === 'ply' || startsWith(head, 'ply')) {
    const geometry = new PLYLoader().parse(buffer);
    return { object: fromGeometry(geometry, geometry.index === null), zUp: true };
  }
  switch (ext) {
    case 'stl': {
      const geometry = new STLLoader().parse(buffer);
      // Many exporters write zero normals; recomputing gives correct flat shading either way.
      geometry.computeVertexNormals();
      return { object: fromGeometry(geometry), zUp: true };
    }
    case 'obj':
      return { object: new OBJLoader().parse(new TextDecoder().decode(buffer)), zUp: false };
    case '3mf':
      return { object: new ThreeMFLoader().parse(buffer), zUp: true };
  }
  throw new Error('The 3D format could not be recognized.');
}

export async function mount(ctx: ViewerContext) {
  ctx.progress('Reading 3D model …');
  const { object, zUp } = await loadModel(ctx.file);
  ctx.progress('Building view …');
  return mountScene(ctx, object, { zUp, title: ctx.file.name });
}
