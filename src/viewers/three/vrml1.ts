// SPDX-License-Identifier: GPL-3.0-or-later
// VRML 1.0 ("#VRML V1.0 ascii"), which three.js does not read; SolidWorks and older CAD systems still export it. The
// scene is a tree of nodes whose state (coordinates, material, transform) flows from one sibling to the next inside a
// Separator, as in Open Inventor. Shapes are baked into world coordinates and grouped by their Separator, so the parts
// tree shows the DEF names.
import * as THREE from 'three';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

interface VrmlNode {
  type: string;
  name?: string;
  fields: Map<string, (number | string)[]>;
  children: VrmlNode[];
}

export function isVrml1(text: string): boolean {
  return /^#VRML V1\.0/.test(text);
}

/** Tokens: words, numbers, strings, and the punctuation { } [ ] ( ) |. Commas count as white space. */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const pattern = /\s+|,|#[^\n]*|"((?:[^"\\]|\\.)*)"|([{}[\]()|])|([^\s,{}[\]()|"#]+)/g;
  for (const m of text.matchAll(pattern)) {
    if (m[1] !== undefined) tokens.push(`"${m[1]}`);
    else if (m[2] !== undefined) tokens.push(m[2]);
    else if (m[3] !== undefined) tokens.push(m[3]);
  }
  return tokens;
}

const isNumber = (token: string | undefined) => token !== undefined && /^[-+]?(\d|\.\d)/.test(token);

