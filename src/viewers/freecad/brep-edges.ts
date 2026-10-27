// SPDX-License-Identifier: GPL-3.0-or-later
// Edges of an OpenCascade BREP text file (format "CASCADE Topology V1–V3") as line segments, for shapes without faces
// that the CAD kernel could mesh: sketches, wires, lines and circles. Reads the locations, the 3D curves and the
// topology; surfaces, 2D curves and triangulations are skipped.

/** Affine transform, 3×4 row-major: r11 r12 r13 t1, r21 r22 r23 t2, r31 r32 r33 t3. */
type Affine = number[];
type Vec = [number, number, number];

const IDENTITY: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

function multiply(a: Affine, b: Affine): Affine {
  const r: Affine = new Array(12);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 4; j++) {
      r[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + (j === 3 ? a[i * 4 + 3] : 0);
    }
  }
  return r;
}

function invert(m: Affine): Affine {
  const [a, b, c, , d, e, f, , g, h, i] = m;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-300) return IDENTITY;
  const r = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det,
  ];
  const t = [m[3], m[7], m[11]];
  return [
    r[0], r[1], r[2], -(r[0] * t[0] + r[1] * t[1] + r[2] * t[2]),
    r[3], r[4], r[5], -(r[3] * t[0] + r[4] * t[1] + r[5] * t[2]),
    r[6], r[7], r[8], -(r[6] * t[0] + r[7] * t[1] + r[8] * t[2]),
  ];
}

function power(m: Affine, p: number): Affine {
  let base = p < 0 ? invert(m) : m;
  let result = IDENTITY;
  for (let n = Math.abs(p); n > 0; n >>= 1) {
    if (n & 1) result = multiply(result, base);
    base = multiply(base, base);
  }
  return result;
}

const apply = (m: Affine, [x, y, z]: Vec): Vec => [
  m[0] * x + m[1] * y + m[2] * z + m[3],
  m[4] * x + m[5] * y + m[6] * z + m[7],
  m[8] * x + m[9] * y + m[10] * z + m[11],
];

/** Reads whitespace-separated tokens across lines. */
class Tokens {
  private readonly lines: string[];
  private readonly end: number;
  private line: number;
  private parts: string[] = [];
  private pos = 0;
  constructor(lines: string[], start: number, end: number) {
    this.lines = lines;
    this.line = start;
    this.end = end;
  }
  next(): string {
    while (this.pos >= this.parts.length) {
      if (this.line >= this.end) throw new Error('Unexpected end of the BREP data.');
      this.parts = this.lines[this.line++].trim().split(/\s+/).filter(Boolean);
      this.pos = 0;
    }
    return this.parts[this.pos++];
  }
  num(): number {
    return Number(this.next());
  }
  vec(): Vec {
    return [this.num(), this.num(), this.num()];
  }
}

// ---- Curves ------------------------------------------------------------------------------------------------------

interface Curve {
  at(t: number): Vec;
  /** Segments for the range: straight lines need one, B-splines many. */
  segments(first: number, last: number): number;
}

const add = (a: Vec, b: Vec, s = 1): Vec => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const ARC_STEP = Math.PI / 32;
const arcSegments = (first: number, last: number) => Math.min(512, Math.max(2, Math.ceil(Math.abs(last - first) / ARC_STEP)));

/** Conic placed by center, X and Y direction: C + f(t)·X + g(t)·Y. */
function conic(c: Vec, x: Vec, y: Vec, f: (t: number) => number, g: (t: number) => number, segments: Curve['segments']): Curve {
  return { at: (t) => add(add(c, x, f(t)), y, g(t)), segments };
}

