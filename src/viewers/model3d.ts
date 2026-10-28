// SPDX-License-Identifier: GPL-3.0-or-later
// Mesh, scene and point-cloud formats via the three.js loaders (MIT); Rhino .3dm via rhino3dm (MIT, WebAssembly).
import * as THREE from 'three';
import { Rhino3dmLoader } from 'three/addons/loaders/3DMLoader.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { AMFLoader } from 'three/addons/loaders/AMFLoader.js';
import { ColladaLoader } from 'three/addons/loaders/ColladaLoader.js';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PCDLoader } from 'three/addons/loaders/PCDLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { TDSLoader } from 'three/addons/loaders/TDSLoader.js';
import { USDLoader } from 'three/addons/loaders/USDLoader.js';
import { VOXLoader, buildMesh } from 'three/addons/loaders/VOXLoader.js';
import { VRMLLoader } from 'three/addons/loaders/VRMLLoader.js';
import { VTKLoader } from 'three/addons/loaders/VTKLoader.js';
import { XYZLoader } from 'three/addons/loaders/XYZLoader.js';
import { extensionOf, startsWith } from '../core/bytes';
import type { ViewerContext } from '../core/types';
import { mountScene } from './three/scene';
import { expandSimpleProtos, isVrml1, parseVrml1 } from './three/vrml1';

interface LoadedModel {
  object: THREE.Object3D;
  zUp: boolean;
  unit?: string;
}

/** White 1×1 pixel: stands in for textures that live next to the model and are not part of the opened file. */
const NO_TEXTURE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGP4DwABAQEAsTj2FAAAAABJRU5ErkJggg==';

/**
 * Loaders must never fetch files a model refers to: they cannot be resolved, and nothing may leave the browser.
 * `ownFiles` lets a loader fetch its own runtime served next to the page (the Rhino reader).
 */
function offlineManager(ownFiles?: string): THREE.LoadingManager {
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => (/^(data|blob):/.test(url) || (ownFiles && url.startsWith(ownFiles)) ? url : NO_TEXTURE));
  return manager;
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
    // Two screen pixels per point: visible at any zoom, dense clouds still read as surfaces.
    return new THREE.Points(geometry, new THREE.PointsMaterial({ color: hasColors ? 0xffffff : 0x5d6a7a, size: 2, sizeAttenuation: false, vertexColors: hasColors }));
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

async function gunzip(buffer: ArrayBuffer): Promise<ArrayBuffer> {
  return new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

/** Object File Format (Geomview): vertex and face counts, then vertices, then polygons as index lists. */
function parseOff(text: string): THREE.BufferGeometry {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/#.*/, '').trim()).filter(Boolean).map((l) => l.split(/\s+/));
  const first = lines.shift() ?? [];
  const header = first.shift() ?? '';
  if (!/^[CN]*OFF$/.test(header)) throw new Error('This is not an OFF file.');
  const colors = header.includes('C');
  const normals = header.includes('N');
  // The counts follow the keyword, on the same line or the next.
  const [vertexCount, faceCount] = (first.length >= 2 ? first : (lines.shift() ?? [])).map(Number);
  const position = new Float32Array(vertexCount * 3);
  const color = colors ? new Float32Array(vertexCount * 3) : null;
  for (let i = 0; i < vertexCount; i++) {
    const v = (lines[i] ?? []).map(Number);
    position.set(v.slice(0, 3), i * 3);
    if (color) {
      const rgb = v.slice(normals ? 6 : 3, normals ? 9 : 6);
      const scale = rgb.some((c) => c > 1) ? 255 : 1;
      color.set(rgb.map((c) => c / scale), i * 3);
    }
  }
  const index: number[] = [];
  for (const face of lines.slice(vertexCount, vertexCount + faceCount)) {
    // A face is its corner count and the corners; an optional face color may follow.
    const corners = face.slice(1, 1 + Number(face[0])).map(Number);
    for (let k = 1; k + 1 < corners.length; k++) index.push(corners[0], corners[k], corners[k + 1]);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  if (color) geometry.setAttribute('color', new THREE.BufferAttribute(color, 3));
  geometry.setIndex(index);
  return geometry;
}

interface DotBim {
  meshes: { mesh_id: number; coordinates: number[]; indices: number[] }[];
  elements: {
    mesh_id: number;
    vector: { x: number; y: number; z: number };
    rotation: { qx: number; qy: number; qz: number; qw: number };
    color: { r: number; g: number; b: number; a: number };
    type?: string;
    info?: Record<string, string>;
  }[];
}

/** dotbim: shared meshes placed as elements with position, rotation and color, all in meters, Z up. */
function parseDotBim(text: string): THREE.Object3D {
  const bim = JSON.parse(text) as DotBim;
  const geometries = new Map<number, THREE.BufferGeometry>();
  for (const m of bim.meshes ?? []) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(m.coordinates, 3));
    geometry.setIndex(m.indices);
    // Flat faces, as BIM elements are mostly boxes and plates.
    geometries.set(m.mesh_id, geometry.toNonIndexed());
    geometries.get(m.mesh_id)!.computeVertexNormals();
  }
  const group = new THREE.Group();
  const counts = new Map<string, number>();
  for (const e of bim.elements ?? []) {
    const geometry = geometries.get(e.mesh_id);
    if (!geometry) continue;
    const material = defaultMaterial(false) as THREE.MeshStandardMaterial;
    material.color.setRGB(e.color.r / 255, e.color.g / 255, e.color.b / 255, THREE.SRGBColorSpace);
    if (e.color.a < 255) Object.assign(material, { transparent: true, opacity: e.color.a / 255 });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(e.vector.x, e.vector.y, e.vector.z);
    mesh.quaternion.set(e.rotation.qx, e.rotation.qy, e.rotation.qz, e.rotation.qw);
    const type = e.type ?? 'Element';
    const n = (counts.get(type) ?? 0) + 1;
    counts.set(type, n);
    mesh.name = e.info?.Name ?? e.info?.name ?? `${type} ${n}`;
    group.add(mesh);
  }
  return group;
}

