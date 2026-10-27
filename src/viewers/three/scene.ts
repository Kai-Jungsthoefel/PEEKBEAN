// SPDX-License-Identifier: GPL-3.0-or-later
// Shared 3D view for mesh formats and CAD models: Z up as in CAD programs, view cube, structure tree, section view,
// measuring.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { h, setPressed, toolButton } from '../../core/dom';
import { icon } from '../../core/icons';
import { onThemeChange, tokenColor } from '../../core/theme';
import type { Viewer, ViewerContext } from '../../core/types';
import { MeasureTool, type SnapCircle } from './measure';
import { PartsTree, buildTree, type TreeNode } from './parts-tree';
import { SectionTool } from './section';
import { ViewCube } from './viewcube';

export interface SceneOptions {
  /** True for formats that are Z-up already (STL, 3MF, STEP); Y-up formats (glTF, OBJ) are turned upright. */
  zUp: boolean;
  /** Unit of the file coordinates, shown with dimensions and measurements. */
  unit?: string;
  /** Name in the structure tree. */
  title: string;
  /** Exact circles the measuring tool snaps to (G-code arcs), in world coordinates. */
  circles?: () => SnapCircle[];
  /** The viewer brings its own structure tree and selection (IFC): no parts tree, and clicks select nothing here. */
  ownTree?: boolean;
  /** Edge lines of a mesh, for viewers that compute them faster themselves (IFC, in its worker). */
  edges?: (mesh: THREE.Mesh) => THREE.BufferGeometry | null;
}

/** Which axis of the file points up in the view. */
type Up = 'z' | 'y' | 'x' | '-z' | '-y' | '-x';
const UP_OPTIONS: [Up, string][] = [['z', 'Z up'], ['y', 'Y up'], ['x', 'X up'], ['-z', '−Z up'], ['-y', '−Y up'], ['-x', '−X up']];

/** Rotation that brings the chosen file axis to the view's Z (up). */
function upRotation(up: Up): THREE.Quaternion {
  const from = new THREE.Vector3(up.endsWith('x') ? 1 : 0, up.endsWith('y') ? 1 : 0, up.endsWith('z') ? 1 : 0).multiplyScalar(up.startsWith('-') ? -1 : 1);
  if (up === '-z') return new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI);
  return new THREE.Quaternion().setFromUnitVectors(from, new THREE.Vector3(0, 0, 1));
}

export function materialsOf(node: THREE.Object3D): THREE.Material[] {
  if (!(node instanceof THREE.Mesh || node instanceof THREE.Points || node instanceof THREE.Line)) return [];
  return Array.isArray(node.material) ? node.material : [node.material];
}

export function disposeTree(root: THREE.Object3D): void {
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

const isPart = (o: THREE.Object3D): o is THREE.Mesh | THREE.Points | THREE.Line =>
  !o.userData.helper && (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.Line);

/** Every part gets its own materials, so highlighting or ghosting one part never affects another. */
function ownMaterials(root: THREE.Object3D): void {
  const originals = new Set<THREE.Material>();
  root.traverse((node) => {
    if (!isPart(node)) return;
    const clone = (m: THREE.Material) => {
      originals.add(m);
      return m.clone();
    };
    node.material = Array.isArray(node.material) ? node.material.map(clone) : clone(node.material);
  });
  // Clones share textures with the originals; disposing a material leaves its textures alone.
  for (const m of originals) m.dispose();
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

/** Larger meshes take seconds to find their edges; they are then drawn only when asked for. */
const EDGES_AT_ONCE = 2_000_000;

const formatNumber = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

function isVisible(node: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = node; n; n = n.parent) if (!n.visible) return false;
  return true;
}

/** Lines along sharp edges, as children of their meshes: they turn, hide and get cut together with the part. */
function addFeatureEdges(root: THREE.Object3D, edges?: SceneOptions['edges']): THREE.LineSegments[] {
  const material = new THREE.LineBasicMaterial({ color: 0x1b1e23, transparent: true, opacity: 0.55 });
  const meshes: THREE.Mesh[] = [];
  root.traverse((node) => {
    if (node instanceof THREE.Mesh && !node.userData.helper) meshes.push(node);
  });
  return meshes.map((mesh) => {
    const lines = new THREE.LineSegments(edges?.(mesh) ?? new THREE.EdgesGeometry(mesh.geometry, 25), material);
    lines.userData.helper = true;
    lines.raycast = () => {};
    mesh.add(lines);
    return lines;
  });
}

/** File axes at the file origin: X red, Y green, Z blue, drawn on top of the model. */
function originAxes(length: number): THREE.Group {
  const group = new THREE.Group();
  const axes: [THREE.Vector3, string, string][] = [
    [new THREE.Vector3(1, 0, 0), '#d9443c', 'X'],
    [new THREE.Vector3(0, 1, 0), '#3e9a48', 'Y'],
    [new THREE.Vector3(0, 0, 1), '#2f7fd6', 'Z'],
  ];
  for (const [dir, color, label] of axes) {
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), dir.clone().multiplyScalar(length)]),
      new THREE.LineBasicMaterial({ color, depthTest: false }),
    );
    line.renderOrder = 998;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = color;
    g.font = '700 46px "IBM Plex Sans", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(label, 32, 34);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, sizeAttenuation: false }));
    sprite.scale.setScalar(0.045);
    sprite.position.copy(dir).multiplyScalar(length * 1.08);
    sprite.renderOrder = 998;
    group.add(line, sprite);
  }
  return group;
}

