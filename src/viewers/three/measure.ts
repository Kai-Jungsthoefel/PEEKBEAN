// SPDX-License-Identifier: GPL-3.0-or-later
// Measuring on the mesh. Card and behavior follow SOMA's measure tool (GPL-3.0); SOMA measures exact CAD geometry in a
// Python service, here we snap to what the triangles reveal: circle centers (holes, bores), corners and edges.
import * as THREE from 'three';
import { h, setPressed } from '../../core/dom';
import { icon } from '../../core/icons';
import { meshFeatures } from './features';

export interface MeasureHost {
  camera(): THREE.Camera;
  canvas: HTMLCanvasElement;
  viewport: HTMLElement;
  scene: THREE.Scene;
  /** Visible meshes and point clouds that can be picked. */
  pickables(): THREE.Object3D[];
  /** World position → coordinates of the file. */
  toFile(world: THREE.Vector3): THREE.Vector3;
  /** Characteristic model size, for picking point clouds. */
  size: () => number;
  unit: string;
  requestRender(): void;
}

type Kind = 'center' | 'corner' | 'edge' | 'surface' | 'point';

interface Pick {
  point: THREE.Vector3;
  kind: Kind;
  /** Circle radius in file units, for centers. */
  radius?: number;
  /** The circle is only an arc (fillet), shown as R instead of Ø. */
  arc?: boolean;
  /** World points to highlight: the circle ring or the edge. */
  outline?: THREE.Vector3[];
}

/** Relation of two picked edges: the angle between them, or their distance when they run parallel. */
type EdgeRelation = { parallel: true; distance: number } | { parallel: false; angle: number };

const PARALLEL_DEG = 0.5;

/**
 * Edges given by their end points, in file coordinates. When the edges meet (or would meet when extended), the angle
 * is measured inside the corner formed towards the two picked points, 0–180°; skew edges get the line angle, 0–90°.
 */
function edgeRelation(a: [THREE.Vector3, THREE.Vector3], pa: THREE.Vector3, b: [THREE.Vector3, THREE.Vector3], pb: THREE.Vector3, size: number): EdgeRelation | null {
  const u = a[1].clone().sub(a[0]);
  const v = b[1].clone().sub(b[0]);
  if (u.lengthSq() === 0 || v.lengthSq() === 0) return null;
  u.normalize();
  v.normalize();
  const w = a[0].clone().sub(b[0]);
  const cos = u.dot(v);
  const lineAngle = THREE.MathUtils.radToDeg(Math.acos(Math.min(1, Math.abs(cos))));
  if (lineAngle < PARALLEL_DEG) return { parallel: true, distance: w.clone().addScaledVector(u, -w.dot(u)).length() };
  // Closest points of the two lines; if they coincide, the lines intersect there.
  const d = u.dot(w);
  const e = v.dot(w);
  const denom = 1 - cos * cos;
  const x1 = a[0].clone().addScaledVector(u, (cos * e - d) / denom);
  const x2 = b[0].clone().addScaledVector(v, (e - cos * d) / denom);
  const ra = pa.clone().sub(x1);
  const rb = pb.clone().sub(x2);
  const tiny = size * 1e-4;
  if (x1.distanceTo(x2) > tiny || ra.length() < tiny || rb.length() < tiny) return { parallel: false, angle: lineAngle };
  return { parallel: false, angle: THREE.MathUtils.radToDeg(ra.angleTo(rb)) };
}

const KIND_LABEL: Record<Kind, string> = { center: 'Circle center', corner: 'Corner', edge: 'Edge', surface: 'Surface', point: 'Point' };
const CORNER_PX = 12;
const CIRCLE_PX = 9;
const CENTER_PX = 14;
const EDGE_PX = 8;
const CLICK_PX = 5;

