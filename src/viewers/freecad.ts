// SPDX-License-Identifier: GPL-3.0-or-later
// FreeCAD documents (.FCStd, a ZIP read with zip.js, BSD-3-Clause). FreeCAD stores every shape as OpenCascade BREP;
// they are tessellated with occt-import-js (LGPL-2.1, WebAssembly) in one worker. Shown as FreeCAD shows them: only
// visible objects, in their colors and transparency, grouped like FreeCAD's tree (parts, bodies, groups, links);
// sketches and wires as lines. A shape already contains its object's placement; only the placements of parts,
// bodies and links around it are applied here.
import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader, configure, type Entry } from '@zip.js/zip.js';
import * as THREE from 'three';
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import type { OcctBatchResponse, OcctMesh, OcctRequest } from '../workers/occt-types';
import { brepEdgeSegments } from './freecad/brep-edges';
import { readDocument, type FcDocument, type FcObject, type Placement, type Rgb } from './freecad/document';
import { mountScene } from './three/scene';

configure({ useWebWorkers: false, useCompressionStream: true });

/** What will be drawn: the FreeCAD tree reduced to visible objects with shapes. */
type PlanNode =
  | { kind: 'group'; name: string; matrix: THREE.Matrix4 | null; children: PlanNode[] }
  | { kind: 'shape'; name: string; object: FcObject; matrix: THREE.Matrix4 | null };

/** Reasons objects are not shown, counted for the toolbar. */
type Skipped = Map<string, number>;

const placementMatrix = (p: Placement) =>
  new THREE.Matrix4().compose(new THREE.Vector3(...p.position), new THREE.Quaternion(...p.quaternion), new THREE.Vector3(1, 1, 1));

const compose = (outer: THREE.Matrix4 | null, inner: THREE.Matrix4 | null) => (outer && inner ? outer.clone().multiply(inner) : (outer ?? inner));

/** Objects that never have a shape worth showing (origins, datums) or that are drawn by FreeCAD in other ways. */
const IGNORED = /^(App::(Origin|Line|Plane|Point)$|PartDesign::(Plane|Line|Point|CoordinateSystem|ShapeBinder|SubShapeBinder)$|Part::Datum)/;

function planDocument(doc: FcDocument, skipped: Skipped): PlanNode[] {
  const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) ?? 0) + 1);
  const claimed = new Set<string>();
  for (const o of doc.objects.values()) for (const name of [...o.group, ...o.owned]) claimed.add(name);

  const node = (object: FcObject, viaLink: boolean, depth: number): PlanNode | null => {
    // A link shows its target even when the target itself is hidden (it usually is).
    if ((!viaLink && !object.visible) || depth > 32) return null;
    if (object.link) {
      const target = doc.objects.get(object.link.target);
      if (object.link.external || !target) {
        skip('links to other documents');
        return null;
      }
      const inner = node(target, true, depth + 1);
      if (!inner) return null;
      // The target's own placement is replaced by the link's, unless the link adds to it (LinkTransform).
      const own = !object.link.transform && target.placement ? placementMatrix(target.placement).invert() : null;
      const placed = (outer: THREE.Matrix4) => compose(compose(outer, own), inner.matrix);
      const matrix = placementMatrix(object.link.placement).scale(new THREE.Vector3(...object.link.scale));
      if (!object.link.elements.length) return { ...inner, name: object.label, matrix: placed(matrix) };
      // Link array: one copy per element.
      const children = object.link.elements.map((p, i) => ({ ...inner, name: `${object.label} ${i + 1}`, matrix: placed(placementMatrix(p)) }));
      return { kind: 'group', name: object.label, matrix, children };
    }
    if (object.container && !object.showsTip) {
      const children = object.group
        .map((name) => doc.objects.get(name))
        .filter((o): o is FcObject => Boolean(o))
        .map((o) => node(o, false, depth + 1))
        .filter((n): n is PlanNode => n !== null);
      if (!children.length) return null;
      const matrix = object.placesChildren && object.placement ? placementMatrix(object.placement) : null;
      // A body that shows a single solid is that part, as FreeCAD users see it.
      if (object.type === 'PartDesign::Body' && children.length === 1 && children[0].kind === 'shape') {
        return { ...children[0], name: object.label, matrix: compose(matrix, children[0].matrix) };
      }
      return { kind: 'group', name: object.label, matrix, children };
    }
    if (IGNORED.test(object.type)) return null;
    if (object.shape && 'binary' in object.shape) {
      skip('shapes in binary BREP format');
      return null;
    }
    if (object.shape) return { kind: 'shape', name: object.label, object, matrix: null };
    if (/^(Mesh|Points)::/.test(object.type)) skip(object.type.startsWith('Mesh') ? 'mesh objects' : 'point clouds');
    return null;
  };

  return doc.order
    .filter((name) => !claimed.has(name))
    .map((name) => node(doc.objects.get(name)!, false, 0))
    .filter((n): n is PlanNode => n !== null);
}

