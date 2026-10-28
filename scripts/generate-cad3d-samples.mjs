// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the samples of the FreeCAD and point cloud viewers:
// - cad/bracket.FCStd: a FreeCAD 1.0 style document. Part primitives consumed by booleans (hidden), a plate with two
//   holes in its own face colors, bolts in a group, a transparent cover inside an App::Part with its own placement, a
//   PartDesign body with a hidden sketch and a pad, and a visible sketch (lines and arcs). The shapes are OpenCascade
//   BREP text written here; each is checked by loading it with occt-import-js.
// - 3d/survey-scan.las (LAS 1.2, point format 3, GeoTIFF keys) and 3d/survey-scan.laz (LAS 1.4, point format 7, WKT,
//   compressed): an aerial laser scan of terrain with a road, a pond, a house, trees and a power line, classified,
//   with RGB, intensity and multiple returns.
// Everything is made up here, so the output can be published as CC0-1.0 like the other samples.
// Usage: node scripts/generate-cad3d-samples.mjs (after npm install). No npm package writes LAZ; set LAZ_PYTHON to a
// Python with laspy and lazrs (pip install "laspy[lazrs]") to write the .laz too, otherwise it is left as it is.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..', 'samples');
const written = [];

function write(rel, data) {
  const file = path.join(ROOT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  written.push([rel, Buffer.byteLength(data)]);
}

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; };
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** ZIP with deflated entries and a fixed date (2026-10-27), so the output does not change between runs. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const time = 0x5000; // 10:00:00
  const date = ((2026 - 1980) << 9) | (10 << 5) | 27;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = [u16(20), u16(0x800), u16(8), u16(time), u16(date), u32(crc), u32(packed.length), u32(data.length), u16(nameBytes.length), u16(0)];
    const local = Buffer.concat([u32(0x04034b50), ...head, nameBytes, packed]);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), ...head, u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
}

// ---- OpenCascade BREP writer (format "CASCADE Topology V1", as FreeCAD writes it) ----------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b, s = 1) => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const norm = (a) => scale(a, 1 / Math.hypot(...a));
const num = (v) => (Math.abs(v) < 1e-15 ? '0' : String(Number(v.toPrecision(15))));
const nums = (...v) => v.flat().map(num).join(' ');

/**
 * Topology and geometry as OpenCascade stores them. Shapes are numbered in creation order (children first); the file
 * refers to them counting from the end. Curves on faces (pcurves) are collected while faces are built.
 */
class Brep {
  locations = [];
  curves = [];
  curves2d = [];
  surfaces = [];
  shapes = [];

  location(matrix) {
    this.locations.push(matrix);
    return this.locations.length;
  }
  vertex(p) {
    this.shapes.push({ type: 'Ve', p });
    return this.shapes.length;
  }
  /** Straight edge between two vertices (shape numbers). */
  line(a, b) {
    const pa = this.shapes[a - 1].p;
    const pb = this.shapes[b - 1].p;
    const length = Math.hypot(...sub(pb, pa));
    this.curves.push(`1 ${nums(pa, norm(sub(pb, pa)))}`);
    this.shapes.push({ type: 'Ed', curve: this.curves.length, first: 0, last: length, start: a, end: b, pcurves: [], kind: 'line', origin: pa, dir: norm(sub(pb, pa)) });
    return this.shapes.length;
  }
  /** Circle or arc around `axis` from angle `first` to `last` (radians, measured from `xdir`). */
  arc(center, axis, xdir, radius, first, last, start, end) {
    const ydir = cross(axis, xdir);
    this.curves.push(`2 ${nums(center, axis, xdir, ydir, radius)}`);
    this.shapes.push({ type: 'Ed', curve: this.curves.length, first, last, start, end, pcurves: [], kind: 'circle', center, xdir, ydir, radius });
    return this.shapes.length;
  }
  plane(origin, normal, xdir) {
    const ydir = cross(normal, xdir);
    this.surfaces.push(`1 ${nums(origin, normal, xdir, ydir)}`);
    return { surface: this.surfaces.length, kind: 'plane', origin, xdir, ydir };
  }
  cylinder(origin, axis, xdir, radius) {
    this.surfaces.push(`2 ${nums(origin, axis, xdir, cross(axis, xdir), radius)}`);
    return { surface: this.surfaces.length, kind: 'cylinder' };
  }
  /** The edge's curve in a plane's coordinates, so readers need not compute it. */
  onPlane(edgeNumber, plane) {
    const e = this.shapes[edgeNumber - 1];
    const uv = (p) => [dot(sub(p, plane.origin), plane.xdir), dot(sub(p, plane.origin), plane.ydir)];
    if (e.kind === 'line') this.curves2d.push(`1 ${nums(uv(e.origin), [dot(e.dir, plane.xdir), dot(e.dir, plane.ydir)])}`);
    else this.curves2d.push(`2 ${nums(uv(e.center), [dot(e.xdir, plane.xdir), dot(e.xdir, plane.ydir)], [dot(e.ydir, plane.xdir), dot(e.ydir, plane.ydir)], e.radius)}`);
    e.pcurves.push(`2  ${this.curves2d.length} ${plane.surface} 0 ${nums(e.first, e.last)}`);
  }
  /** A 2D line on a cylinder (u = angle, v = height): circles are v = const, the seam u = const (twice). */
  onCylinder(edgeNumber, cylinder, lines) {
    const e = this.shapes[edgeNumber - 1];
    const ids = lines.map(([o, d]) => {
      this.curves2d.push(`1 ${nums(o, d)}`);
      return this.curves2d.length;
    });
    e.pcurves.push(ids.length === 1 ? `2  ${ids[0]} ${cylinder.surface} 0 ${nums(e.first, e.last)}` : `3  ${ids[0]} ${ids[1]}CN ${cylinder.surface} 0 ${nums(e.first, e.last)}`);
  }
  /** Container shapes: children as [shape number, reversed?]. */
  group(type, children) {
    this.shapes.push({ type, children });
    return this.shapes.length;
  }
  face(surface, wires) {
    this.shapes.push({ type: 'Fa', surface: surface.surface, children: wires.map((w) => [w, false]) });
    return this.shapes.length;
  }

