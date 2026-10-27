// SPDX-License-Identifier: GPL-3.0-or-later
// BIM models (IFC2X3, IFC4, IFC4X3) via web-ifc (MPL-2.0, WebAssembly) in a worker. The geometry arrives merged per
// storey and IFC class, so even large models need few draw calls; the spatial structure drives visibility, and
// clicking an element shows its attributes, property sets, quantities and materials.
import * as THREE from 'three';
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import type { IfcBucket, IfcMaterial, IfcModel, IfcProperties, IfcRequest, IfcResponse, IfcTreeNode } from '../workers/ifc-types';
import { PropertiesCard } from './ifc/properties';
import { IfcTree } from './ifc/tree';
import { mountScene } from './three/scene';

/** Hidden at the start: rooms and the openings cut into walls would cover the building. */
const HIDDEN_AT_START = /^Ifc(Space|OpeningElement|OpeningStandardCase)$/i;

/** The worker keeps the model open after loading, for property lookups. */
class IfcWorker {
  private readonly worker = new Worker(new URL('../workers/ifc.worker.ts', import.meta.url), { type: 'module' });
  private readonly pending = new Map<number, { resolve(p: IfcProperties): void; reject(e: Error): void }>();
  private opening: { resolve(m: IfcModel): void; reject(e: Error): void } | null = null;
  private token = 0;

  constructor(progress: ViewerContext['progress']) {
    this.worker.onmessage = (event: MessageEvent<IfcResponse>) => {
      const data = event.data;
      if (data.ok === 'progress') progress(data.message, data.fraction);
      else if (data.ok && data.kind === 'model') this.opening?.resolve(data.model);
      else if (data.ok && data.kind === 'properties') this.settle(data.token, (p) => p.resolve(data.properties));
      else if (!data.ok && data.token !== undefined) this.settle(data.token, (p) => p.reject(new Error(data.error)));
      else if (!data.ok) this.opening?.reject(new Error(data.error));
    };
    this.worker.onerror = (event) => {
      const error = new Error(event.message || 'The IFC reader could not be loaded.');
      this.opening?.reject(error);
      for (const p of this.pending.values()) p.reject(error);
      this.pending.clear();
    };
  }

  private settle(token: number, fn: (p: { resolve(p: IfcProperties): void; reject(e: Error): void }) => void): void {
    const p = this.pending.get(token);
    this.pending.delete(token);
    if (p) fn(p);
  }

  private send(request: IfcRequest, transfer: Transferable[] = []): void {
    this.worker.postMessage(request, transfer);
  }

  open(buffer: ArrayBuffer): Promise<IfcModel> {
    return new Promise((resolve, reject) => {
      this.opening = { resolve, reject };
      this.send({ kind: 'open', buffer }, [buffer]);
    });
  }

  properties(id: number): Promise<IfcProperties> {
    const token = ++this.token;
    return new Promise((resolve, reject) => {
      this.pending.set(token, { resolve, reject });
      this.send({ kind: 'properties', id, token });
    });
  }

  terminate(): void {
    this.worker.terminate();
  }
}