const minus = (s: string) => s.replace(/^-/, '−');
// Rounded first, so that −0,001 shows as 0,00 rather than −0,00.
const num = (v: number) => minus((Math.round(v * 100) / 100 || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

function dotTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(32, 32, 30, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#f29a38';
  g.beginPath();
  g.arc(32, 32, 21, 0, Math.PI * 2);
  g.fill();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export class MeasureTool {
  readonly button: HTMLButtonElement;
  readonly card = h('div', { class: 'float mcard', hidden: true });
  private readonly label = h('div', { class: 'm-label', hidden: true });
  /** Diameters of picked circles, next to their centers. */
  private readonly diameterLabels = [h('div', { class: 'm-label m-dia', hidden: true }), h('div', { class: 'm-label m-dia', hidden: true })];
  private active = false;
  private a: Pick | null = null;
  private b: Pick | null = null;
  private readonly marks = new THREE.Group();
  private readonly hoverMarks = new THREE.Group();
  private readonly texture = dotTexture();
  private readonly pointsMaterial = new THREE.PointsMaterial({ size: 13, sizeAttenuation: false, map: this.texture, transparent: true, depthTest: false });
  private readonly hoverMaterial = new THREE.PointsMaterial({ size: 11, sizeAttenuation: false, map: this.texture, transparent: true, opacity: 0.65, depthTest: false });
  private readonly lineMaterial = new THREE.LineBasicMaterial({ color: 0xf29a38, depthTest: false });
  private readonly outlineMaterial = new THREE.LineBasicMaterial({ color: 0xf29a38, depthTest: false, transparent: true, opacity: 0.9 });
  private down: { x: number; y: number } | null = null;
  private readonly raycaster = new THREE.Raycaster();
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly host: MeasureHost) {
    this.marks.renderOrder = 999;
    this.hoverMarks.renderOrder = 999;
    host.scene.add(this.marks, this.hoverMarks);
    host.viewport.append(this.label, ...this.diameterLabels);
    this.button = h('button', { type: 'button', class: 'btn sm', title: 'Measure distances: snaps to circle centers, corners and edges; two edges show their angle (Escape ends)', onclick: () => this.setActive(!this.active) }, icon('ruler', 14), 'Measure');
    setPressed(this.button, false);

    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      target.addEventListener(type, fn as EventListener);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener));
    };
    on(host.canvas, 'pointerdown', (e) => {
      if (this.active && e.button === 0) this.down = { x: e.clientX, y: e.clientY };
    });
    on(host.canvas, 'pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!this.active || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX) return;
      this.pick(this.probe(e.clientX, e.clientY));
    });
    on(host.canvas, 'pointermove', (e) => {
      if (!this.active || e.buttons || e.pointerType === 'touch') return;
      this.showHover(this.probe(e.clientX, e.clientY));
    });
    on(window, 'keydown', (e) => {
      if (!this.active || e.key !== 'Escape' || (e.target as HTMLElement)?.closest?.('input, textarea')) return;
      if (this.a) this.clear();
      else this.setActive(false);
    });
    this.render();
  }

  get isActive(): boolean {
    return this.active;
  }

  setActive(on: boolean): void {
    this.active = on;
    setPressed(this.button, on);
    this.host.viewport.classList.toggle('measuring', on);
    this.clear();
  }

  private clear(): void {
    this.a = this.b = null;
    this.showHover(null);
    this.redraw();
  }

  /** Best snap target under the cursor: circle center, corner, edge, or the surface point. */
  private probe(clientX: number, clientY: number): Pick | null {
    const rect = this.host.canvas.getBoundingClientRect();
    const camera = this.host.camera();
    const cursor = new THREE.Vector2(clientX - rect.left, clientY - rect.top);
    const screen = (p: THREE.Vector3) => {
      const v = p.clone().project(camera);
      return new THREE.Vector2(((v.x + 1) / 2) * rect.width, ((1 - v.y) / 2) * rect.height);
    };
    const ndc = new THREE.Vector2((cursor.x / rect.width) * 2 - 1, -(cursor.y / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, camera);
    this.raycaster.params.Points.threshold = this.host.size() * 0.004;
    const pickables = this.host.pickables();
    const hit = this.raycaster.intersectObjects(pickables, false)[0];
    if (hit?.object instanceof THREE.Points && hit.index !== undefined) {
      const position = (hit.object.geometry as THREE.BufferGeometry).getAttribute('position');
      return { kind: 'point', point: new THREE.Vector3().fromBufferAttribute(position, hit.index).applyMatrix4(hit.object.matrixWorld) };
    }

    // Circles: the cursor on the ring or near the center (a hole has no surface to hit there).
    let best: { pick: Pick; score: number } | null = null;
    for (const object of pickables) {
      if (!(object instanceof THREE.Mesh)) continue;
      const features = meshFeatures(object);
      for (const circle of features.circles) {
        const center = circle.center.clone().applyMatrix4(object.matrixWorld);
        const centerPx = screen(center).distanceTo(cursor);
        let px = centerPx <= CENTER_PX ? centerPx : Infinity;
        if (px === Infinity && object === hit?.object) {
          for (const p of circle.points) {
            const d = screen(p.clone().applyMatrix4(object.matrixWorld)).distanceTo(cursor);
            if (d <= CIRCLE_PX && d < px) px = d;
          }
        }
        if (px === Infinity) continue;
        // Full circles (holes, bores) win over arcs (fillets), then the one under the cursor, then the one in front.
        const score = px + (circle.closed ? 0 : 8) + (3 * center.distanceTo(camera.position)) / this.host.size();
        if (score < (best?.score ?? Infinity)) {
          const worldRadius = circle.points[0].clone().applyMatrix4(object.matrixWorld).distanceTo(center);
          const fileRadius = this.host.toFile(circle.points[0].clone().applyMatrix4(object.matrixWorld)).distanceTo(this.host.toFile(center));
          best = { score, pick: { kind: 'center', point: center, radius: fileRadius || worldRadius, arc: !circle.closed, outline: circle.points.map((p) => p.clone().applyMatrix4(object.matrixWorld)) } };
        }
      }
    }
    if (best) return best.pick;
    if (!hit || !(hit.object instanceof THREE.Mesh)) return null;
    const mesh = hit.object;

    // Corners of the hit triangle.
    if (hit.face) {
      const position = (mesh.geometry as THREE.BufferGeometry).getAttribute('position');
      let corner: THREE.Vector3 | null = null;
      let cornerPx = CORNER_PX;
      for (const index of [hit.face.a, hit.face.b, hit.face.c]) {
        const p = new THREE.Vector3().fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
        const d = screen(p).distanceTo(cursor);
        if (d < cornerPx) {
          cornerPx = d;
          corner = p;
        }
      }
      if (corner) return { kind: 'corner', point: corner };
    }

    // Sharp edges of the hit part: the closest point on the edge under the cursor.
    const { segments } = meshFeatures(mesh);
    let edge: { point: THREE.Vector3; px: number; a: THREE.Vector3; b: THREE.Vector3 } | null = null;
    for (let i = 0; i < segments.length; i += 6) {
      const a = new THREE.Vector3(segments[i], segments[i + 1], segments[i + 2]).applyMatrix4(mesh.matrixWorld);
      const b = new THREE.Vector3(segments[i + 3], segments[i + 4], segments[i + 5]).applyMatrix4(mesh.matrixWorld);
      const sa = screen(a);
      const sb = screen(b);
      const ab = sb.clone().sub(sa);
      const t = THREE.MathUtils.clamp(ab.lengthSq() ? cursor.clone().sub(sa).dot(ab) / ab.lengthSq() : 0, 0, 1);
      const px = sa.clone().addScaledVector(ab, t).distanceTo(cursor);
      if (px <= EDGE_PX && px < (edge?.px ?? Infinity)) edge = { point: a.clone().lerp(b, t), px, a, b };
    }
    if (edge) return { kind: 'edge', point: edge.point, outline: [edge.a, edge.b] };
    return { kind: 'surface', point: hit.point.clone() };
  }

  private outline(points: THREE.Vector3[], group: THREE.Group): void {
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), this.outlineMaterial);
    line.renderOrder = 998;
    group.add(line);
  }

  private clearGroup(group: THREE.Group): void {
    for (const child of [...group.children]) {
      group.remove(child);
      (child as THREE.Points | THREE.Line).geometry.dispose();
    }
  }

  private showHover(pick: Pick | null): void {
    this.clearGroup(this.hoverMarks);
    if (pick) {
      if (pick.outline) this.outline(pick.outline, this.hoverMarks);
      const dot = new THREE.Points(new THREE.BufferGeometry().setFromPoints([pick.point]), this.hoverMaterial);
      dot.renderOrder = 999;
      this.hoverMarks.add(dot);
    }
    this.host.canvas.title = pick ? `${this.name(pick)} ${this.circle(pick)}`.trim() : '';
    this.host.requestRender();
  }

  private pick(pick: Pick | null): void {
    if (!pick) {
      if (this.a) this.clear();
      return;
    }
    if (!this.a || this.b) {
      this.a = pick;
      this.b = null;
    } else {
      this.b = pick;
    }
    this.redraw();
  }

  private redraw(): void {
    this.clearGroup(this.marks);
    const picks = [this.a, this.b].filter((p): p is Pick => p !== null);
    for (const p of picks) if ((p.kind === 'center' || p.kind === 'edge') && p.outline) this.outline(p.outline, this.marks);
    if (picks.length) {
      const dots = new THREE.Points(new THREE.BufferGeometry().setFromPoints(picks.map((p) => p.point)), this.pointsMaterial);
      dots.renderOrder = 1000;
      this.marks.add(dots);
    }
    if (this.a && this.b) {
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints([this.a.point, this.b.point]), this.lineMaterial);
      line.renderOrder = 999;
      this.marks.add(line);
    }
    this.render();
    this.host.requestRender();
  }

  private format(v: number): string {
    return `${num(v)}${this.host.unit ? ` ${this.host.unit}` : ''}`;
  }

  private name(p: Pick): string {
    return p.kind === 'center' && p.arc ? 'Arc center' : KIND_LABEL[p.kind];
  }

  /** Ø for full circles, R for arcs; empty for other picks. */
  private circle(p: Pick): string {
    if (p.kind !== 'center' || !p.radius) return '';
    return p.arc ? `R ${this.format(p.radius)}` : `Ø ${this.format(2 * p.radius)}`;
  }

  private describe(p: Pick): string {
    const f = this.host.toFile(p.point);
    const what = `${this.name(p)} ${this.circle(p)}`.trim();
    return `${what} · X ${num(f.x)} · Y ${num(f.y)} · Z ${num(f.z)}`;
  }

  /** The measuring card in the lower left corner. */
  private render(): void {
    this.card.hidden = !this.active;
    if (!this.active) return;
    const head = h(
      'div',
      { class: 'float-hd' },
      icon('ruler', 14),
      h('b', {}, 'Measure'),
      h('span', { class: 'grow' }),
      this.a ? h('button', { type: 'button', class: 'link', onclick: () => this.clear() }, 'New') : null,
      h('button', { type: 'button', class: 'hb', title: 'Stop measuring (Escape)', 'aria-label': 'Stop measuring', onclick: () => this.setActive(false) }, icon('close', 13, 2)),
    );
    const rows: (HTMLElement | null)[] = [];
    const point = (tag: string, p: Pick) => h('div', { class: 'mc-pt' }, h('b', {}, tag), h('span', {}, this.describe(p)));
    if (!this.a) {
      rows.push(h('div', { class: 'mc-hint' }, 'Click a point. Circle centers, corners and edges snap; for a circle center, point at the rim or the middle. Two edges show their angle.'));
    } else if (!this.b) {
      if (this.circle(this.a)) rows.push(h('div', { class: 'mc-main' }, h('span', {}, this.a.arc ? 'Radius' : 'Diameter'), h('b', {}, this.circle(this.a))));
      rows.push(point('A', this.a));
      rows.push(h('div', { class: 'mc-hint' }, this.a.kind === 'edge' ? 'Click the second point, or a second edge for the angle.' : 'Click the second point.'));
    } else {
      const fa = this.host.toFile(this.a.point);
      const fb = this.host.toFile(this.b.point);
      const d = fb.clone().sub(fa);
      const centers = this.a.kind === 'center' && this.b.kind === 'center';
      const relation = this.edges();
      if (relation?.parallel) rows.push(h('div', { class: 'mc-main' }, h('span', {}, 'Distance between the parallel edges'), h('b', {}, this.format(relation.distance))));
      else if (relation) rows.push(h('div', { class: 'mc-main' }, h('span', {}, 'Angle between the edges'), h('b', {}, `${num(relation.angle)}°`)));
      rows.push(h('div', { class: 'mc-main' }, h('span', {}, centers ? 'Center to center' : relation ? 'Distance between the points' : 'Distance'), h('b', {}, this.format(d.length()))));
      rows.push(h('div', { class: 'mc-sub' }, `ΔX ${num(d.x)} · ΔY ${num(d.y)} · ΔZ ${num(d.z)}`));
      rows.push(point('A', this.a), point('B', this.b));
    }
    this.card.replaceChildren(head, h('div', { class: 'mc-body' }, ...rows));
  }

  /** Angle or distance of the two picked edges, in file coordinates. */
  private edges(): EdgeRelation | null {
    const { a, b } = this;
    if (a?.kind !== 'edge' || b?.kind !== 'edge' || a.outline?.length !== 2 || b.outline?.length !== 2) return null;
    const file = (p: THREE.Vector3) => this.host.toFile(p);
    return edgeRelation([file(a.outline[0]), file(a.outline[1])], file(a.point), [file(b.outline[0]), file(b.outline[1])], file(b.point), this.host.size());
  }

  /** After every frame: keep the distance label at the middle of the line and the diameters at their circles. */
  update(): void {
    const rect = this.host.canvas.getBoundingClientRect();
    [this.a, this.b].forEach((p, i) => {
      const label = this.diameterLabels[i];
      const at = p?.kind === 'center' && p.radius ? p.point.clone().project(this.host.camera()) : null;
      label.hidden = !at || at.z > 1;
      if (!at || !p?.radius) return;
      label.textContent = this.circle(p);
      label.style.transform = `translate(${((at.x + 1) / 2) * rect.width}px, ${((1 - at.y) / 2) * rect.height}px) translate(-50%, 50%)`;
    });
    if (!this.a || !this.b) {
      this.label.hidden = true;
      return;
    }
    const mid = this.a.point.clone().add(this.b.point).multiplyScalar(0.5).project(this.host.camera());
    this.label.hidden = mid.z > 1;
    this.label.textContent = this.format(this.host.toFile(this.b.point).distanceTo(this.host.toFile(this.a.point)));
    this.label.style.transform = `translate(${((mid.x + 1) / 2) * rect.width}px, ${((1 - mid.y) / 2) * rect.height}px) translate(-50%, -150%)`;
  }

  dispose(): void {
    for (const off of this.cleanup) off();
    this.clearGroup(this.marks);
    this.clearGroup(this.hoverMarks);
    this.host.scene.remove(this.marks, this.hoverMarks);
    this.texture.dispose();
    for (const m of [this.pointsMaterial, this.hoverMaterial, this.lineMaterial, this.outlineMaterial]) m.dispose();
    this.label.remove();
    for (const label of this.diameterLabels) label.remove();
  }
}