  write(root, rootLocation = 0) {
    const n = this.shapes.length;
    const ref = (number, reversed) => `${reversed ? '-' : '+'}${n - number + 1} 0`;
    const out = ['', 'CASCADE Topology V1, (c) Matra-Datavision', `Locations ${this.locations.length}`];
    for (const m of this.locations) out.push('1', ...[0, 1, 2].map((r) => `${nums(m.slice(r * 4, r * 4 + 4))} `));
    out.push(`Curve2ds ${this.curves2d.length}`, ...this.curves2d, `Curves ${this.curves.length}`, ...this.curves);
    out.push('Polygon3D 0', 'PolygonOnTriangulations 0', `Surfaces ${this.surfaces.length}`, ...this.surfaces, 'Triangulations 0', '', `TShapes ${n}`);
    for (const s of this.shapes) {
      out.push(s.type);
      if (s.type === 'Ve') out.push('1e-07', nums(s.p), '0 0', '', '0101101', '*');
      else if (s.type === 'Ed') {
        const closed = s.start === s.end;
        out.push(' 1e-07 1 1 0', `1  ${s.curve} 0 ${nums(s.first, s.last)}`, ...s.pcurves, '0', '', closed ? '0101100' : '0101000', `${ref(s.start, false)} ${ref(s.end, true)} *`);
      } else {
        if (s.type === 'Fa') out.push(`0  1e-07 ${s.surface} 0`);
        out.push('', { Wi: '0101100', Fa: '0101000', Sh: '0101100', So: '0100000', Co: '0100000' }[s.type], `${s.children.map(([c, r]) => ref(c, r)).join(' ')} *`);
      }
    }
    out.push('', `+${n - root + 1} ${rootLocation}`, '');
    return out.join('\n');
  }
}

/** Wire from edges walked from vertex to vertex: each edge is used forward when it starts where the last one ended. */
function loop(brep, edges, startVertex) {
  let at = startVertex;
  const children = edges.map((e) => {
    const edge = brep.shapes[e - 1];
    const reversed = edge.start !== at;
    at = reversed ? edge.start : edge.end;
    return [e, reversed];
  });
  return brep.group('Wi', children);
}

/**
 * Prism: a polygon (counterclockwise in the frame's x/y) extruded along the frame normal, with round holes through it.
 * Every face gets its outward normal; holes are cylinder faces turned inside out. Returns the solid's shape number.
 */
function prism(brep, frame, polygon, height, holes = []) {
  const { o, x, y } = frame;
  const n = cross(x, y);
  const at = ([u, v], h = 0) => add(add(add(o, x, u), y, v), n, h);
  const bottom = polygon.map((p) => brep.vertex(at(p)));
  const top = polygon.map((p) => brep.vertex(at(p, height)));
  const k = polygon.length;
  const eb = bottom.map((v, i) => brep.line(v, bottom[(i + 1) % k]));
  const et = top.map((v, i) => brep.line(v, top[(i + 1) % k]));
  const ev = bottom.map((v, i) => brep.line(v, top[i]));
  const holeShapes = holes.map(({ c, r }) => {
    const center = at(c);
    const vb = brep.vertex(add(center, x, r));
    const vt = brep.vertex(add(add(center, x, r), n, height));
    const cb = brep.arc(center, n, x, r, 0, 2 * Math.PI, vb, vb);
    const ct = brep.arc(add(center, n, height), n, x, r, 0, 2 * Math.PI, vt, vt);
    const seam = brep.line(vb, vt);
    return { center, r, vb, vt, cb, ct, seam };
  });
  const faces = [];
  // Bottom, seen from below: the polygon runs clockwise there, holes counterclockwise.
  const bottomPlane = brep.plane(o, scale(n, -1), x);
  for (const e of eb) brep.onPlane(e, bottomPlane);
  for (const hole of holeShapes) brep.onPlane(hole.cb, bottomPlane);
  faces.push([brep.face(bottomPlane, [loop(brep, [...eb].reverse(), bottom[0]), ...holeShapes.map((hs) => brep.group('Wi', [[hs.cb, false]]))]), false]);
  const topPlane = brep.plane(at([0, 0], height), n, x);
  for (const e of et) brep.onPlane(e, topPlane);
  for (const hole of holeShapes) brep.onPlane(hole.ct, topPlane);
  faces.push([brep.face(topPlane, [loop(brep, et, top[0]), ...holeShapes.map((hs) => brep.group('Wi', [[hs.ct, true]]))]), false]);
  for (let i = 0; i < k; i++) {
    const d = norm(sub(at(polygon[(i + 1) % k]), at(polygon[i])));
    const side = brep.plane(at(polygon[i]), cross(d, n), d);
    for (const e of [eb[i], ev[(i + 1) % k], et[i], ev[i]]) brep.onPlane(e, side);
    faces.push([brep.face(side, [loop(brep, [eb[i], ev[(i + 1) % k], et[i], ev[i]], bottom[i])]), false]);
  }
  for (const hs of holeShapes) faces.push([cylinderFace(brep, hs, n, x, height), true]);
  return brep.group('So', [[brep.group('Sh', faces), false]]);
}