function parse(text: string): VrmlNode[] {
  const tokens = tokenize(text.replace(/^#VRML[^\n]*/, ''));
  const defined = new Map<string, VrmlNode>();
  let p = 0;

  const value = (): (number | string)[] => {
    const token = tokens[p];
    if (token === '[') {
      p++;
      const values: (number | string)[] = [];
      while (p < tokens.length && tokens[p] !== ']') values.push(literal(tokens[p++]));
      p++;
      return values;
    }
    if (token === '(') {
      // Bit masks: (SIDES | BOTTOM).
      const values: string[] = [];
      for (p++; p < tokens.length && tokens[p] !== ')'; p++) if (tokens[p] !== '|') values.push(tokens[p]);
      p++;
      return values;
    }
    if (isNumber(token)) {
      const values: number[] = [];
      while (isNumber(tokens[p])) values.push(Number(tokens[p++]));
      return values;
    }
    p++;
    return [literal(token)];
  };

  const literal = (token: string): number | string => (isNumber(token) ? Number(token) : token.startsWith('"') ? token.slice(1) : token);

  const node = (): VrmlNode | null => {
    let name: string | undefined;
    if (tokens[p] === 'USE') {
      p += 2;
      return defined.get(tokens[p - 1]) ?? null;
    }
    if (tokens[p] === 'DEF') {
      name = tokens[p + 1];
      p += 2;
    }
    const type = tokens[p++];
    if (tokens[p] !== '{') throw new Error(`The VRML file is damaged near "${type}".`);
    p++;
    const result: VrmlNode = { type, name, fields: new Map(), children: [] };
    if (name) defined.set(name, result);
    while (p < tokens.length && tokens[p] !== '}') {
      const token = tokens[p];
      // A word followed by "{" (or DEF/USE) starts a child node; any other word names a field.
      if (token === 'DEF' || token === 'USE' || tokens[p + 1] === '{') {
        const child = node();
        if (child) result.children.push(child);
      } else {
        p++;
        result.fields.set(token, value());
      }
    }
    p++;
    return result;
  };

  const roots: VrmlNode[] = [];
  while (p < tokens.length) {
    // SolidWorks ends its files with one closing brace too many.
    if (tokens[p] === '}' || tokens[p] === ']') {
      p++;
      continue;
    }
    const root = node();
    if (root) roots.push(root);
  }
  return roots;
}

interface State {
  matrix: THREE.Matrix4;
  points: number[];
  colors: number[][];
  transparency: number;
  materialBinding: string;
  ccw: boolean | null;
  solid: boolean;
  creaseAngle: number;
}

const numbers = (node: VrmlNode, field: string, fallback: number[]): number[] => {
  const values = node.fields.get(field);
  return values?.length ? values.map(Number) : fallback;
};
const word = (node: VrmlNode, field: string, fallback: string): string => String(node.fields.get(field)?.[0] ?? fallback);

function transformMatrix(node: VrmlNode): THREE.Matrix4 {
  const [tx, ty, tz] = numbers(node, 'translation', [0, 0, 0]);
  const [rx, ry, rz, angle] = numbers(node, 'rotation', [0, 0, 1, 0]);
  const [sx, sy, sz] = numbers(node, 'scaleFactor', [1, 1, 1]);
  const [ox, oy, oz, orientation] = numbers(node, 'scaleOrientation', [0, 0, 1, 0]);
  const [cx, cy, cz] = numbers(node, 'center', [0, 0, 0]);
  const axisRotation = (x: number, y: number, z: number, a: number) => new THREE.Matrix4().makeRotationAxis(new THREE.Vector3(x, y, z).normalize(), a || 0);
  const so = axisRotation(ox, oy, oz, orientation);
  // T · C · R · SR · S · SR⁻¹ · C⁻¹
  return new THREE.Matrix4()
    .makeTranslation(tx, ty, tz)
    .multiply(new THREE.Matrix4().makeTranslation(cx, cy, cz))
    .multiply(axisRotation(rx, ry, rz, angle))
    .multiply(so)
    .multiply(new THREE.Matrix4().makeScale(sx || 1, sy || 1, sz || 1))
    .multiply(so.clone().invert())
    .multiply(new THREE.Matrix4().makeTranslation(-cx, -cy, -cz));
}

function material(state: State, vertexColors: boolean, color?: number[]): THREE.Material {
  const [r, g, b] = color ?? state.colors[0] ?? [0.8, 0.8, 0.8];
  return new THREE.MeshStandardMaterial({
    color: vertexColors ? 0xffffff : new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace),
    vertexColors,
    metalness: 0.05,
    roughness: 0.55,
    // Unknown winding or open shells show both sides.
    side: state.solid && state.ccw !== null ? THREE.FrontSide : THREE.DoubleSide,
    transparent: state.transparency > 0,
    opacity: 1 - state.transparency,
  });
}

/** IndexedFaceSet: polygons split into fans, colored per face or vertex as bound, normals creased like the file asks. */
function faceSet(node: VrmlNode, state: State): THREE.Mesh | null {
  const index = numbers(node, 'coordIndex', []);
  const materialIndex = numbers(node, 'materialIndex', []);
  const binding = state.materialBinding;
  const perVertex = binding.startsWith('PER_VERTEX');
  const perFace = binding.startsWith('PER_FACE') || binding.startsWith('PER_PART');
  const varying = (perVertex || perFace) && state.colors.length > 1;
  const positions: number[] = [];
  const colors: number[] = [];
  const point = (i: number) => [state.points[i * 3], state.points[i * 3 + 1], state.points[i * 3 + 2]];
  const colorAt = (k: number) => state.colors[Math.min(Math.max(k, 0), state.colors.length - 1)] ?? [0.8, 0.8, 0.8];
  let face = 0;
  let corner = 0;
  let polygon: { vertex: number; slot: number; order: number }[] = [];
  const flush = () => {
    for (let k = 1; k + 1 < polygon.length; k++) {
      const corners = state.ccw === false ? [polygon[0], polygon[k + 1], polygon[k]] : [polygon[0], polygon[k], polygon[k + 1]];
      for (const { vertex, slot, order } of corners) {
        if (vertex * 3 + 2 >= state.points.length) continue;
        positions.push(...point(vertex));
        if (!varying) continue;
        if (perFace) colors.push(...colorAt(binding.endsWith('INDEXED') ? (materialIndex[face] ?? face) : face));
        else colors.push(...colorAt(binding.endsWith('INDEXED') ? (materialIndex[slot] ?? slot) : order));
      }
    }
    if (polygon.length) face++;
    polygon = [];
  };
  index.forEach((vertex, slot) => (vertex < 0 ? flush() : polygon.push({ vertex, slot, order: corner++ })));
  flush();
  if (!positions.length) return null;
  let geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  if (colors.length === positions.length) geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors.map(srgbToLinear), 3));
  geometry.applyMatrix4(state.matrix);
  geometry = toCreasedNormals(geometry, state.creaseAngle);
  return new THREE.Mesh(geometry, material(state, colors.length === positions.length));
}

