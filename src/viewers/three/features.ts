// SPDX-License-Identifier: GPL-3.0-or-later
// Edges and circles of a mesh for measuring: sharp edges are chained into polylines, and chains that lie on a circle
// (holes, bores, fillets) become circles with center, axis and radius, so one can measure center to center.
import * as THREE from 'three';

export interface Circle {
  /** In the mesh's local coordinates. */
  center: THREE.Vector3;
  normal: THREE.Vector3;
  radius: number;
  /** A full circle (hole, bore, shaft) rather than an arc (fillet, rounding). */
  closed: boolean;
  /** Points along the chain, local coordinates; used to find the circle under the cursor and to highlight it. */
  points: THREE.Vector3[];
}

export interface MeshFeatures {
  /** Edge segments as pairs of points, local coordinates. */
  segments: Float32Array;
  circles: Circle[];
}

const EDGE_ANGLE = 25;
const MIN_CIRCLE_POINTS = 6;

/** Joins edge segments that share end points into chains. */
function chains(segments: Float32Array, tolerance: number): THREE.Vector3[][] {
  const key = (x: number, y: number, z: number) => `${Math.round(x / tolerance)},${Math.round(y / tolerance)},${Math.round(z / tolerance)}`;
  const points: THREE.Vector3[] = [];
  const index = new Map<string, number>();
  const pointId = (i: number) => {
    const k = key(segments[i], segments[i + 1], segments[i + 2]);
    let id = index.get(k);
    if (id === undefined) {
      id = points.push(new THREE.Vector3(segments[i], segments[i + 1], segments[i + 2])) - 1;
      index.set(k, id);
    }
    return id;
  };
  const neighbors: number[][] = [];
  for (let i = 0; i < segments.length; i += 6) {
    const a = pointId(i);
    const b = pointId(i + 3);
    if (a === b) continue;
    (neighbors[a] ??= []).push(b);
    (neighbors[b] ??= []).push(a);
  }
  // Walk from every unvisited point through points of degree 2; branch points end a chain.
  const used = new Set<string>();
  const edgeKey = (a: number, b: number) => (a < b ? `${a}-${b}` : `${b}-${a}`);
  const result: THREE.Vector3[][] = [];
  const starts = [...neighbors.keys()].filter((p) => neighbors[p] && neighbors[p].length !== 2);
  const walk = (start: number, next: number) => {
    const chain = [start];
    let previous = start;
    let current = next;
    used.add(edgeKey(previous, current));
    while (true) {
      chain.push(current);
      const options = neighbors[current] ?? [];
      if (options.length !== 2 || current === start) break;
      const following = options[0] === previous ? options[1] : options[0];
      if (used.has(edgeKey(current, following))) {
        if (following === start) chain.push(start);
        break;
      }
      used.add(edgeKey(current, following));
      previous = current;
      current = following;
    }
    result.push(chain.map((id) => points[id]));
  };
  for (const start of [...starts, ...neighbors.keys()]) {
    if (!neighbors[start]) continue;
    for (const next of neighbors[start]) if (!used.has(edgeKey(start, next))) walk(start, next);
  }
  return result;
}

/** Circle through the chain points, if they all lie on one (closed loops and arcs). */
function fitCircle(points: THREE.Vector3[]): Circle | null {
  if (points.length < MIN_CIRCLE_POINTS) return null;
  const closed = points[0].distanceTo(points[points.length - 1]) < 1e-9;
  const pts = closed ? points.slice(0, -1) : points;
  // Center from three spread-out points, then check all of them.
  const a = pts[0];
  const b = pts[Math.floor(pts.length / 3)];
  const c = pts[Math.floor((2 * pts.length) / 3)];
  const ab = b.clone().sub(a);
  const ac = c.clone().sub(a);
  const normal = ab.clone().cross(ac);
  const area2 = normal.lengthSq();
  if (area2 < 1e-18) return null;
  // Circumcenter of the triangle a, b, c.
  const center = a
    .clone()
    .add(ac.clone().cross(normal).multiplyScalar(ab.lengthSq()).add(normal.clone().cross(ab).multiplyScalar(ac.lengthSq())).divideScalar(2 * area2));
  normal.normalize();
  const radius = center.distanceTo(a);
  if (!(radius > 0)) return null;
  for (const p of pts) {
    if (Math.abs(p.distanceTo(center) - radius) > radius * 0.01) return null;
    if (Math.abs(p.clone().sub(center).dot(normal)) > radius * 0.01) return null;
  }
  return { center, normal, radius, closed, points };
}

/** Sharp edges and circles of one mesh, computed once and cached on the geometry. */
export function meshFeatures(mesh: THREE.Mesh): MeshFeatures {
  const geometry = mesh.geometry as THREE.BufferGeometry;
  const cached = geometry.userData.features as MeshFeatures | undefined;
  if (cached) return cached;
  const edges = new THREE.EdgesGeometry(geometry, EDGE_ANGLE);
  const segments = Float32Array.from(edges.getAttribute('position').array as ArrayLike<number>);
  edges.dispose();
  geometry.computeBoundingSphere();
  const tolerance = Math.max(geometry.boundingSphere?.radius ?? 1, 1e-6) * 1e-6;
  const circles = chains(segments, tolerance)
    .map(fitCircle)
    .filter((c): c is Circle => c !== null);
  const features = { segments, circles };
  geometry.userData.features = features;
  return features;
}