/** Side of a cylinder: u along the circle, v along the axis; the seam is its left and right border. */
function cylinderFace(brep, { center, r, cb, ct, seam }, axis, xdir, height) {
  const surface = brep.cylinder(center, axis, xdir, r);
  brep.onCylinder(cb, surface, [[[0, 0], [1, 0]]]);
  brep.onCylinder(ct, surface, [[[0, height], [1, 0]]]);
  brep.onCylinder(seam, surface, [[[2 * Math.PI, 0], [0, 1]], [[0, 0], [0, 1]]]);
  return brep.face(surface, [brep.group('Wi', [[cb, false], [seam, false], [ct, true], [seam, true]])]);
}

/** Solid cylinder standing on `center`, axis +Z. */
function cylinderSolid(brep, center, r, height) {
  const axis = [0, 0, 1];
  const xdir = [1, 0, 0];
  const vb = brep.vertex(add(center, xdir, r));
  const vt = brep.vertex(add(add(center, xdir, r), axis, height));
  const cb = brep.arc(center, axis, xdir, r, 0, 2 * Math.PI, vb, vb);
  const ct = brep.arc(add(center, axis, height), axis, xdir, r, 0, 2 * Math.PI, vt, vt);
  const seam = brep.line(vb, vt);
  const side = cylinderFace(brep, { center, r, cb, ct, seam }, axis, xdir, height);
  const bottomPlane = brep.plane(center, [0, 0, -1], xdir);
  brep.onPlane(cb, bottomPlane);
  const topPlane = brep.plane(add(center, axis, height), axis, xdir);
  brep.onPlane(ct, topPlane);
  const bottom = brep.face(bottomPlane, [brep.group('Wi', [[cb, true]])]);
  const top = brep.face(topPlane, [brep.group('Wi', [[ct, false]])]);
  return brep.group('So', [[brep.group('Sh', [[side, false], [bottom, false], [top, false]]), false]]);
}

/** Placement as the 3×4 matrix of a BREP location: rotation about Z by `degrees`, then translation. */
function placementMatrix([x, y, z], degrees = 0, axis = 'z') {
  const c = Math.cos((degrees * Math.PI) / 180);
  const s = Math.sin((degrees * Math.PI) / 180);
  if (axis === 'x') return [1, 0, 0, x, 0, c, -s, y, 0, s, c, z];
  return [c, -s, 0, x, s, c, 0, y, 0, 0, 1, z];
}

// ---- The FreeCAD document ----------------------------------------------------------------------------------------

const PLATE = { size: [80, 50, 8], holes: [{ c: [20, 25], r: 5 }, { c: [60, 25], r: 5 }] };
const RECT = (w, d) => [[0, 0], [w, 0], [w, d], [0, d]];
const XY = { o: [0, 0, 0], x: [1, 0, 0], y: [0, 1, 0] };
const L_PROFILE = [[0, 0], [40, 0], [40, 6], [6, 6], [6, 30], [0, 30]];
// The bracket's profile lies in the XZ plane at y = 50 and is padded 50 mm towards −Y.
const XZ = { o: [0, 50, 0], x: [1, 0, 0], y: [0, 0, 1] };

/** Each shape: its BREP and what occt-import-js must find (faces, volume, bounding box), or null for wires. */
function shapes() {
  const list = {};
  const solid = (name, build, check, location) => {
    const brep = new Brep();
    const root = build(brep);
    list[name] = { text: brep.write(root, location ? brep.location(location) : 0), check };
  };
  solid('Box', (b) => prism(b, XY, RECT(80, 50), 8), { faces: 6, volume: 80 * 50 * 8, box: [[0, 0, 0], [80, 50, 8]] });
  for (const [name, [x, y]] of [['Cylinder', PLATE.holes[0].c], ['Cylinder001', PLATE.holes[1].c]]) {
    solid(name, (b) => cylinderSolid(b, [0, 0, 0], 5, 8), { faces: 3, volume: Math.PI * 25 * 8, box: [[x - 5, y - 5, 0], [x + 5, y + 5, 8]] }, placementMatrix([x, y, 0]));
  }
  solid('Fusion', (b) => b.group('Co', PLATE.holes.map(({ c }) => [cylinderSolid(b, [c[0], c[1], 0], 5, 8), false])), { faces: 6, volume: 2 * Math.PI * 25 * 8, box: [[15, 20, 0], [65, 30, 8]] });
  solid('Cut', (b) => prism(b, XY, RECT(80, 50), 8, PLATE.holes), { faces: 8, volume: 80 * 50 * 8 - 2 * Math.PI * 25 * 8, box: [[0, 0, 0], [80, 50, 8]] });
  for (const [name, [x, y]] of [['Bolt', PLATE.holes[0].c], ['Bolt001', PLATE.holes[1].c]]) {
    solid(name, (b) => cylinderSolid(b, [0, 0, 0], 4, 20), { faces: 3, volume: Math.PI * 16 * 20, box: [[x - 4, y - 4, -6], [x + 4, y + 4, 14]] }, placementMatrix([x, y, -6]));
  }
  // Inside the App::Part: the shape has the box's own placement, not the part's.
  solid('Cover', (b) => prism(b, XY, RECT(80, 50), 3), { faces: 6, volume: 80 * 50 * 3, box: [[0, 0, 4], [80, 50, 7]] }, placementMatrix([0, 0, 4]));
  // PartDesign: the pad in body coordinates, the body's shape with the body's placement.
  solid('Pad', (b) => prism(b, XZ, L_PROFILE, 50), { faces: 8, volume: 384 * 50, box: [[0, 0, 0], [40, 50, 30]] });
  solid('Body', (b) => prism(b, XZ, L_PROFILE, 50), { faces: 8, volume: 384 * 50, box: [[95, 0, 0], [135, 50, 30]] }, placementMatrix([95, 0, 0]));

  // Sketches: wires only, in sketch coordinates, placed by the sketch's placement.
  const wires = (name, build, location) => {
    const brep = new Brep();
    list[name] = { text: brep.write(build(brep), brep.location(location)), check: null };
  };
  wires('Sketch', (b) => {
    const v = L_PROFILE.map(([u, w]) => b.vertex([u, w, 0]));
    const edges = v.map((a, i) => b.line(a, v[(i + 1) % v.length]));
    return loop(b, edges, v[0]);
  }, placementMatrix([0, 50, 0], 90, 'x'));
  wires('Sketch001', (b) => {
    // A slot (two lines, two half circles) and a circle, around the sketch origin.
    const [a, c, d, e] = [[-7, -15], [7, -15], [7, 15], [-7, 15]].map(([u, w]) => b.vertex([u, w, 0]));
    const slot = [b.line(a, c), b.arc([0, 15, 0], [0, 0, 1], [1, 0, 0], 7, 0, Math.PI, d, e), b.line(e, a)];
    const right = b.line(c, d);
    const bottom = b.arc([0, -15, 0], [0, 0, 1], [1, 0, 0], 7, Math.PI, 2 * Math.PI, a, c);
    const ring = b.vertex([3, 0, 0]);
    const circle = b.arc([0, 0, 0], [0, 0, 1], [1, 0, 0], 3, 0, 2 * Math.PI, ring, ring);
    return b.group('Co', [[loop(b, [bottom, right, slot[1], slot[2]], a), false], [b.group('Wi', [[circle, false]]), false]]);
  }, placementMatrix([-25, 25, 0]));
  return list;
}