/** Rational or polynomial B-spline, also periodic (poles repeat, knots extend by the period as in OpenCascade). */
function bspline(degree: number, poles: Vec[], weights: number[] | null, knots: number[], mults: number[], periodic: boolean): Curve {
  const flat: number[] = [];
  const n = knots.length - 1;
  const period = knots[n] - knots[0];
  if (periodic) {
    const before: number[] = [];
    for (let i = degree + 1 - mults[0], j = n - 1, m = 1; i >= 1; i--) {
      before.unshift(knots[j] - period);
      if (++m > mults[j]) {
        j--;
        m = 1;
      }
    }
    flat.push(...before);
  }
  knots.forEach((k, i) => {
    for (let m = 0; m < mults[i]; m++) flat.push(k);
  });
  if (periodic) {
    for (let i = degree + 1 - mults[n], j = 1, m = 1; i >= 1; i--) {
      flat.push(knots[j] + period);
      if (++m > mults[j]) {
        j++;
        m = 1;
      }
    }
  }
  const count = poles.length;
  return {
    at(t) {
      // Span s with flat[s] <= t < flat[s + 1], inside the valid range.
      let s = degree;
      const top = flat.length - degree - 2;
      while (s < top && t >= flat[s + 1]) s++;
      const d: number[][] = [];
      for (let k = 0; k <= degree; k++) {
        const index = (((s - degree + k) % count) + count) % count;
        const w = weights ? weights[index] : 1;
        const p = poles[index];
        d.push([p[0] * w, p[1] * w, p[2] * w, w]);
      }
      // de Boor in homogeneous coordinates.
      for (let r = 1; r <= degree; r++) {
        for (let j = degree; j >= r; j--) {
          const i = s - degree + j;
          const span = flat[i + degree - r + 1] - flat[i];
          const a = span > 0 ? (t - flat[i]) / span : 0;
          for (let c = 0; c < 4; c++) d[j][c] = (1 - a) * d[j - 1][c] + a * d[j][c];
        }
      }
      const [x, y, z, w] = d[degree];
      return [x / w, y / w, z / w];
    },
    segments: () => Math.min(800, Math.max(16, count * 6)),
  };
}

function bezier(poles: Vec[], weights: number[] | null): Curve {
  return {
    at(t) {
      const d = poles.map((p, i) => {
        const w = weights ? weights[i] : 1;
        return [p[0] * w, p[1] * w, p[2] * w, w];
      });
      for (let r = 1; r < d.length; r++) {
        for (let j = 0; j < d.length - r; j++) for (let c = 0; c < 4; c++) d[j][c] = (1 - t) * d[j][c] + t * d[j + 1][c];
      }
      const [x, y, z, w] = d[0];
      return [x / w, y / w, z / w];
    },
    segments: () => Math.max(16, poles.length * 8),
  };
}