/** The mounted view, for viewers that add their own objects or interaction (G-code playback). */
export interface SceneView extends Viewer {
  requestRender(): void;
  readonly camera: THREE.PerspectiveCamera;
  readonly canvas: HTMLCanvasElement;
  /** Size of the model, for scaling markers. */
  readonly radius: number;
  /** Clicks then belong to the measuring tool. */
  isMeasuring(): boolean;
  /** Frames a box in world coordinates, keeping the view direction. */
  fitTo(box: THREE.Box3): void;
}

export function mountScene(ctx: ViewerContext, object: THREE.Object3D, options: SceneOptions): SceneView {
  const { container, toolbar } = ctx;
  object.updateMatrixWorld(true);
  const fileBox = new THREE.Box3().setFromObject(object);
  if (fileBox.isEmpty()) {
    disposeTree(object);
    throw new Error('The file contains no geometry that can be displayed.');
  }
  const fileSize = fileBox.getSize(new THREE.Vector3());
  ownMaterials(object);

  // The loader's own rotation of the root stays; the chosen up axis is applied on top of it.
  const loaderRotation = object.quaternion.clone();
  const model = new THREE.Group();
  model.add(object);
  const axes = originAxes(Math.max(fileSize.x, fileSize.y, fileSize.z) * 0.35);
  axes.visible = false;
  model.add(axes);

  let up: Up = options.zUp ? 'z' : 'y';
  let upright = upRotation(up);
  const box = new THREE.Box3();
  const size = new THREE.Vector3();
  let radius = 1;
  /** World position → coordinates of the file (undoing centering and the up rotation). */
  const toFile = (world: THREE.Vector3) => model.worldToLocal(world.clone()).applyQuaternion(upright.clone().invert());

  // Transparent canvas: the viewport gradient comes from CSS, as in SOMA.
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  const canvas = renderer.domElement;
  canvas.classList.add('model-canvas');
  container.classList.add('viewport');
  container.append(canvas);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = environment;
  scene.environmentIntensity = 0.6;
  // RoomEnvironment is Y-up; turn it with the world so the light still comes from above.
  scene.environmentRotation.set(Math.PI / 2, 0, 0);
  scene.add(model);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1000);
  camera.up.set(0, 0, 1);
  const headlight = new THREE.DirectionalLight(0xffffff, 0.9);
  headlight.position.set(1, 2, 1);
  camera.add(headlight);
  scene.add(camera);

  const readGridColors = () => [tokenColor(container, '--grid-major'), tokenColor(container, '--grid-minor')];
  let gridColors = readGridColors();
  let grid = new THREE.GridHelper(1, 20);

  /** (Re)creates the floor grid below the model, in the current theme's colors. */
  function buildGrid(): void {
    const visible = grid.visible;
    scene.remove(grid);
    grid.dispose();
    grid = new THREE.GridHelper(Math.max(size.x, size.y) * 2, 20, gridColors[0], gridColors[1]);
    grid.rotation.x = Math.PI / 2;
    grid.position.z = -size.z / 2;
    grid.visible = visible;
    scene.add(grid);
  }

  /** Applies the up axis, centers the model at the origin and fits the floor grid. */
  function orient(): void {
    upright = upRotation(up);
    object.quaternion.copy(upright).multiply(loaderRotation);
    axes.quaternion.copy(upright);
    model.position.set(0, 0, 0);
    model.updateMatrixWorld(true);
    box.setFromObject(object);
    box.getSize(size);
    radius = size.length() / 2 || 1;
    // Centering keeps far-away coordinates (common in CAD assemblies) precise on the GPU.
    model.position.copy(box.getCenter(new THREE.Vector3())).negate();
    model.updateMatrixWorld(true);
    box.translate(model.position);
    buildGrid();
  }
  orient();

  const controls = new OrbitControls(camera, canvas);
  controls.screenSpacePanning = true;
  // Wheel zooms towards the point under the cursor, so details off center are easy to reach.
  controls.zoomToCursor = true;

  const cubeHost = h('div', { class: 'cube-view' });
  const homeButton = h('button', { type: 'button', title: 'Show the whole model', 'aria-label': 'Show the whole model', onclick: () => resetView(true) }, icon('home', 16, 1.8));
  const fitButton = h('button', { type: 'button', title: 'Fit the model into the view, keeping the direction', 'aria-label': 'Fit', onclick: () => fitTo(box, true) }, icon('fit', 16, 1.8));
  container.append(h('div', { class: 'cube' }, cubeHost, h('div', { class: 'vbtns' }, homeButton, fitButton)));

  let measure: MeasureTool | null = null;
  let frame = 0;
  const requestRender = () => {
    frame ||= requestAnimationFrame(() => {
      frame = 0;
      renderer.render(scene, camera);
      cube.render();
      measure?.update();
    });
  };
  controls.addEventListener('change', requestRender);
  const stopThemeUpdates = onThemeChange(() => {
    gridColors = readGridColors();
    buildGrid();
    requestRender();
  });

  // ---- Camera moves ----------------------------------------------------------------------------------------------
  let animation = 0;
  function animateTo(position: THREE.Vector3, target: THREE.Vector3, animate = true): void {
    cancelAnimationFrame(animation);
    const fromPos = camera.position.clone();
    const fromTarget = controls.target.clone();
    const start = performance.now();
    const step = () => {
      const t = animate ? Math.min(1, (performance.now() - start) / 320) : 1;
      const k = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
      camera.position.lerpVectors(fromPos, position, k);
      controls.target.lerpVectors(fromTarget, target, k);
      controls.update();
      requestRender();
      if (t < 1) animation = requestAnimationFrame(step);
    };
    step();
  }

  const distanceFor = (r: number) => r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));

  function setClipping(distance: number): void {
    camera.near = Math.max(distance / 1000, radius / 10000);
    camera.far = distance + radius * 100;
    camera.updateProjectionMatrix();
  }

  /** Isometric view from front right above with the whole model in view. */
  function resetView(animate = false): void {
    const distance = distanceFor(radius);
    setClipping(distance);
    animateTo(new THREE.Vector3(1, -1.25, 0.9).normalize().multiplyScalar(distance), new THREE.Vector3(), animate);
  }

  /** Frames a box, keeping the current view direction. */
  function fitTo(target: THREE.Box3, animate: boolean): void {
    const sphere = target.getBoundingSphere(new THREE.Sphere());
    const distance = distanceFor(sphere.radius || radius * 0.05) * 1.1;
    const dir = camera.position.clone().sub(controls.target).normalize();
    setClipping(distance);
    animateTo(sphere.center.clone().addScaledVector(dir, distance), sphere.center, animate);
  }

  const cube = new ViewCube(cubeHost, {
    camera: () => camera,
    target: () => controls.target,
    orient: (dir) => {
      const d = dir.clone().normalize();
      // Straight down or up is a singular direction for the orbit controls; lean slightly to the front.
      if (Math.abs(d.z) > 0.999) d.set(0, -0.001, Math.sign(d.z)).normalize();
      animateTo(controls.target.clone().addScaledVector(d, camera.position.distanceTo(controls.target)), controls.target.clone());
    },
    orbit: (dTheta, dPhi) => {
      const offset = camera.position.clone().sub(controls.target);
      const toYUp = new THREE.Quaternion().setFromUnitVectors(camera.up, new THREE.Vector3(0, 1, 0));
      const spherical = new THREE.Spherical().setFromVector3(offset.applyQuaternion(toYUp));
      spherical.theta += dTheta;
      spherical.phi = THREE.MathUtils.clamp(spherical.phi + dPhi, 0.01, Math.PI - 0.01);
      offset.setFromSpherical(spherical).applyQuaternion(toYUp.invert());
      camera.position.copy(controls.target).add(offset);
      controls.update();
      requestRender();
    },
  });

  const parts: (THREE.Mesh | THREE.Points | THREE.Line)[] = [];
  object.traverse((o) => {
    if (isPart(o)) parts.push(o);
  });
  const pickables = () => parts.filter((o) => (o instanceof THREE.Mesh || o instanceof THREE.Points) && isVisible(o));

  // ---- Edges, as CAD programs draw them: from the start, except on very large meshes ---------------------------------
  const meshes = parts.filter((o): o is THREE.Mesh => o instanceof THREE.Mesh);
  const triangles = countTriangles(object);
  let edgeLines: THREE.LineSegments[] = [];
  function createEdges(): void {
    edgeLines = addFeatureEdges(object, options.edges);
    const meshMaterials = meshes.flatMap(materialsOf);
    // Faces step back a little so the edges on them stay visible.
    for (const m of meshMaterials) Object.assign(m, { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1, needsUpdate: true });
    // A section view that is already open cuts the new edges as well.
    const clipping = meshMaterials[0]?.clippingPlanes ?? null;
    for (const lines of edgeLines) Object.assign(lines.material as THREE.Material, { clippingPlanes: clipping, needsUpdate: true });
  }
  if (meshes.length && triangles <= EDGES_AT_ONCE) createEdges();

  const raycaster = new THREE.Raycaster();
  const hitAt = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), camera);
    raycaster.params.Points.threshold = radius * 0.008;
    return raycaster.intersectObjects(pickables(), false)[0] ?? null;
  };

  // Double click (or double tap) on the model brings that spot to the center of the view.
  canvas.addEventListener('dblclick', (e) => {
    const hit = hitAt(e.clientX, e.clientY);
    if (!hit) return;
    const delta = hit.point.clone().sub(controls.target);
    animateTo(camera.position.clone().add(delta), hit.point.clone());
  });

  const resizeObserver = new ResizeObserver(() => {
    const { clientWidth: w, clientHeight: hgt } = container;
    if (w === 0 || hgt === 0) return;
    renderer.setSize(w, hgt, false);
    camera.aspect = w / hgt;
    camera.updateProjectionMatrix();
    requestRender();
  });
  resizeObserver.observe(container);

  // ---- Highlight and transparency ----------------------------------------------------------------------------------
  const setGhost = (objects: THREE.Object3D[], on: boolean) => {
    for (const o of objects) {
      if (Boolean(o.userData.ghost) === on) continue;
      o.userData.ghost = on;
      for (const m of materialsOf(o)) {
        if (on) {
          m.userData.solid = { transparent: m.transparent, opacity: m.opacity, depthWrite: m.depthWrite };
          Object.assign(m, { transparent: true, opacity: 0.2, depthWrite: false });
        } else if (m.userData.solid) {
          Object.assign(m, m.userData.solid);
        }
        m.needsUpdate = true;
      }
    }
  };

  let highlighted: THREE.Object3D[] = [];
  const highlight = (objects: THREE.Object3D[]) => {
    for (const o of highlighted) for (const m of materialsOf(o)) if ('emissive' in m) (m as THREE.MeshStandardMaterial).emissive.setHex(0x000000);
    highlighted = objects;
    for (const o of highlighted) for (const m of materialsOf(o)) if ('emissive' in m) (m as THREE.MeshStandardMaterial).emissive.setHex(0x7a3d00);
    requestRender();
  };

  // ---- Structure tree --------------------------------------------------------------------------------------------
  const treeRoot = buildTree(object);
  let tree: PartsTree | null = null;
  if (!options.ownTree && treeRoot && treeRoot.renderables.length > 1) {
    tree = new PartsTree(treeRoot, options.title, {
      changed: requestRender,
      setGhost,
      isGhost: (o) => Boolean(o.userData.ghost),
      select: (node: TreeNode | null) => highlight(node?.renderables ?? []),
      focus: (node: TreeNode) => fitTo(new THREE.Box3().setFromObject(node.object), true),
    });
    container.append(tree.element);
  }

  // A click on a part (not a drag, not while measuring) selects it here and in the tree.
  let down: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  });
  canvas.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || options.ownTree || measure?.isActive || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const hit = hitAt(e.clientX, e.clientY);
    const node = tree?.reveal(hit?.object ?? null) ?? null;
    highlight(node?.renderables ?? (hit ? [hit.object] : []));
  });

  // ---- Measuring and section ---------------------------------------------------------------------------------------
  measure = new MeasureTool({
    camera: () => camera,
    canvas,
    viewport: container,
    scene,
    // Lines too: tool paths and curves snap at their end points and along their length.
    pickables: () => parts.filter(isVisible),
    circles: options.circles,
    toFile,
    size: () => radius * 2,
    unit: options.unit ?? '',
    requestRender,
  });
  const section = new SectionTool({
    renderer,
    partMaterials: () => parts.flatMap(materialsOf),
    lineMaterials: () => [...new Set(edgeLines.map((l) => l.material as THREE.Material))],
    box: () => box,
    toFile,
    unit: options.unit ?? '',
    requestRender,
  });
  container.append(h('div', { class: 'cards' }, measure.card, section.card));

  // ---- Toolbar ---------------------------------------------------------------------------------------------------
  const upSelect = h(
    'select',
    { title: 'Which axis of the file points up', onchange: () => {
      up = upSelect.value as Up;
      orient();
      section.refresh();
      resetView(true);
    } },
    ...UP_OPTIONS.map(([value, label]) => h('option', { value }, label)),
  );
  upSelect.value = up;
  let wireframe = false;
  const wireButton = toolButton('Wireframe', 'Toggle wireframe', () => {
    wireframe = !wireframe;
    setPressed(wireButton, wireframe);
    for (const o of parts) for (const m of materialsOf(o)) if ('wireframe' in m) (m as THREE.MeshStandardMaterial).wireframe = wireframe;
    requestRender();
  });
  const ghostButton = toolButton('Transparent', 'Show all parts see-through', () => {
    const on = !parts.every((o) => o.userData.ghost);
    setGhost(parts, on);
    setPressed(ghostButton, on);
    tree?.render();
    requestRender();
  });
  const gridButton = toolButton('Grid', 'Toggle the floor grid', () => {
    grid.visible = !grid.visible;
    setPressed(gridButton, grid.visible);
    requestRender();
  });
  const originButton = toolButton('Origin', 'Show the origin and axes of the file', () => {
    axes.visible = !axes.visible;
    setPressed(originButton, axes.visible);
    requestRender();
  });
  let edgesVisible = edgeLines.length > 0;
  const edgeButton = meshes.length
    ? toolButton('Edges', 'Show the edges: where faces meet at an angle of more than 25°', () => {
        edgesVisible = !edgesVisible;
        if (edgesVisible && !edgeLines.length) createEdges();
        for (const lines of edgeLines) lines.visible = edgesVisible;
        setPressed(edgeButton!, edgesVisible);
        requestRender();
      })
    : null;
  setPressed(wireButton, false);
  setPressed(ghostButton, false);
  setPressed(gridButton, true);
  setPressed(originButton, false);
  if (edgeButton) setPressed(edgeButton, edgesVisible);

  const unit = options.unit ? ` ${options.unit}` : '';
  toolbar.append(
    h('span', { class: 'meta', title: 'Size of the bounding box in file coordinates' },
      `${formatNumber(fileSize.x)} × ${formatNumber(fileSize.y)} × ${formatNumber(fileSize.z)}${unit}`),
    ...(triangles > 0 ? [h('span', { class: 'meta' }, `${triangles.toLocaleString('en-US')} triangles`)] : []),
    upSelect,
    ...(edgeButton ? [edgeButton] : []),
    wireButton,
    ghostButton,
    gridButton,
    originButton,
    section.button,
    measure.button,
  );
  resetView();

  return {
    requestRender,
    camera,
    canvas,
    get radius() {
      return radius;
    },
    isMeasuring: () => Boolean(measure?.isActive),
    fitTo: (target) => fitTo(target, true),
    destroy: () => {
      stopThemeUpdates();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(animation);
      resizeObserver.disconnect();
      measure?.dispose();
      section.dispose();
      cube.dispose();
      controls.dispose();
      disposeTree(scene);
      grid.dispose();
      environment.dispose();
      pmrem.dispose();
      renderer.dispose();
      // Browsers only allow a handful of live WebGL contexts; free ours right away.
      renderer.forceContextLoss();
    },
  };
}