async function checkShapes(list) {
  const require = createRequire(import.meta.url);
  const occtPath = require.resolve('occt-import-js');
  const occt = await require(occtPath)({ locateFile: (f) => path.join(path.dirname(occtPath), f) });
  for (const [name, { text, check }] of Object.entries(list)) {
    const result = occt.ReadFile('brep', new TextEncoder().encode(text), { linearUnit: 'millimeter', linearDeflectionType: 'bounding_box_ratio', linearDeflection: 0.001, angularDeflection: 0.5 });
    if (!result.success) throw new Error(`${name}: OpenCascade cannot read the BREP.`);
    if (!check) continue;
    let faces = 0;
    let volume = 0;
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const m of result.meshes) {
      faces += m.brep_faces.filter((f) => f.last >= f.first).length;
      const p = m.attributes.position.array;
      const ix = m.index.array;
      for (let i = 0; i < ix.length; i += 3) {
        const [a, b, c] = [ix[i], ix[i + 1], ix[i + 2]].map((k) => [p[k * 3], p[k * 3 + 1], p[k * 3 + 2]]);
        volume += dot(a, cross(b, c)) / 6;
      }
      for (let i = 0; i < p.length; i++) {
        min[i % 3] = Math.min(min[i % 3], p[i]);
        max[i % 3] = Math.max(max[i % 3], p[i]);
      }
    }
    // Round faces are polygons in the mesh: they may stay a little inside the exact box.
    const tolerance = 0.005 * Math.max(...check.box[1].map((v, i) => v - check.box[0][i]));
    const boxOk = [min, max].every((corner, k) => corner.every((v, i) => Math.abs(v - check.box[k][i]) < tolerance));
    if (faces !== check.faces || Math.abs(volume - check.volume) > check.volume * 0.01 || !boxOk) {
      throw new Error(`${name}: ${faces} faces, volume ${volume.toFixed(1)}, box ${min.map(num)} … ${max.map(num)}; expected ${check.faces}, ${check.volume.toFixed(1)}, ${check.box}`);
    }
  }
}

/** ShapeAppearance (PropertyMaterialList, version 3): materials with packed colors, then three strings each. */
function appearance(colors, transparency = 0) {
  // FreeCAD before 1.1 stores transparency, not alpha, in the low byte: 0 is opaque.
  const packed = (hex) => (hex << 8) >>> 0;
  const parts = [u32(colors.length)];
  for (const hex of colors) parts.push(u32(packed(0x333333)), u32(packed(hex)), u32(packed(0x888888)), u32(0), f32(0.2), f32(transparency));
  for (let i = 0; i < colors.length * 3; i++) parts.push(u32(0));
  return Buffer.concat(parts);
}

const property = (name, type, body) => `                <Property name="${name}" type="${type}">\n                    ${body}\n                </Property>`;
const str = (name, value) => property(name, 'App::PropertyString', `<String value="${escapeXml(value)}"/>`);
const bool = (name, value) => property(name, 'App::PropertyBool', `<Bool value="${value}"/>`);
const length = (name, value) => property(name, 'App::PropertyLength', `<Float value="${value}"/>`);
const link = (name, value) => property(name, 'App::PropertyLink', `<Link value="${value}"/>`);
const links = (name, values) => property(name, 'App::PropertyLinkList', `<LinkList count="${values.length}">\n${values.map((v) => `                        <Link value="${v}"/>`).join('\n')}\n                    </LinkList>`);
function placement(name, [x, y, z], rotation = [0, 0, 0, 1]) {
  const [q0, q1, q2, q3] = rotation;
  const angle = 2 * Math.acos(Math.min(1, q3));
  const s = Math.sqrt(1 - q3 * q3) || 1;
  const axis = angle ? [q0 / s, q1 / s, q2 / s] : [0, 0, 1];
  return property(name, 'App::PropertyPlacement', `<PropertyPlacement Px="${num(x)}" Py="${num(y)}" Pz="${num(z)}" Q0="${num(q0)}" Q1="${num(q1)}" Q2="${num(q2)}" Q3="${num(q3)}" A="${num(angle)}" Ox="${num(axis[0])}" Oy="${num(axis[1])}" Oz="${num(axis[2])}"/>`);
}
const shape = (file) => property('Shape', 'Part::PropertyPartShape', `<Part ElementMap="" file="${file}"/>`);