function readCurve(tokens: Tokens): Curve | null {
  const type = tokens.num();
  switch (type) {
    case 1: {
      const p = tokens.vec();
      const d = tokens.vec();
      return { at: (t) => add(p, d, t), segments: () => 1 };
    }
    case 2: {
      const c = tokens.vec();
      tokens.vec();
      const x = tokens.vec();
      const y = tokens.vec();
      const r = tokens.num();
      return conic(c, x, y, (t) => r * Math.cos(t), (t) => r * Math.sin(t), arcSegments);
    }
    case 3: {
      const c = tokens.vec();
      tokens.vec();
      const x = tokens.vec();
      const y = tokens.vec();
      const a = tokens.num();
      const b = tokens.num();
      return conic(c, x, y, (t) => a * Math.cos(t), (t) => b * Math.sin(t), arcSegments);
    }
    case 4: {
      const c = tokens.vec();
      tokens.vec();
      const x = tokens.vec();
      const y = tokens.vec();
      const focal = tokens.num();
      return conic(c, x, y, (t) => (t * t) / (4 * focal || 1), (t) => t, () => 48);
    }
    case 5: {
      const c = tokens.vec();
      tokens.vec();
      const x = tokens.vec();
      const y = tokens.vec();
      const a = tokens.num();
      const b = tokens.num();
      return conic(c, x, y, (t) => a * Math.cosh(t), (t) => b * Math.sinh(t), () => 48);
    }
    case 6: {
      const rational = tokens.num() === 1;
      const degree = tokens.num();
      const poles: Vec[] = [];
      const weights: number[] = [];
      for (let i = 0; i <= degree; i++) {
        poles.push(tokens.vec());
        if (rational) weights.push(tokens.num());
      }
      return bezier(poles, rational ? weights : null);
    }
    case 7: {
      const rational = tokens.num() === 1;
      const periodic = tokens.num() === 1;
      const degree = tokens.num();
      const poleCount = tokens.num();
      const knotCount = tokens.num();
      const poles: Vec[] = [];
      const weights: number[] = [];
      for (let i = 0; i < poleCount; i++) {
        poles.push(tokens.vec());
        if (rational) weights.push(tokens.num());
      }
      const knots: number[] = [];
      const mults: number[] = [];
      for (let i = 0; i < knotCount; i++) {
        knots.push(tokens.num());
        mults.push(tokens.num());
      }
      return bspline(degree, poles, rational ? weights : null, knots, mults, periodic);
    }
    case 8: {
      // Trimmed curve: the edge range already limits it.
      tokens.num();
      tokens.num();
      return readCurve(tokens);
    }
    case 9: {
      const offset = tokens.num();
      const dir = tokens.vec();
      const basis = readCurve(tokens);
      if (!basis) return null;
      return {
        at(t) {
          const h = 1e-6 * Math.max(1, Math.abs(t));
          const a = basis.at(t - h);
          const b = basis.at(t + h);
          const tangent: Vec = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
          const n: Vec = [tangent[1] * dir[2] - tangent[2] * dir[1], tangent[2] * dir[0] - tangent[0] * dir[2], tangent[0] * dir[1] - tangent[1] * dir[0]];
          const length = Math.hypot(...n) || 1;
          return add(basis.at(t), n, offset / length);
        },
        segments: basis.segments,
      };
    }
    default:
      throw new Error(`Unknown curve type ${type} in the BREP data.`);
  }
}

// ---- Topology ----------------------------------------------------------------------------------------------------

interface TShape {
  type: string;
  geometry: string[];
  /** Orientation-free references: written index of the sub-shape and its location number. */
  children: [number, number][];
}

const SECTIONS = /^(Locations|Curve2ds|Curves|Polygon3D|PolygonOnTriangulations|Surfaces|Triangulations|TShapes)\s+(\d+)\s*$/;

/**
 * Edges of the shape as pairs of points (for THREE.LineSegments), with the shape's locations applied: all edges, or
 * with `freeOnly` only those that bound no face (wires and loose edges next to solids). Null when there are none.
 */