function material(m: IfcMaterial): THREE.MeshStandardMaterial {
  const transparent = m.opacity < 0.999;
  return new THREE.MeshStandardMaterial({
    // IFC colors are sRGB, three.js works in linear RGB.
    color: new THREE.Color().setRGB(m.color[0], m.color[1], m.color[2], THREE.SRGBColorSpace),
    metalness: 0,
    roughness: 0.8,
    // Exporters do not agree on the winding of faces.
    side: THREE.DoubleSide,
    transparent,
    opacity: m.opacity,
    depthWrite: !transparent,
    // Pushes faces back a little so the edge lines stay visible on top.
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

/** A merged mesh and what is needed to hide single elements in it. */
interface Bucket {
  mesh: THREE.Mesh;
  /** Indices of all elements; the geometry's index holds only the visible ones. */
  full: Uint32Array;
  /** Per material: first index, index count, slot in the mesh's material list. */
  groups: Uint32Array;
  /** Per element piece: element, first index in `full`, index count. */
  chunks: Uint32Array;
  /** Pieces in the current index (numbers into `chunks`) and where each starts there. */
  shown: Uint32Array;
  starts: Uint32Array;
  /** Feature edges from the worker, and per element: element, first vertex, vertex count. */
  edges: Float32Array;
  edgeChunks: Uint32Array;
}

function buildBucket(data: IfcBucket, materials: THREE.Material[][]): Bucket {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(data.position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(data.normal, 3));
  // Starts with every element shown; hiding one replaces the index and leaves `full` as it is.
  geometry.setIndex(new THREE.BufferAttribute(data.index, 1));
  const list: THREE.Material[] = [];
  const groups = data.groups.slice();
  for (let g = 0; g < groups.length; g += 3) {
    list.push(materials[groups[g + 2]][0]);
    groups[g + 2] = list.length - 1;
    geometry.addGroup(groups[g], groups[g + 1], groups[g + 2]);
  }
  geometry.computeBoundingSphere();
  geometry.computeBoundingBox();
  const mesh = new THREE.Mesh(geometry, list);
  mesh.name = data.name;
  mesh.position.set(...data.origin);
  const pieces = data.chunks.length / 3;
  const all = Uint32Array.from({ length: pieces }, (_, i) => i);
  return {
    mesh,
    full: data.index,
    groups,
    chunks: data.chunks,
    shown: all,
    starts: Uint32Array.from(all, (i) => data.chunks[i * 3 + 1]),
    edges: data.edges,
    edgeChunks: data.edgeChunks,
  };
}

export async function mount(ctx: ViewerContext) {
  const { container, toolbar } = ctx;
  const buffer = await ctx.file.arrayBuffer();
  ctx.progress('Loading the IFC reader …');
  const worker = new IfcWorker(ctx.progress);
  let model: IfcModel;
  try {
    model = await worker.open(buffer);
  } catch (error) {
    worker.terminate();
    throw error;
  }
  ctx.progress('Building view …');

  // ---- Meshes --------------------------------------------------------------------------------------------------
  const count = model.ids.length;
  const palette = model.materials.map((m) => [material(m)]);
  const root = new THREE.Group();
  root.name = model.root.name;
  const buckets = model.buckets.map((data) => buildBucket(data, palette));
  for (const b of buckets) root.add(b.mesh);
  const bucketOfMesh = new Map(buckets.map((b) => [b.mesh as THREE.Object3D, b]));

  /** Pieces of each element: CSR lists of (bucket, piece). An element lies in one bucket. */
  const bucketOf = new Int32Array(count).fill(-1);
  const pieceStart = new Uint32Array(count + 1);
  buckets.forEach((b) => {
    for (let c = 0; c < b.chunks.length; c += 3) pieceStart[b.chunks[c] + 1]++;
  });
  for (let i = 0; i < count; i++) pieceStart[i + 1] += pieceStart[i];
  const pieces = new Uint32Array(pieceStart[count]);
  const fill = pieceStart.slice(0, count);
  buckets.forEach((b, bi) => {
    for (let c = 0; c < b.chunks.length; c += 3) {
      const e = b.chunks[c];
      bucketOf[e] = bi;
      pieces[fill[e]++] = c / 3;
    }
  });

  // ---- Visibility: one flag per element, merged meshes rebuild their index ---------------------------------------
  const hidden = new Uint8Array(count);
  const hasGeometry = new Uint8Array(count);
  for (let i = 0; i < count; i++) hasGeometry[i] = bucketOf[i] >= 0 ? 1 : 0;
  /** Running sums, so the tree can ask any range in constant time. */
  const geometrySum = new Uint32Array(count + 1);
  for (let i = 0; i < count; i++) geometrySum[i + 1] = geometrySum[i] + hasGeometry[i];
  const hiddenSum = new Uint32Array(count + 1);
  const recount = () => {
    for (let i = 0; i < count; i++) hiddenSum[i + 1] = hiddenSum[i] + (hidden[i] & hasGeometry[i]);
  };

  /** Edge lines of the visible elements of a bucket. */
  function edgeGeometry(b: Bucket): THREE.BufferGeometry {
    const { edges, edgeChunks } = b;
    let size = 0;
    for (let c = 0; c < edgeChunks.length; c += 3) if (!hidden[edgeChunks[c]]) size += edgeChunks[c + 2] * 3;
    let positions = edges;
    if (size < edges.length) {
      positions = new Float32Array(size);
      let out = 0;
      for (let c = 0; c < edgeChunks.length; c += 3) {
        if (hidden[edgeChunks[c]]) continue;
        const n = edgeChunks[c + 2] * 3;
        positions.set(edges.subarray(edgeChunks[c + 1] * 3, edgeChunks[c + 1] * 3 + n), out);
        out += n;
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return geometry;
  }

  function rebuild(b: Bucket): void {
    const { chunks, groups, full } = b;
    const total = chunks.length / 3;
    let shownCount = 0;
    let size = 0;
    for (let c = 0; c < total; c++) {
      if (!hidden[chunks[c * 3]]) {
        shownCount++;
        size += chunks[c * 3 + 2];
      }
    }
    b.mesh.visible = shownCount > 0;
    if (shownCount === 0 || (shownCount === b.shown.length && shownCount === total)) return;
    const geometry = b.mesh.geometry;
    const index = new Uint32Array(size);
    const shown = new Uint32Array(shownCount);
    const starts = new Uint32Array(shownCount);
    geometry.clearGroups();
    let out = 0;
    let k = 0;
    let g = 0;
    let groupStart = 0;
    const closeGroup = () => {
      if (out > groupStart) geometry.addGroup(groupStart, out - groupStart, groups[g * 3 + 2]);
      groupStart = out;
    };
    for (let c = 0; c < total; c++) {
      const first = chunks[c * 3 + 1];
      while (first >= groups[g * 3] + groups[g * 3 + 1]) {
        closeGroup();
        g++;
      }
      if (hidden[chunks[c * 3]]) continue;
      const n = chunks[c * 3 + 2];
      shown[k] = c;
      starts[k++] = out;
      index.set(full.subarray(first, first + n), out);
      out += n;
    }
    closeGroup();
    geometry.setIndex(new THREE.BufferAttribute(index, 1));
    b.shown = shown;
    b.starts = starts;
    // Measuring caches edges and circles per geometry; the edge lines follow the visible faces.
    delete geometry.userData.features;
    for (const child of b.mesh.children) {
      if (child instanceof THREE.LineSegments && child.userData.helper) {
        child.geometry.dispose();
        child.geometry = edgeGeometry(b);
      }
    }
  }

  function setRange(first: number, n: number, hide: boolean): void {
    const touched = new Set<number>();
    for (let e = first; e < first + n; e++) {
      if (hidden[e] === (hide ? 1 : 0)) continue;
      hidden[e] = hide ? 1 : 0;
      if (bucketOf[e] >= 0) touched.add(bucketOf[e]);
    }
    for (const bi of touched) rebuild(buckets[bi]);
    recount();
    // The highlight shows only what is visible.
    if (selection?.kind === 'element') highlight(selection.first, selection.count);
  }

  for (let i = 0; i < count; i++) if (HIDDEN_AT_START.test(model.classes[model.classOf[i]])) hidden[i] = 1;
  for (const b of buckets) rebuild(b);
  recount();

  // ---- View ------------------------------------------------------------------------------------------------------
  const elementCount = (function countElements(node: IfcTreeNode): number {
    return (node.kind === 'element' ? 1 : 0) + node.children.reduce((s, c) => s + countElements(c), 0);
  })(model.root);
  toolbar.append(
    h('span', { class: 'meta', title: 'IFC schema and number of building elements' }, `${model.schema} · ${elementCount.toLocaleString('en-US')} ${elementCount === 1 ? 'element' : 'elements'}`),
    ...(model.application ? [h('span', { class: 'meta ifc-app', title: `Written by ${model.application}` }, model.application)] : []),
  );
  let view: ReturnType<typeof mountScene>;
  try {
    view = mountScene(ctx, root, {
      zUp: true,
      unit: model.unit,
      title: model.root.name || ctx.file.name,
      ownTree: true,
      // Computed in the worker, ten times faster than three.js does it, and per element, so hiding one is instant.
      edges: (mesh) => {
        const b = bucketOfMesh.get(mesh);
        return b ? edgeGeometry(b) : null;
      },
    });
  } catch (error) {
    worker.terminate();
    throw error;
  }

  // ---- Selection: an outline mesh of the selected elements, properties in a card ---------------------------------
  const highlightMaterial = new THREE.MeshStandardMaterial({
    color: 0xf29a38,
    emissive: 0xf29a38,
    emissiveIntensity: 0.35,
    metalness: 0,
    roughness: 0.7,
    side: THREE.DoubleSide,
    transparent: true,
    opacity: 0.85,
    depthWrite: false,
    // In front of the element's own faces, which are pushed back.
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  let overlays: THREE.Mesh[] = [];
  let selection: IfcTreeNode | null = null;
  let token = 0;

  /** A compact copy of the given elements' faces, as a child of their merged mesh. */
  function highlight(first: number, n: number): void {
    for (const o of overlays) {
      o.removeFromParent();
      o.geometry.dispose();
    }
    overlays = [];
    const perBucket = new Map<number, number[]>();
    for (let e = first; e < first + n; e++) {
      if (bucketOf[e] < 0 || hidden[e]) continue;
      const list = perBucket.get(bucketOf[e]) ?? [];
      for (let p = pieceStart[e]; p < pieceStart[e + 1]; p++) list.push(pieces[p]);
      perBucket.set(bucketOf[e], list);
    }
    for (const [bi, list] of perBucket) {
      const b = buckets[bi];
      const position = b.mesh.geometry.getAttribute('position') as THREE.BufferAttribute;
      const normal = b.mesh.geometry.getAttribute('normal') as THREE.BufferAttribute;
      const remap = new Map<number, number>();
      const indices: number[] = [];
      for (const c of list) {
        const from = b.chunks[c * 3 + 1];
        const to = from + b.chunks[c * 3 + 2];
        for (let i = from; i < to; i++) {
          const v = b.full[i];
          let w = remap.get(v);
          if (w === undefined) {
            w = remap.size;
            remap.set(v, w);
          }
          indices.push(w);
        }
      }
      const pos = new Float32Array(remap.size * 3);
      const nor = new Float32Array(remap.size * 3);
      for (const [v, w] of remap) {
        pos.set((position.array as Float32Array).subarray(v * 3, v * 3 + 3), w * 3);
        nor.set((normal.array as Float32Array).subarray(v * 3, v * 3 + 3), w * 3);
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      geometry.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      geometry.setIndex(indices);
      const overlay = new THREE.Mesh(geometry, highlightMaterial);
      overlay.userData.helper = true;
      overlay.raycast = () => {};
      // Cut by the section plane like the model.
      overlay.onBeforeRender = () => {
        const own = (b.mesh.material as THREE.Material[])[0];
        if (highlightMaterial.clippingPlanes !== own.clippingPlanes) highlightMaterial.clippingPlanes = own.clippingPlanes;
      };
      b.mesh.add(overlay);
      overlays.push(overlay);
    }
    view.requestRender();
  }

  function select(node: IfcTreeNode | null): void {
    selection = node;
    highlight(node && node.kind === 'element' ? node.first : 0, node && node.kind === 'element' ? node.count : 0);
    const request = ++token;
    if (!node || node.kind === 'group') {
      card.hide();
      return;
    }
    card.loading(node.name, node.ifcClass);
    worker.properties(node.id).then(
      (properties) => request === token && card.show(properties),
      (error: Error) => request === token && card.failed(error.message),
    );
  }

  /** Bounding box of elements in world coordinates. */
  function boxOf(first: number, n: number): THREE.Box3 | null {
    const box = new THREE.Box3();
    for (let e = first; e < first + n; e++) {
      if (hidden[e] && n > 1) continue;
      const o = e * 6;
      if (Number.isNaN(model.boxes[o])) continue;
      box.expandByPoint(new THREE.Vector3(model.boxes[o], model.boxes[o + 1], model.boxes[o + 2]));
      box.expandByPoint(new THREE.Vector3(model.boxes[o + 3], model.boxes[o + 4], model.boxes[o + 5]));
    }
    if (box.isEmpty()) return null;
    root.updateMatrixWorld(true);
    return box.applyMatrix4(root.matrixWorld);
  }

  /**
   * Exports often carry a few stray objects far away (survey markers, forgotten families). The box of the elements
   * whose centers lie within the middle 96 % on every axis (with some margin), if it is much smaller than the whole.
   */
  function mainBox(): THREE.Box3 | null {
    const shown: number[] = [];
    for (let e = 0; e < count; e++) if (hasGeometry[e] && !hidden[e]) shown.push(e);
    if (shown.length < 50) return null;
    const center = (e: number, axis: number) => (model.boxes[e * 6 + axis] + model.boxes[e * 6 + 3 + axis]) / 2;
    const ranges = [0, 1, 2].map((axis) => {
      const sorted = Float64Array.from(shown, (e) => center(e, axis)).sort();
      const lo = sorted[Math.floor(sorted.length * 0.02)];
      const hi = sorted[Math.floor(sorted.length * 0.98)];
      return [lo - (hi - lo) * 0.25, hi + (hi - lo) * 0.25];
    });
    const all = boxOf(0, count);
    const main = new THREE.Box3();
    const corner = new THREE.Vector3();
    for (const e of shown) {
      if (![0, 1, 2].every((axis) => center(e, axis) >= ranges[axis][0] && center(e, axis) <= ranges[axis][1])) continue;
      main.expandByPoint(corner.fromArray(model.boxes, e * 6)).expandByPoint(corner.fromArray(model.boxes, e * 6 + 3));
    }
    if (!all || main.isEmpty()) return null;
    root.updateMatrixWorld(true);
    main.applyMatrix4(root.matrixWorld);
    return main.getSize(corner).length() < all.getSize(new THREE.Vector3()).length() * 0.5 ? main : null;
  }

  const focus = (node: IfcTreeNode) => {
    const box = boxOf(node.first, node.count);
    if (box) view.fitTo(box);
  };

  const nodeOf: (IfcTreeNode | undefined)[] = new Array(count);
  (function index(node: IfcTreeNode) {
    if (node.kind !== 'group') nodeOf[node.first] = node;
    node.children.forEach(index);
  })(model.root);

  const tree = new IfcTree(model.root, {
    visibility: (first, n) => ({ shown: geometrySum[first + n] - geometrySum[first], hidden: hiddenSum[first + n] - hiddenSum[first] }),
    setVisible: (node, visible) => {
      setRange(node.first, node.count, !visible);
      view.requestRender();
    },
    showAll: () => {
      setRange(0, count, false);
      view.requestRender();
    },
    select,
    focus,
  });
  const card = new PropertiesCard({
    close: () => {
      select(null);
      tree.reveal(null);
    },
    fit: () => selection && focus(selection),
  });
  container.append(tree.element, card.element);
  // The first view shows the bulk of the model; the home button still shows all of it.
  const main = mainBox();
  if (main) view.fitTo(main);

  // ---- Picking: a click on an element (not a drag, not while measuring) selects it --------------------------------
  const raycaster = new THREE.Raycaster();
  function elementAt(clientX: number, clientY: number): number {
    const rect = view.canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1), view.camera);
    const meshes = buckets.filter((b) => b.mesh.visible).map((b) => b.mesh);
    for (const hit of raycaster.intersectObjects(meshes, false)) {
      // Parts cut away by the section plane cannot be clicked.
      const planes = (hit.object as THREE.Mesh<THREE.BufferGeometry, THREE.Material[]>).material[0]?.clippingPlanes ?? [];
      if (planes.some((plane) => plane.distanceToPoint(hit.point) < 0)) continue;
      const b = bucketOfMesh.get(hit.object);
      if (!b || hit.faceIndex === undefined || hit.faceIndex === null) continue;
      const at = hit.faceIndex * 3;
      // Last piece starting at or before the face.
      let lo = 0;
      let hi = b.starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (b.starts[mid] <= at) lo = mid;
        else hi = mid - 1;
      }
      return b.chunks[b.shown[lo] * 3];
    }
    return -1;
  }

  let down: { x: number; y: number } | null = null;
  const onDown = (e: PointerEvent) => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  };
  const onUp = (e: PointerEvent) => {
    const d = down;
    down = null;
    if (!d || view.isMeasuring() || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const element = elementAt(e.clientX, e.clientY);
    const node = element >= 0 ? (nodeOf[element] ?? null) : null;
    select(node);
    tree.reveal(node);
  };
  view.canvas.addEventListener('pointerdown', onDown);
  view.canvas.addEventListener('pointerup', onUp);

  return {
    destroy: () => {
      view.canvas.removeEventListener('pointerdown', onDown);
      view.canvas.removeEventListener('pointerup', onUp);
      tree.dispose();
      worker.terminate();
      view.destroy();
      highlightMaterial.dispose();
    },
  };
}