function fcstd() {
  const list = shapes();
  const half = Math.SQRT1_2;
  // [name, type, label, extensions, properties, visible, view properties]
  const objects = [
    ['Box', 'Part::Box', 'Plate stock', [], [length('Length', 80), length('Width', 50), length('Height', 8), placement('Placement', [0, 0, 0]), shape('Box.Shape.brp')], false],
    ['Cylinder', 'Part::Cylinder', 'Hole cutter', [], [length('Radius', 5), length('Height', 8), placement('Placement', [20, 25, 0]), shape('Cylinder.Shape.brp')], false],
    ['Cylinder001', 'Part::Cylinder', 'Hole cutter 2', [], [length('Radius', 5), length('Height', 8), placement('Placement', [60, 25, 0]), shape('Cylinder001.Shape.brp')], false],
    ['Fusion', 'Part::MultiFuse', 'Hole cutters', [], [links('Shapes', ['Cylinder', 'Cylinder001']), placement('Placement', [0, 0, 0]), shape('Fusion.Shape.brp')], false],
    ['Cut', 'Part::Cut', 'Base plate', [], [link('Base', 'Box'), link('Tool', 'Fusion'), placement('Placement', [0, 0, 0]), shape('Cut.Shape.brp')], true],
    ['Fasteners', 'App::DocumentObjectGroup', 'Fasteners', ['App::GroupExtension'], [links('Group', ['Bolt', 'Bolt001'])], true],
    ['Bolt', 'Part::Cylinder', 'Bolt 1', [], [length('Radius', 4), length('Height', 20), placement('Placement', [20, 25, -6]), shape('Bolt.Shape.brp')], true],
    ['Bolt001', 'Part::Cylinder', 'Bolt 2', [], [length('Radius', 4), length('Height', 20), placement('Placement', [60, 25, -6]), shape('Bolt001.Shape.brp')], true],
    // Turned by 180° about Z and lifted: the cover still ends up right above the plate.
    ['Part', 'App::Part', 'Cover assembly', ['App::OriginGroupExtension'], [links('Group', ['Cover']), placement('Placement', [80, 50, 20], [0, 0, 1, 0])], true],
    ['Cover', 'Part::Box', 'Cover', [], [length('Length', 80), length('Width', 50), length('Height', 3), placement('Placement', [0, 0, 4]), shape('Cover.Shape.brp')], true],
    ['Body', 'PartDesign::Body', 'Angle bracket', ['App::OriginGroupExtension'], [links('Group', ['Sketch', 'Pad']), link('Origin', 'Origin'), link('Tip', 'Pad'), placement('Placement', [95, 0, 0]), shape('Body.Shape.brp')], true],
    ['Origin', 'App::Origin', 'Origin', ['App::GeoFeatureGroupExtension'], [links('Group', []), placement('Placement', [0, 0, 0])], false],
    ['Sketch', 'Sketcher::SketchObject', 'Bracket profile', [], [placement('Placement', [0, 50, 0], [half, 0, 0, half]), shape('Sketch.Shape.brp')], false],
    ['Pad', 'PartDesign::Pad', 'Pad', [], [link('Profile', 'Sketch'), length('Length', 50), placement('Placement', [0, 0, 0]), shape('Pad.Shape.brp')], true],
    ['Sketch001', 'Sketcher::SketchObject', 'Slot outline', [], [placement('Placement', [-25, 25, 0]), shape('Sketch001.Shape.brp')], true],
  ];
  const view = {
    Cut: { colors: [0x8c9bad, 0x8c9bad, 0x8c9bad, 0x8c9bad, 0x8c9bad, 0x8c9bad, 0xe8913a, 0xe8913a] },
    Bolt: { colors: [0xc9a227] },
    Bolt001: { colors: [0xc9a227] },
    Cover: { colors: [0x4a90d9], transparency: 0.6 },
    Pad: { colors: [0x6e9c7f] },
    Body: { colors: [0x6e9c7f] },
  };

  const objectXml = objects.map(([name, type, label, extensions, props, visible]) => {
    const ext = extensions.length
      ? `\n            <Extensions Count="${extensions.length}">\n${extensions.map((e) => `                <Extension type="${e}" name="${e.split('::')[1]}">\n                </Extension>`).join('\n')}\n            </Extensions>`
      : '';
    const all = [str('Label', label), ...props, bool('Visibility', visible)].sort((a, b) => /name="([^"]+)"/.exec(a)[1].localeCompare(/name="([^"]+)"/.exec(b)[1]));
    return `        <Object name="${name}"${extensions.length ? ' Extensions="True"' : ''}>${ext}\n            <Properties Count="${all.length}" TransientCount="0">\n${all.join('\n')}\n            </Properties>\n        </Object>`;
  });
  const documentXml = `<?xml version='1.0' encoding='utf-8'?>
<!--
 FreeCAD Document, see https://www.freecad.org for more information...
 Sample written by scripts/generate-cad3d-samples.mjs, not by FreeCAD.
-->
<Document SchemaVersion="4" ProgramVersion="1.0.2R39319 (Git)" FileVersion="1" StringHasher="1">
    <Properties Count="9" TransientCount="0">
${[str('Comment', 'Sample document: Part primitives, booleans, a group, an App::Part, a PartDesign body and sketches.'), str('Company', ''), str('CreatedBy', ''), str('CreationDate', '2026-10-27T10:00:00Z'), str('Label', 'Bracket'), str('LastModifiedBy', ''), str('LastModifiedDate', '2026-10-27T10:00:00Z'), str('License', 'CC0-1.0'), str('Uid', '7c1d6f0e-3b8a-4f52-9e61-2a4d8c0b5e13')].join('\n')}
    </Properties>
    <Objects Count="${objects.length}" Dependencies="1">
${objects.map(([name, type], i) => `        <Object type="${type}" name="${name}" id="${i + 1}"/>`).join('\n')}
    </Objects>
    <ObjectData Count="${objects.length}">
${objectXml.join('\n')}
    </ObjectData>
</Document>
`;

  const files = [];
  let materials = 0;
  const viewXml = objects.map(([name, type, , , , visible]) => {
    const props = [bool('Visibility', visible)];
    const style = view[name];
    if (type.startsWith('Part::') || type.startsWith('PartDesign::')) {
      const file = `ShapeAppearance${materials++ || ''}`;
      files.push([file, appearance(style?.colors ?? [0xcccccc], style?.transparency ?? 0)]);
      props.push(property('ShapeAppearance', 'App::PropertyMaterialList', `<MaterialList file="${file}" version="3"/>`));
      props.push(property('Transparency', 'App::PropertyPercent', `<Integer value="${Math.round((style?.transparency ?? 0) * 100)}"/>`));
      props.push(property('LineColor', 'App::PropertyColor', '<PropertyColor value="421075200"/>'));
    }
    if (type === 'Sketcher::SketchObject') props.push(property('LineColor', 'App::PropertyColor', '<PropertyColor value="4294967040"/>'));
    if (type === 'PartDesign::Body') props.push(property('DisplayModeBody', 'App::PropertyEnumeration', '<Integer value="0"/>'));
    props.sort((a, b) => /name="([^"]+)"/.exec(a)[1].localeCompare(/name="([^"]+)"/.exec(b)[1]));
    return `        <ViewProvider name="${name}" expanded="0">\n            <Properties Count="${props.length}" TransientCount="0">\n${props.join('\n')}\n            </Properties>\n        </ViewProvider>`;
  });
  const guiXml = `<?xml version='1.0' encoding='utf-8'?>
<!--
 FreeCAD Document, see https://www.freecad.org for more information...
-->
<Document SchemaVersion="1" HasExpansion="0">
    <ViewProviderData Count="${objects.length}">
${viewXml.join('\n')}
    </ViewProviderData>
    <Camera settings=""/>
</Document>
`;
  const breps = Object.entries(list).map(([name, { text }]) => [`${name}.Shape.brp`, Buffer.from(text)]);
  return { list, data: zip([['Document.xml', Buffer.from(documentXml)], ['GuiDocument.xml', Buffer.from(guiXml)], ...breps, ...files]) };
}