/** Vertex colors are sRGB in the file; three.js works with linear colors (three no longer exports this helper). */
const srgbToLinear = (c: number) => (c < 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function lineSet(node: VrmlNode, state: State): THREE.LineSegments | null {
  const index = numbers(node, 'coordIndex', []);
  const positions: number[] = [];
  for (let i = 0; i + 1 < index.length; i++) {
    const [a, b] = [index[i], index[i + 1]];
    if (a < 0 || b < 0 || b * 3 + 2 >= state.points.length || a * 3 + 2 >= state.points.length) continue;
    positions.push(state.points[a * 3], state.points[a * 3 + 1], state.points[a * 3 + 2], state.points[b * 3], state.points[b * 3 + 1], state.points[b * 3 + 2]);
  }
  if (!positions.length) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.applyMatrix4(state.matrix);
  const [r, g, b] = state.colors[0] ?? [0.2, 0.2, 0.2];
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color: new THREE.Color().setRGB(r, g, b, THREE.SRGBColorSpace) }));
}

function primitive(node: VrmlNode, state: State): THREE.Mesh | null {
  let geometry: THREE.BufferGeometry;
  switch (node.type) {
    case 'Cube':
      geometry = new THREE.BoxGeometry(numbers(node, 'width', [2])[0], numbers(node, 'height', [2])[0], numbers(node, 'depth', [2])[0]);
      break;
    case 'Sphere':
      geometry = new THREE.SphereGeometry(numbers(node, 'radius', [1])[0], 48, 24);
      break;
    case 'Cone':
      geometry = new THREE.ConeGeometry(numbers(node, 'bottomRadius', [1])[0], numbers(node, 'height', [2])[0], 48);
      break;
    case 'Cylinder':
      geometry = new THREE.CylinderGeometry(numbers(node, 'radius', [1])[0], numbers(node, 'radius', [1])[0], numbers(node, 'height', [2])[0], 48);
      break;
    default:
      return null;
  }
  geometry.applyMatrix4(state.matrix);
  return new THREE.Mesh(geometry, material({ ...state, solid: true, ccw: true }, false));
}