function shapeNodes(nodes: PlanNode[]): Extract<PlanNode, { kind: 'shape' }>[] {
  return nodes.flatMap((n) => (n.kind === 'shape' ? [n] : shapeNodes(n.children)));
}

interface Tessellated {
  meshes: OcctMesh[];
  /** Wires and loose edges (or all edges when the faces could not be meshed). */
  lines: Float32Array | null;
}

function tessellate(texts: string[], progress: ViewerContext['progress']): Promise<(OcctMesh[] | null)[]> {
  const worker = new Worker(new URL('../workers/occt.worker.ts', import.meta.url), { type: 'module' });
  const results: (OcctMesh[] | null)[] = texts.map(() => null);
  let done = 0;
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<OcctBatchResponse>) => {
      const data = event.data;
      if (data.ok === 'progress') {
        progress(`Computing geometry (0 of ${texts.length}) …`, 0);
        return;
      }
      if (data.ok === 'done') {
        worker.terminate();
        resolve(results);
        return;
      }
      if (!('index' in data)) {
        worker.terminate();
        reject(new Error((data as { error?: string }).error ?? 'The CAD kernel failed.'));
        return;
      }
      if (data.ok) results[data.index] = data.meshes;
      done++;
      progress(`Computing geometry (${done} of ${texts.length}) …`, done / texts.length);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The CAD kernel could not be loaded.'));
    };
    const encoder = new TextEncoder();
    const batch: OcctRequest[] = texts.map((text) => ({ format: 'brep', buffer: encoder.encode(text).buffer }));
    worker.postMessage({ batch }, batch.map((r) => r.buffer));
  });
}

// ---- Scene -------------------------------------------------------------------------------------------------------

/** Linear RGB of the neutral steel blue the other CAD viewers use for parts without a color. */
const DEFAULT_COLOR = new THREE.Color(0.32, 0.37, 0.45);
/** For black and white lines (FreeCAD's defaults), which would vanish on one of the two themes. */
const NEUTRAL_LINE = new THREE.Color().setRGB(0.49, 0.54, 0.6, THREE.SRGBColorSpace);

function surface(color: THREE.Color, transparency: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    metalness: 0.1,
    roughness: 0.5,
    side: THREE.DoubleSide,
    ...(transparency > 0.01 ? { transparent: true, opacity: Math.max(0.05, 1 - transparency), depthWrite: false } : {}),
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
}

const srgb = (c: Rgb) => new THREE.Color().setRGB(c[0], c[1], c[2], THREE.SRGBColorSpace);

/** All meshes of one shape as one mesh, so that each FreeCAD object is one part; faces keep their order. */
function buildMesh(meshes: OcctMesh[], object: FcObject): THREE.Mesh {
  const vertexCount = meshes.reduce((n, m) => n + m.position.length / 3, 0);
  const indexCount = meshes.reduce((n, m) => n + m.index.length, 0);
  const position = new Float32Array(vertexCount * 3);
  const normal = meshes.every((m) => m.normal) ? new Float32Array(vertexCount * 3) : null;
  const index = new Uint32Array(indexCount);
  const faces: { first: number; count: number }[] = [];
  let vertices = 0;
  let indices = 0;
  for (const m of meshes) {
    position.set(m.position, vertices * 3);
    if (normal) normal.set(m.normal!, vertices * 3);
    for (let i = 0; i < m.index.length; i++) index[indices + i] = m.index[i] + vertices;
    for (const f of m.faces) faces.push({ first: indices + f.first * 3, count: (f.last - f.first + 1) * 3 });
    vertices += m.position.length / 3;
    indices += m.index.length;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  if (normal) geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  geometry.setIndex(new THREE.BufferAttribute(index, 1));
  if (!normal) geometry.computeVertexNormals();

  const appearance = object.appearance;
  const transparency = appearance?.transparency ?? 0;
  const colors = appearance?.colors ?? [];
  // A color per face only when the list matches the faces; FreeCAD falls back to the first color otherwise.
  if (colors.length > 1 && colors.length === faces.length) {
    const materials: THREE.Material[] = [];
    const byColor = new Map<string, number>();
    faces.forEach((face, i) => {
      const key = colors[i].join(',');
      if (!byColor.has(key)) {
        byColor.set(key, materials.length);
        materials.push(surface(srgb(colors[i]), transparency));
      }
      geometry.addGroup(face.first, face.count, byColor.get(key)!);
    });
    return new THREE.Mesh(geometry, materials);
  }
  return new THREE.Mesh(geometry, surface(colors[0] ? srgb(colors[0]) : DEFAULT_COLOR.clone(), transparency));
}

function buildLines(points: Float32Array, object: FcObject): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(points, 3));
  const c = object.lineColor;
  const extreme = !c || c.every((v) => v > 0.9) || c.every((v) => v < 0.1);
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: extreme ? NEUTRAL_LINE.clone() : srgb(c) }));
}