// ---- Laser scan ----------------------------------------------------------------------------------------------------

/** Deterministic pseudo-random numbers (mulberry32). */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Projected coordinates in ETRS89 / UTM zone 32N, somewhere in open country. */
const ORIGIN = [512300, 5823400];
const AREA = [120, 90];

/**
 * Points of a scan: x, y, z in meters, class, RGB (8 bit), intensity (16 bit), return number and count, scan time.
 * `density` points per square meter on open ground.
 */
function scan(density, seed) {
  const rnd = random(seed);
  const gauss = () => (rnd() + rnd() + rnd() - 1.5) * 0.8;
  const points = [];
  const ground = (x, y) => 38 + 1.6 * Math.sin(x / 23) + 1.1 * Math.cos(y / 17) + 0.004 * x * y / 10;
  const pond = { c: [92, 22], r: [16, 10] };
  const inPond = (x, y) => ((x - pond.c[0]) / pond.r[0]) ** 2 + ((y - pond.c[1]) / pond.r[1]) ** 2 < 1;
  const road = (x) => 58 + 14 * Math.sin(x / 30);
  const house = { x: [22, 42], y: [52, 64], eave: 6, ridge: 9.5 };
  const inHouse = (x, y) => x > house.x[0] && x < house.x[1] && y > house.y[0] && y < house.y[1];
  const base = ground(32, 58);
  const trees = [];
  while (trees.length < 26) {
    const t = { x: 6 + rnd() * 108, y: 6 + rnd() * 78, h: 7 + rnd() * 9, r: 2.2 + rnd() * 2.6 };
    const clear = !inPond(t.x, t.y) && Math.abs(t.y - road(t.x)) > 6 && !(t.x > 16 && t.x < 48 && t.y > 46 && t.y < 70) && t.y < 80;
    if (clear && trees.every((o) => Math.hypot(o.x - t.x, o.y - t.y) > o.r + t.r)) trees.push(t);
  }
  const canopy = (x, y) => trees.find((t) => Math.hypot(x - t.x, y - t.y) < t.r);
  // Colors vary a little from point to point, in steps of 2 (scanner colors are never that smooth).
  const shade = (c, f) => c.map((v) => Math.max(0, Math.min(255, 2 * Math.round((v * (1 + (f - 1) * 0.4)) / 2))));
  let time = 0;
  // Intensities in steps of 256, as from a scanner with 8-bit intensities.
  const push = (x, y, z, cls, rgb, intensity, ret = 1, of = 1) => points.push({ x, y, z, cls, rgb, intensity: Math.max(0, Math.min(65280, Math.round(intensity / 256) * 256)), ret, of, time: (time += 0.00001) });

  // Ground, road, pond and roofs: one sample per cell of the scan pattern, jittered.
  const step = 1 / Math.sqrt(density);
  for (let y = 0; y < AREA[1]; y += step) {
    for (let x = 0; x < AREA[0]; x += step) {
      const px = x + (rnd() - 0.5) * step;
      const py = y + (rnd() - 0.5) * step;
      const gz = ground(px, py) + gauss() * 0.03;
      const tree = canopy(px, py);
      if (inHouse(px, py)) {
        // Gable roof along x, ridge in the middle of y.
        const t = Math.abs(py - (house.y[0] + house.y[1]) / 2) / ((house.y[1] - house.y[0]) / 2);
        const z = base + house.ridge - (house.ridge - house.eave) * t + gauss() * 0.02;
        push(px, py, z, 6, shade([168, 72, 52], 0.85 + rnd() * 0.25), 14000 + rnd() * 6000);
      } else if (tree) {
        const d = Math.hypot(px - tree.x, py - tree.y) / tree.r;
        const top = ground(tree.x, tree.y) + tree.h;
        const crown = top - tree.r * 1.4 * d * d - rnd() * 0.8;
        const green = shade([58, 110, 48], 0.75 + rnd() * 0.5);
        if (rnd() < 0.3) {
          push(px, py, crown, 5, green, 9000 + rnd() * 9000, 1, 3);
          push(px, py, crown - 1.5 - rnd() * (crown - gz - 2), 4, shade(green, 0.8), 6000 + rnd() * 6000, 2, 3);
          push(px, py, gz, 2, shade([96, 84, 58], 0.8 + rnd() * 0.3), 7000 + rnd() * 5000, 3, 3);
        } else if (rnd() < 0.5) {
          push(px, py, crown, 5, green, 10000 + rnd() * 9000, 1, 2);
          push(px, py, gz, 2, shade([96, 84, 58], 0.8 + rnd() * 0.3), 7000 + rnd() * 5000, 2, 2);
        } else {
          push(px, py, crown, 5, green, 11000 + rnd() * 9000);
        }
      } else if (inPond(px, py)) {
        // Water returns little light: fewer points, low intensity.
        if (rnd() < 0.35) push(px, py, ground(pond.c[0], pond.c[1]) - 0.8 + gauss() * 0.01, 9, shade([46, 92, 128], 0.9 + rnd() * 0.2), 1500 + rnd() * 1500);
      } else if (Math.abs(py - road(px)) < 3) {
        push(px, py, gz - 0.05, 11, shade([118, 118, 112], 0.85 + rnd() * 0.25), 30000 + rnd() * 8000);
      } else {
        const meadow = 0.5 + 0.5 * Math.sin(px / 9) * Math.cos(py / 7);
        const rgb = [104 + 40 * meadow, 128 + 20 * meadow, 64 + 10 * meadow];
        const low = rnd() < 0.08;
        push(px, py, gz + (low ? 0.2 + rnd() * 0.5 : 0), low ? 3 : 2, shade(rgb, 0.8 + rnd() * 0.35), 18000 + rnd() * 9000);
      }
    }
  }
  // Walls, seen at an angle near the edges of the swath.
  for (let i = 0; i < density * 60; i++) {
    const side = Math.floor(rnd() * 4);
    const along = rnd();
    const x = side < 2 ? house.x[0] + along * 20 : house.x[side - 2];
    const y = side < 2 ? house.y[side] : house.y[0] + along * 12;
    push(x, y, base + rnd() * house.eave, 6, shade([214, 206, 188], 0.85 + rnd() * 0.2), 20000 + rnd() * 5000);
  }
  // Two poles and three sagging wires across the meadow.
  const poles = [[8, 86], [112, 84]];
  for (const [x, y] of poles) {
    for (let z = 0; z < 11; z += 0.15) push(x + gauss() * 0.05, y + gauss() * 0.05, ground(x, y) + z, 15, [96, 82, 64], 12000 + rnd() * 3000);
  }
  for (const offset of [-0.8, 0, 0.8]) {
    for (let t = 0; t <= 1; t += 1 / (density * 40)) {
      const x = poles[0][0] + (poles[1][0] - poles[0][0]) * t;
      const y = poles[0][1] + (poles[1][1] - poles[0][1]) * t + offset;
      const z = ground(poles[0][0], poles[0][1]) * (1 - t) + ground(poles[1][0], poles[1][1]) * t + 10.5 - 3.2 * 4 * t * (1 - t);
      push(x, y, z, 14, [60, 60, 64], 4000 + rnd() * 2000, 1, 2);
    }
  }
  // Noise: birds high above, multipath below ground.
  for (let i = 0; i < 12; i++) push(rnd() * 120, rnd() * 90, 62 + rnd() * 14, 18, [200, 200, 200], 1000 + rnd() * 2000);
  for (let i = 0; i < 12; i++) {
    const x = rnd() * 120;
    const y = rnd() * 90;
    push(x, y, ground(x, y) - 3 - rnd() * 4, 7, [90, 90, 90], 500 + rnd() * 800);
  }
  return points;
}