export function brepEdgeSegments(text: string, freeOnly = false): Float32Array | null {
  const lines = text.split(/\r?\n/);
  const sections = new Map<string, { start: number; count: number }>();
  for (let i = 0; i < lines.length; i++) {
    const match = SECTIONS.exec(lines[i]);
    if (match) sections.set(match[1], { start: i + 1, count: Number(match[2]) });
  }
  const shapesAt = sections.get('TShapes');
  if (!shapesAt) return null;
  const version = Number(/CASCADE Topology V(\d)/.exec(text.slice(0, 200))?.[1] ?? 1);
  const endOf = (name: string) => {
    const start = sections.get(name)!.start;
    let end = lines.length;
    for (const { start: s } of sections.values()) if (s > start && s - 1 < end) end = s - 1;
    return end;
  };

  // Locations: elementary (a 3×4 matrix) or composite (location number and power pairs up to 0).
  const locations: Affine[] = [IDENTITY];
  if (sections.has('Locations')) {
    const tokens = new Tokens(lines, sections.get('Locations')!.start, endOf('Locations'));
    for (let i = 0; i < sections.get('Locations')!.count; i++) {
      const type = tokens.num();
      if (type === 1) {
        locations.push(Array.from({ length: 12 }, () => tokens.num()));
      } else {
        let location = IDENTITY;
        for (let l = tokens.num(); l !== 0; l = tokens.num()) location = multiply(power(locations[l] ?? IDENTITY, tokens.num()), location);
        locations.push(location);
      }
    }
  }

  // TShapes: type line, geometry up to a blank line, a line of flags, then sub-shape references up to "*".
  const shapes: TShape[] = [];
  let line = shapesAt.start;
  for (let i = 0; i < shapesAt.count; i++) {
    while (line < lines.length && !lines[line].trim()) line++;
    const type = lines[line++]?.trim() ?? '';
    const geometry: string[] = [];
    while (line < lines.length && lines[line].trim()) geometry.push(lines[line++]);
    while (line < lines.length && !lines[line].trim()) line++;
    line++; // flags
    const refs: string[] = [];
    while (line < lines.length && !refs.includes('*')) refs.push(...lines[line++].trim().split(/\s+/).filter(Boolean));
    const children: [number, number][] = [];
    for (let k = 0; k + 1 < refs.length && refs[k] !== '*'; k += 2) children.push([Number(refs[k].slice(1)), Number(refs[k + 1])]);
    shapes.push({ type, geometry, children });
  }
  // The shape itself: orientation, shape number and location after the last TShape.
  const rest = lines.slice(line).join(' ').trim().split(/\s+/).filter(Boolean);
  if (rest.length < 2) return null;
  const count = shapes.length;
  const shapeAt = (number: number) => shapes[count - number];

  // Each edge once per placement: shared edges of a wire appear in two places of the tree.
  const edges: [TShape, Affine][] = [];
  const done = new Set<string>();
  const visit = (number: number, location: Affine, locationKey: string, depth: number) => {
    const shape = shapeAt(number);
    if (!shape || depth > 64 || (freeOnly && shape.type === 'Fa')) return;
    if (shape.type === 'Ed') {
      const key = `${number}@${locationKey}`;
      if (!done.has(key)) edges.push([shape, location]);
      done.add(key);
      return;
    }
    for (const [child, loc] of shape.children) {
      visit(child, loc ? multiply(location, locations[loc] ?? IDENTITY) : location, loc ? `${locationKey}.${loc}` : locationKey, depth + 1);
    }
  };
  visit(Number(rest[0].slice(1)), locations[Number(rest[1])] ?? IDENTITY, rest[1], 0);
  if (!edges.length) return null;

  // The curves are read only now: solids have many, and most of them bound faces.
  const curves: (Curve | null)[] = [null];
  if (sections.has('Curves')) {
    const tokens = new Tokens(lines, sections.get('Curves')!.start, endOf('Curves'));
    for (let i = 0; i < sections.get('Curves')!.count; i++) curves.push(readCurve(tokens));
  }
  const points: number[] = [];

  const addEdge = (edge: TShape, location: Affine) => {
    const head = edge.geometry[0]?.trim().split(/\s+/) ?? [];
    if (head[3] === '1') return; // degenerated
    for (let k = 1; k < edge.geometry.length; k++) {
      const parts = edge.geometry[k].trim().split(/\s+/);
      const type = parts[0];
      if (type === '1') {
        const curve = curves[Number(parts[1])];
        if (!curve) return;
        const transform = multiply(location, locations[Number(parts[2])] ?? IDENTITY);
        const first = Number(parts[3]);
        const last = Number(parts[4]);
        const n = curve.segments(first, last);
        let previous = apply(transform, curve.at(first));
        for (let s = 1; s <= n; s++) {
          const next = apply(transform, curve.at(first + ((last - first) * s) / n));
          points.push(...previous, ...next);
          previous = next;
        }
        return;
      }
      if (type === '0') return;
      // Curves on surfaces carry the UV points of their ends on the next line from format version 2 on.
      if ((type === '2' || type === '3') && version >= 2) k++;
    }
  };

  for (const [edge, location] of edges) addEdge(edge, location);
  return points.length ? new Float32Array(points) : null;
}
