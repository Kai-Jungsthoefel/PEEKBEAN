// SPDX-License-Identifier: GPL-3.0-or-later
// 3D models to GLB, STL, OBJ, PLY or USDZ with the three.js exporters. Models are read like in the 3D view: mesh
// formats by the three.js loaders, STEP and IGES tessellated by OpenCascade.
import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { OBJExporter } from 'three/addons/exporters/OBJExporter.js';
import { PLYExporter } from 'three/addons/exporters/PLYExporter.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import { USDZExporter } from 'three/addons/exporters/USDZExporter.js';
import { loadModel } from '../../viewers/model3d';
import { loadCadModel } from '../../viewers/step';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

/** glTF, OBJ and USD are Y-up by convention; STL and PLY are used Z-up, as 3D printing and CAD expect. */
const Y_UP = new Set(['glb', 'obj', 'usdz']);

/** glTF and USDZ are in meters; the other targets keep the numbers of the source. */
const METERS: Record<string, number> = { 'µm': 1e-6, mm: 0.001, cm: 0.01, dm: 0.1, m: 1, km: 1000, in: 0.0254, ft: 0.3048, yd: 0.9144 };

const MIME: Record<string, string> = { glb: 'model/gltf-binary', stl: 'model/stl', obj: 'model/obj', ply: 'application/ply', usdz: 'model/vnd.usdz+zip' };

async function write(root: THREE.Object3D, target: string): Promise<BlobPart> {
  switch (target) {
    case 'glb':
      return (await new GLTFExporter().parseAsync(root, { binary: true })) as ArrayBuffer;
    case 'stl':
      return new STLExporter().parse(root, { binary: true }) as DataView<ArrayBuffer>;
    case 'obj':
      return new OBJExporter().parse(root);
    case 'ply':
      return new Promise<BlobPart>((resolve) => new PLYExporter().parse(root, (result) => resolve(result as ArrayBuffer), { binary: true }));
    case 'usdz':
      return (await new USDZExporter().parseAsync(root)) as Uint8Array<ArrayBuffer>;
  }
  throw new Error(`Unknown target format ${target}.`);
}

export async function convert({ file, viewer, target, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading 3D model …');
  const { object, zUp, unit } = viewer === 'step' ? await loadCadModel(file, progress) : await loadModel(file);

  let surfaces = false;
  object.traverse((o) => {
    if (o instanceof THREE.Mesh) surfaces = true;
  });
  if (!surfaces && (target === 'stl' || target === 'usdz')) {
    throw new Error(`The model has no surfaces, only points or lines, which ${target.toUpperCase()} cannot hold.`);
  }

  const root = new THREE.Group();
  root.add(object);
  if (zUp && Y_UP.has(target)) root.rotation.x = -Math.PI / 2;
  if (!zUp && !Y_UP.has(target)) root.rotation.x = Math.PI / 2;
  const notes: string[] = [];
  if ((target === 'glb' || target === 'usdz') && unit && unit !== 'm' && METERS[unit]) {
    root.scale.setScalar(METERS[unit]);
    notes.push(`Scaled from ${unit} to meters, the unit of ${target.toUpperCase()}.`);
  }
  root.updateMatrixWorld(true);

  progress(`Writing ${target.toUpperCase()} …`);
  const data = await write(root, target);
  return { files: [new File([data], resultName(file.name, target), { type: MIME[target] })], notes };
}