function traverse(node: VrmlNode, state: State, group: THREE.Group, depth: number): void {
  if (depth > 256) return;
  const children = (into: THREE.Group, scoped: State) => {
    for (const child of node.children) traverse(child, scoped, into, depth + 1);
  };
  switch (node.type) {
    case 'Separator':
    case 'WWWAnchor': {
      const inner = new THREE.Group();
      inner.name = node.name ?? '';
      children(inner, { ...state, matrix: state.matrix.clone() });
      if (inner.children.length) group.add(inner.children.length === 1 && !node.name ? inner.children[0] : inner);
      return;
    }
    case 'TransformSeparator': {
      const matrix = state.matrix.clone();
      children(group, state);
      state.matrix = matrix;
      return;
    }
    case 'Group':
      children(group, state);
      return;
    case 'Switch': {
      const which = numbers(node, 'whichChild', [-1])[0];
      if (which === -3) children(group, state);
      else if (which >= 0 && node.children[which]) traverse(node.children[which], state, group, depth + 1);
      return;
    }
    case 'LOD':
      // The most detailed level comes first.
      if (node.children[0]) traverse(node.children[0], state, group, depth + 1);
      return;
    case 'Transform':
      state.matrix = state.matrix.clone().multiply(transformMatrix(node));
      return;
    case 'Translation':
    case 'Rotation':
    case 'Scale':
      state.matrix = state.matrix.clone().multiply(transformMatrix(node));
      return;
    case 'MatrixTransform': {
      const values = numbers(node, 'matrix', []);
      // Open Inventor's row-vector matrix read column by column is the column-vector matrix three.js uses.
      if (values.length === 16) state.matrix = state.matrix.clone().multiply(new THREE.Matrix4().fromArray(values));
      return;
    }
    case 'Coordinate3':
      state.points = numbers(node, 'point', []);
      return;
    case 'Material': {
      const diffuse = numbers(node, 'diffuseColor', [0.8, 0.8, 0.8]);
      state.colors = [];
      for (let i = 0; i + 2 < diffuse.length; i += 3) state.colors.push([diffuse[i], diffuse[i + 1], diffuse[i + 2]]);
      state.transparency = numbers(node, 'transparency', [0])[0];
      return;
    }
    case 'MaterialBinding':
      state.materialBinding = word(node, 'value', 'OVERALL');
      return;
    case 'ShapeHints': {
      const ordering = word(node, 'vertexOrdering', 'UNKNOWN_ORDERING');
      state.ccw = ordering === 'COUNTERCLOCKWISE' ? true : ordering === 'CLOCKWISE' ? false : null;
      state.solid = word(node, 'shapeType', 'UNKNOWN_SHAPE_TYPE') === 'SOLID';
      state.creaseAngle = numbers(node, 'creaseAngle', [0.5])[0];
      return;
    }
    case 'IndexedFaceSet': {
      const mesh = faceSet(node, state);
      if (mesh) group.add(mesh);
      return;
    }
    case 'IndexedLineSet': {
      const lines = lineSet(node, state);
      if (lines) group.add(lines);
      return;
    }
    default: {
      const mesh = primitive(node, state);
      if (mesh) group.add(mesh);
    }
  }
}

/** Index just after the bracket that closes the one at `open` ("{" or "["), skipping strings and comments; -1 if none. */
function closing(text: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === '\\') i++;
    } else if (c === '#') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c in pairs) {
      stack.push(pairs[c]);
    } else if (c === stack[stack.length - 1]) {
      stack.pop();
      if (!stack.length) return i + 1;
    }
  }
  return -1;
}

/**
 * VRML 2.0 files from Creo declare PROTOs for metadata (a WorldInfo body that maps no fields). three.js cannot parse
 * PROTO, so such declarations are removed and their instances replaced by the body. PROTOs with IS mappings stay.
 */
export function expandSimpleProtos(text: string): string {
  const bodies = new Map<string, string>();
  let out = text;
  for (let at = out.search(/\bPROTO\s/); at >= 0; at = out.search(/\bPROTO\s/)) {
    const name = /^PROTO\s+([^\s[{]+)/.exec(out.slice(at))?.[1];
    const interfaceStart = out.indexOf('[', at);
    const interfaceEnd = interfaceStart < 0 ? -1 : closing(out, interfaceStart);
    const bodyStart = interfaceEnd < 0 ? -1 : out.indexOf('{', interfaceEnd);
    const bodyEnd = bodyStart < 0 ? -1 : closing(out, bodyStart);
    if (!name || bodyEnd < 0) return text;
    const body = out.slice(bodyStart + 1, bodyEnd - 1).trim();
    if (/\bIS\b/.test(body)) return text;
    bodies.set(name, body);
    out = out.slice(0, at) + out.slice(bodyEnd);
  }
  for (const [name, body] of bodies) {
    const instance = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{`, 'g');
    for (let m = instance.exec(out); m; m = instance.exec(out)) {
      const end = closing(out, m.index + m[0].length - 1);
      if (end < 0) break;
      out = out.slice(0, m.index) + body + out.slice(end);
      instance.lastIndex = m.index + body.length;
    }
  }
  return out;
}

export function parseVrml1(text: string): THREE.Group {
  const root = new THREE.Group();
  const state: State = { matrix: new THREE.Matrix4(), points: [], colors: [], transparency: 0, materialBinding: 'OVERALL', ccw: null, solid: false, creaseAngle: 0.5 };
  for (const node of parse(text)) traverse(node, state, root, 0);
  if (!root.children.length) throw new Error('The VRML 1.0 file contains no shapes.');
  return root;
}