function buildNode(node: PlanNode, shapes: Map<FcObject, Tessellated>): THREE.Object3D | null {
  let object: THREE.Object3D | null = null;
  if (node.kind === 'group') {
    const group = new THREE.Group();
    for (const c of node.children) {
      const built = buildNode(c, shapes);
      if (built) group.add(built);
    }
    object = group.children.length ? group : null;
  } else {
    const shape = shapes.get(node.object);
    const mesh = shape?.meshes.length ? buildMesh(shape.meshes, node.object) : null;
    const lines = shape?.lines ? buildLines(shape.lines, node.object) : null;
    if (mesh && lines) {
      mesh.name = 'Faces';
      lines.name = 'Wires';
      object = new THREE.Group().add(mesh, lines);
    } else {
      object = mesh ?? lines;
    }
  }
  if (!object) return null;
  object.name = node.name;
  node.matrix?.decompose(object.position, object.quaternion, object.scale);
  return object;
}

// ---- Viewer ------------------------------------------------------------------------------------------------------

export async function mount(ctx: ViewerContext) {
  ctx.progress('Reading FreeCAD document …');
  const zip = new ZipReader(new BlobReader(ctx.file));
  let entries: Entry[];
  try {
    entries = await zip.getEntries();
  } catch {
    throw new Error('This is not a FreeCAD document: the file is not a ZIP archive.');
  }
  const byName = new Map(entries.map((e) => [e.filename, e]));
  const read = async (name: string) => {
    const entry = byName.get(name);
    return entry && !entry.directory ? entry.getData(new Uint8ArrayWriter()) : null;
  };
  const readText = async (name: string) => {
    const entry = byName.get(name);
    return entry && !entry.directory ? entry.getData(new TextWriter()) : null;
  };

  try {
    const documentXml = await readText('Document.xml');
    if (!documentXml) throw new Error('This is not a FreeCAD document: Document.xml is missing.');
    const doc = await readDocument(documentXml, await readText('GuiDocument.xml'), read);
    const skipped: Skipped = new Map();
    const roots = planDocument(doc, skipped);

    // Every shown object's BREP text; empty files are objects without a shape.
    const shown = [...new Set(shapeNodes(roots).map((n) => n.object))];
    const texts = new Map<FcObject, string>();
    for (const object of shown) {
      const source = object.shape!;
      const text = 'text' in source ? source.text : 'file' in source ? await readText(source.file) : null;
      if (text?.trim()) texts.set(object, text);
    }
    if (!texts.size) {
      throw new Error('Nothing that FreeCAD shows in this document can be displayed here: only shapes are supported, not FEM results, meshes, drawing pages or annotations.');
    }

    ctx.progress('Loading CAD kernel …');
    const objects = [...texts.keys()];
    const meshes = await tessellate([...texts.values()], ctx.progress);
    ctx.progress('Building view …');
    const shapes = new Map<FcObject, Tessellated>();
    objects.forEach((object, i) => {
      const faces = meshes[i]?.filter((m) => m.index.length > 0) ?? [];
      // Sketches and wires have no faces: their edges become lines. Next to faces only loose edges are drawn.
      let lines: Float32Array | null = null;
      try {
        lines = brepEdgeSegments(texts.get(object)!, faces.length > 0);
      } catch (error) {
        console.warn(`Edges of ${object.label} could not be read:`, error);
      }
      shapes.set(object, { meshes: faces, lines });
    });

    const root = new THREE.Group();
    for (const node of roots) {
      const built = buildNode(node, shapes);
      if (built) root.add(built);
    }

    const { toolbar } = ctx;
    if (doc.version) toolbar.append(h('span', { class: 'meta', title: 'FreeCAD version that saved the document' }, `FreeCAD ${doc.version}`));
    const notShown = [...skipped.values()].reduce((a, b) => a + b, 0);
    if (notShown) {
      const reasons = [...skipped].map(([reason, n]) => `${n} ${reason}`).join(', ');
      toolbar.append(h('span', { class: 'meta', title: `Not shown: ${reasons}` }, `${notShown} ${notShown === 1 ? 'object' : 'objects'} not shown`));
    }
    // FreeCAD works in millimeters with Z up.
    return mountScene(ctx, root, { zUp: true, unit: 'mm', title: doc.label || ctx.file.name });
  } finally {
    await zip.close();
  }
}
