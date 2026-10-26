// SPDX-License-Identifier: GPL-3.0-or-later
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { ThreeMFLoader } from 'three/addons/loaders/3MFLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js';
import { PLYLoader } from 'three/addons/loaders/PLYLoader.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { extensionOf, startsWith } from '../core/bytes';
import { h, setPressed, toolButton } from '../core/dom';
import type { ViewerContext } from '../core/types';

interface LoadedModel {
  object: THREE.Object3D;
  /** CAD and 3D-printing formats are usually Z-up, three.js is Y-up. */
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
    throw new Error('Diese .gltf-Datei verweist auf externe Dateien (.bin, Texturen). Bitte die Datei als .glb exportieren.');
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
        throw new Error('Komprimierte glTF-Dateien (Draco, Meshopt, KTX2) werden noch nicht unterstützt.');
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
  throw new Error('Das 3D-Format konnte nicht erkannt werden.');
}

function countTriangles(root: THREE.Object3D): number {
  let triangles = 0;
  root.traverse((node) => {
    if (node instanceof THREE.Mesh) {
      const geometry = node.geometry as THREE.BufferGeometry;
      triangles += (geometry.index?.count ?? geometry.getAttribute('position')?.count ?? 0) / 3;
    }
  });
  return Math.round(triangles);
}

function materialsOf(node: THREE.Object3D): THREE.Material[] {
  if (!(node instanceof THREE.Mesh || node instanceof THREE.Points || node instanceof THREE.Line)) return [];
  return Array.isArray(node.material) ? node.material : [node.material];
}

function disposeTree(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (node instanceof THREE.Mesh || node instanceof THREE.Points || node instanceof THREE.Line) node.geometry.dispose();
    for (const material of materialsOf(node)) {
      for (const value of Object.values(material)) {
        if (value instanceof THREE.Texture) value.dispose();
      }
      material.dispose();
    }
  });
}

const formatNumber = (n: number) => n.toLocaleString('de-DE', { maximumFractionDigits: 2 });

export async function mount({ file, container, toolbar }: ViewerContext) {
  const { object, zUp } = await loadModel(file);

  const fileBox = new THREE.Box3().setFromObject(object);
  if (fileBox.isEmpty()) {
    disposeTree(object);
    throw new Error('Die Datei enthält keine darstellbare Geometrie.');
  }
  const fileSize = fileBox.getSize(new THREE.Vector3());

  const model = new THREE.Group();
  model.add(object);
  if (zUp) object.rotation.x = -Math.PI / 2;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  const size = box.getSize(new THREE.Vector3());
  model.position.sub(box.getCenter(new THREE.Vector3()));

  const styles = getComputedStyle(container);
  // Transparent canvas: the viewport gradient comes from CSS, as in SOMA.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const canvas = renderer.domElement;
  canvas.classList.add('model-canvas');
  container.append(canvas);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;
  scene.environmentIntensity = 0.6;
  scene.add(model);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  const headlight = new THREE.DirectionalLight(0xffffff, 0.9);
  headlight.position.set(1, 1, 2);
  camera.add(headlight);
  scene.add(camera);

  const extent = Math.max(size.x, size.z);
  const grid = new THREE.GridHelper(
    extent * 2,
    20,
    styles.getPropertyValue('--grid-major').trim() || '#aab2bc',
    styles.getPropertyValue('--grid-minor').trim() || '#d5d9df',
  );
  grid.position.y = -size.y / 2;
  scene.add(grid);

  const controls = new OrbitControls(camera, canvas);
  controls.screenSpacePanning = true;

  let frame = 0;
  const requestRender = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      renderer.render(scene, camera);
    });
  };
  controls.addEventListener('change', requestRender);

  function resetView(): void {
    const radius = size.length() / 2 || 1;
    const distance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
    camera.position.copy(new THREE.Vector3(1, 0.75, 1.25).normalize().multiplyScalar(distance));
    camera.near = distance / 1000;
    camera.far = distance * 100;
    camera.updateProjectionMatrix();
    controls.target.set(0, 0, 0);
    controls.update();
    requestRender();
  }

  const resizeObserver = new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: hgt } = container;
    if (w === 0 || hgt === 0) return;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
    requestRender();
  });
  resizeObserver.observe(container);

  let wireframe = false;
  const wireButton = toolButton('Drahtgitter', 'Drahtgitter umschalten', () => {
    wireframe = !wireframe;
    setPressed(wireButton, wireframe);
    object.traverse((node) => {
      for (const material of materialsOf(node)) {
        if ('wireframe' in material) (material as THREE.MeshStandardMaterial).wireframe = wireframe;
      }
    });
    requestRender();
  });
  const gridButton = toolButton('Raster', 'Bodenraster umschalten', () => {
    grid.visible = !grid.visible;
    setPressed(gridButton, grid.visible);
    requestRender();
  });
  setPressed(wireButton, false);
  setPressed(gridButton, true);

  const triangles = countTriangles(object);
  toolbar.append(
    h('span', { class: 'meta', title: 'Abmessungen in den Einheiten der Datei (bei STL meist mm)' },
      `${formatNumber(fileSize.x)} × ${formatNumber(fileSize.y)} × ${formatNumber(fileSize.z)}`),
    ...(triangles > 0 ? [h('span', { class: 'meta' }, `${triangles.toLocaleString('de-DE')} Dreiecke`)] : []),
    toolButton('Ansicht zurücksetzen', 'Kamera auf das ganze Modell ausrichten', resetView),
    wireButton,
    gridButton,
  );
  resetView();

  return {
    destroy: () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      controls.dispose();
      disposeTree(scene);
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      // Browsers only allow a handful of live WebGL contexts; free ours right away.
      renderer.forceContextLoss();
    },
  };
}