/** Rhino unit systems (ON::LengthUnitSystem) as shown next to dimensions. */
const RHINO_UNITS: Record<number, string> = { 1: 'µm', 2: 'mm', 3: 'cm', 4: 'm', 5: 'km', 8: 'in', 9: 'ft', 14: 'dm', 19: 'yd' };

async function loadRhino(buffer: ArrayBuffer): Promise<LoadedModel> {
  // Served next to the page (see vite.config.ts), patched so it runs under our Content Security Policy.
  const libraryPath = new URL('rhino3dm/', document.baseURI).href;
  const loader = new Rhino3dmLoader(offlineManager(libraryPath));
  loader.setLibraryPath(libraryPath);
  loader.setWorkerLimit(1);
  try {
    // The loader does not report a worker that fails to start; give up instead of loading forever.
    const object = await new Promise<THREE.Object3D>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('The Rhino reader did not respond. Reload the page and try again.')), 60_000);
      loader.parse(buffer, (o: THREE.Object3D) => {
        clearTimeout(timer);
        resolve(o);
      }, (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
    // Without render materials the loader paints meshes in a shiny white; Rhino shows them in their display color
    // (from the layer or the object), so that is used instead.
    object.traverse((o) => {
      const color = (o.userData.attributes as { drawColor?: { r: number; g: number; b: number } } | undefined)?.drawColor;
      if (!(o instanceof THREE.Mesh) || !color || Array.isArray(o.material) || o.material.name !== THREE.Loader.DEFAULT_MATERIAL_NAME) return;
      o.material.dispose();
      const material = defaultMaterial(false) as THREE.MeshStandardMaterial;
      material.color.setRGB(color.r / 255, color.g / 255, color.b / 255, THREE.SRGBColorSpace);
      o.material = material;
    });
    const units = (object.userData.settings as { modelUnitSystem?: { value?: number } } | undefined)?.modelUnitSystem?.value;
    return { object, zUp: true, unit: units === undefined ? undefined : RHINO_UNITS[units] };
  } finally {
    loader.dispose();
  }
}

async function loadModel(file: File): Promise<LoadedModel> {
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer, 0, Math.min(16, buffer.byteLength));
  const ext = extensionOf(file.name);
  const text = () => new TextDecoder().decode(buffer);

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
      return { object: new OBJLoader().parse(text()), zUp: false };
    case '3mf':
      return { object: new ThreeMFLoader().parse(buffer), zUp: true };
    case 'fbx':
      return { object: new FBXLoader(offlineManager()).parse(buffer, ''), zUp: false };
    case 'dae': {
      // The loader turns Z-up files upright and scales to meters itself.
      const collada = new ColladaLoader(offlineManager()).parse(text(), '');
      if (!collada) throw new Error('The COLLADA file could not be read.');
      return { object: collada.scene, zUp: false, unit: 'm' };
    }
    case '3ds':
      return { object: new TDSLoader(offlineManager()).parse(buffer, ''), zUp: true };
    case 'amf':
      return { object: new AMFLoader().parse(buffer), zUp: true };
    case 'wrl':
    case 'vrml':
    case 'wrz': {
      const source = ext === 'wrz' ? new TextDecoder().decode(await gunzip(buffer)) : text();
      // three.js reads VRML 2.0 (VRML97) only; CAD systems still write 1.0.
      if (isVrml1(source)) return { object: parseVrml1(source), zUp: false };
      return { object: new VRMLLoader(offlineManager()).parse(expandSimpleProtos(source), ''), zUp: false };
    }
    case 'vtk':
    case 'vtp':
      return { object: fromGeometry(new VTKLoader().parse(buffer, '')), zUp: true };
    case 'usd':
    case 'usda':
    case 'usdc':
    case 'usdz':
      // Z-up stages are turned upright by the loader.
      return { object: new USDLoader(offlineManager()).parse(buffer, ''), zUp: false };
    case 'pcd':
      return { object: fromGeometry(new PCDLoader().parse(buffer).geometry, true), zUp: true };
    case 'xyz': {
      // The type declarations still describe an older callback form; parse() returns the geometry.
      const loader = new XYZLoader() as unknown as { parse(text: string): THREE.BufferGeometry };
      return { object: fromGeometry(loader.parse(text()), true), zUp: true };
    }
    case 'vox': {
      const result = new VOXLoader().parse(buffer) as { chunks: Parameters<typeof buildMesh>[0][]; scene: THREE.Object3D | null } | undefined;
      if (!result) throw new Error('This is not a MagicaVoxel file, or its version is not supported.');
      if (result.scene) return { object: result.scene, zUp: false };
      const group = new THREE.Group();
      for (const chunk of result.chunks) group.add(buildMesh(chunk));
      return { object: group, zUp: false };
    }
    case 'off':
      return { object: fromGeometry(parseOff(text())), zUp: false };
    case 'bim':
      return { object: parseDotBim(text()), zUp: true, unit: 'm' };
    case '3dm':
      return loadRhino(buffer);
  }
  throw new Error('The 3D format could not be recognized.');
}

export async function mount(ctx: ViewerContext) {
  ctx.progress(extensionOf(ctx.file.name) === '3dm' ? 'Loading the Rhino reader …' : 'Reading 3D model …');
  const { object, zUp, unit } = await loadModel(ctx.file);
  ctx.progress('Building view …');
  return mountScene(ctx, object, { zUp, unit, title: ctx.file.name });
}