const WKT = 'PROJCS["ETRS89 / UTM zone 32N",GEOGCS["ETRS89",DATUM["European_Terrestrial_Reference_System_1989",SPHEROID["GRS 1980",6378137,298.257222101]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",9],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","25832"]]';

function fixed(text, size) {
  const b = Buffer.alloc(size);
  b.write(text, 'latin1');
  return b;
}

function vlr(user, id, description, body) {
  return Buffer.concat([u16(0), fixed(user, 16), u16(id), u16(body.length), fixed(description, 32), body]);
}

/** LAS 1.2 with point format 3, or LAS 1.4 with point format 7; coordinates in millimeters. */
function las(points, version) {
  const modern = version === '1.4';
  const format = modern ? 7 : 3;
  const recordLength = modern ? 36 : 34;
  const headerSize = modern ? 375 : 227;
  const scaleXyz = [0.001, 0.001, 0.001];
  const offset = [ORIGIN[0], ORIGIN[1], 0];
  const world = points.map((p) => [p.x + ORIGIN[0], p.y + ORIGIN[1], p.z]);
  const min = [0, 1, 2].map((k) => world.reduce((m, w) => Math.min(m, w[k]), Infinity));
  const max = [0, 1, 2].map((k) => world.reduce((m, w) => Math.max(m, w[k]), -Infinity));
  const vlrs = modern
    ? [vlr('LASF_Projection', 2112, 'OGC WKT coordinate system', Buffer.from(`${WKT}\0`, 'latin1'))]
    : [vlr('LASF_Projection', 34735, 'GeoKeyDirectoryTag', Buffer.concat([1, 1, 0, 3, 1024, 0, 1, 1, 3072, 0, 1, 25832, 3076, 0, 1, 9001].map(u16)))];
  const vlrBytes = Buffer.concat(vlrs);
  const header = Buffer.alloc(headerSize);
  header.write('LASF', 0, 'latin1');
  // Global encoding: GPS time is standard GPS time; WKT for the coordinate system in LAS 1.4.
  header.writeUInt16LE(modern ? 0x11 : 0x01, 6);
  header[24] = 1;
  header[25] = modern ? 4 : 2;
  header.write('Peekbean sample generator', 26, 32, 'latin1');
  header.write('generate-cad3d-samples.mjs', 58, 32, 'latin1');
  header.writeUInt16LE(300, 90);
  header.writeUInt16LE(2026, 92);
  header.writeUInt16LE(headerSize, 94);
  header.writeUInt32LE(headerSize + vlrBytes.length, 96);
  header.writeUInt32LE(vlrs.length, 100);
  header[104] = format;
  header.writeUInt16LE(recordLength, 105);
  const byReturn = [1, 2, 3, 4, 5].map((r) => points.filter((p) => p.ret === r).length);
  if (!modern) {
    header.writeUInt32LE(points.length, 107);
    byReturn.forEach((n, i) => header.writeUInt32LE(n, 111 + i * 4));
  }
  scaleXyz.forEach((v, k) => header.writeDoubleLE(v, 131 + k * 8));
  offset.forEach((v, k) => header.writeDoubleLE(v, 155 + k * 8));
  for (let k = 0; k < 3; k++) {
    header.writeDoubleLE(max[k], 179 + k * 16);
    header.writeDoubleLE(min[k], 187 + k * 16);
  }
  if (modern) {
    header.writeBigUInt64LE(BigInt(points.length), 247);
    byReturn.forEach((n, i) => header.writeBigUInt64LE(BigInt(n), 255 + i * 8));
  }
  const body = Buffer.alloc(points.length * recordLength);
  points.forEach((p, i) => {
    const at = i * recordLength;
    world[i].forEach((v, k) => body.writeInt32LE(Math.round((v - offset[k]) / scaleXyz[k]), at + k * 4));
    body.writeUInt16LE(p.intensity, at + 12);
    if (modern) {
      body[at + 14] = p.ret | (p.of << 4);
      body[at + 15] = 0;
      body[at + 16] = p.cls;
      body.writeDoubleLE(p.time, at + 22);
      p.rgb.forEach((c, k) => body.writeUInt16LE(c * 257, at + 30 + k * 2));
    } else {
      body[at + 14] = p.ret | (p.of << 3);
      body[at + 15] = p.cls;
      body.writeDoubleLE(p.time, at + 20);
      p.rgb.forEach((c, k) => body.writeUInt16LE(c * 257, at + 28 + k * 2));
    }
  });
  return Buffer.concat([header, vlrBytes, body]);
}

/** LAZ through laspy and lazrs (Python), keeping the header as written above. */
function laz(lasData, rel) {
  const python = process.env.LAZ_PYTHON;
  if (!python) {
    console.log(`LAZ_PYTHON is not set: samples/${rel} left as it is.`);
    return;
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'cad3d-'));
  try {
    const source = path.join(dir, 'scan.las');
    const target = path.join(dir, 'scan.laz');
    writeFileSync(source, lasData);
    const script = 'import sys, laspy\nlas = laspy.read(sys.argv[1])\nlas.write(sys.argv[2], laz_backend=laspy.LazBackend.Lazrs)\n';
    execFileSync(python, ['-I', '-c', script, source, target], { stdio: 'inherit' });
    write(rel, readFile(target));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const readFile = (file) => createRequire(import.meta.url)('node:fs').readFileSync(file);

// ---- Output --------------------------------------------------------------------------------------------------------

const document = fcstd();
await checkShapes(document.list);
write('cad/bracket.FCStd', document.data);
write('3d/survey-scan.las', las(scan(2.5, 7), '1.2'));
laz(las(scan(6, 11), '1.4'), '3d/survey-scan.laz');

for (const [rel, size] of written) console.log(`${String(size).padStart(8)}  samples/${rel}`);
