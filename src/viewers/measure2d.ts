// SPDX-License-Identifier: GPL-3.0-or-later
// Point-to-point measuring for flat views (DXF/DWG, PDF, images). Each viewer supplies the mapping between screen and
// drawing coordinates, optional snap points and the unit conversion; card and marks look like the 3D measuring tool.
import { h, setPressed } from '../core/dom';
import { icon } from '../core/icons';

export interface Point2 {
  x: number;
  y: number;
  /** PDF: page the point lies on; points on different pages cannot be measured against each other. */
  page?: number;
  /** Center of a circle or arc with this radius, in drawing units. */
  radius?: number;
  /** The radius belongs to an arc, shown as R instead of Ø. */
  arc?: boolean;
  /** The point lies on the straight line between these end points. */
  edge?: [Point2, Point2];
}

export interface Measure2DHost {
  /** Element that receives the clicks (canvas, page area, image stage). */
  surface: HTMLElement;
  /** Positioned element the marks are drawn into; toScreen() returns coordinates relative to it. */
  overlay: HTMLElement;
  toWorld(clientX: number, clientY: number): Point2 | null;
  toScreen(p: Point2): { x: number; y: number } | null;
  /** Drawing units per screen pixel at the moment, for the snap distance. */
  unitsPerPixel(): number;
  snap?(p: Point2, tolerance: number): Point2 | null;
  /** Drawing units → displayed length. */
  convert(length: number): number;
  unit(): string;
  /** Extra settings shown in the card, e.g. scale and unit. */
  settings?: HTMLElement;
  /** Coordinates of a point as shown in the card. */
  describe?(p: Point2): string;
}

const SNAP_PX = 12;
const CLICK_PX = 5;
const PARALLEL_DEG = 0.5;
const minus = (s: string) => s.replace(/^-/, '−');
const num = (v: number, digits = 2) => minus((Math.round(v * 10 ** digits) / 10 ** digits || 0).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits }));
const degrees = (radians: number) => (radians * 180) / Math.PI;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Relation of two picked lines: the angle between them, or their distance when they run parallel. */
type EdgeRelation = { parallel: true; distance: number } | { parallel: false; angle: number };

/**
 * Angle inside the corner the two lines form towards the picked points, 0–180°, or the distance of parallel lines.
 * Falls back to the line angle, 0–90°, when a picked point lies on the intersection itself.
 */
function edgeRelation(a: Point2, b: Point2): EdgeRelation | null {
  if (!a.edge || !b.edge) return null;
  const [a0, a1] = a.edge;
  const [b0, b1] = b.edge;
  const ux = a1.x - a0.x;
  const uy = a1.y - a0.y;
  const vx = b1.x - b0.x;
  const vy = b1.y - b0.y;
  const lu = Math.hypot(ux, uy);
  const lv = Math.hypot(vx, vy);
  if (!lu || !lv) return null;
  const cross = ux * vy - uy * vx;
  const lineAngle = degrees(Math.atan2(Math.abs(cross), Math.abs(ux * vx + uy * vy)));
  if (lineAngle < PARALLEL_DEG) return { parallel: true, distance: Math.abs((b0.x - a0.x) * uy - (b0.y - a0.y) * ux) / lu };
  const s = ((b0.x - a0.x) * vy - (b0.y - a0.y) * vx) / cross;
  const x = a0.x + s * ux;
  const y = a0.y + s * uy;
  const ra = Math.hypot(a.x - x, a.y - y);
  const rb = Math.hypot(b.x - x, b.y - y);
  if (ra < Math.max(lu, lv) * 1e-6 || rb < Math.max(lu, lv) * 1e-6) return { parallel: false, angle: lineAngle };
  const cos = ((a.x - x) * (b.x - x) + (a.y - y) * (b.y - y)) / (ra * rb);
  return { parallel: false, angle: degrees(Math.acos(Math.min(1, Math.max(-1, cos)))) };
}

export class Measure2D {
  readonly button: HTMLButtonElement;
  readonly card = h('div', { class: 'float mcard', hidden: true });
  private readonly svg = document.createElementNS(SVG_NS, 'svg');
  private readonly label = h('div', { class: 'm-label', hidden: true });
  /** Diameters or radii of picked circles, next to their centers. */
  private readonly circleLabels = [h('div', { class: 'm-label m-dia', hidden: true }), h('div', { class: 'm-label m-dia', hidden: true })];
  private active = false;
  private a: Point2 | null = null;
  private b: Point2 | null = null;
  private hover: Point2 | null = null;
  private down: { x: number; y: number } | null = null;
  private readonly cleanup: (() => void)[] = [];

  constructor(private readonly host: Measure2DHost) {
    this.svg.classList.add('m-overlay');
    host.overlay.append(this.svg, this.label, ...this.circleLabels);
    const title = host.snap
      ? 'Measure: snaps to points, lines and circles; two lines show their angle (Escape ends)'
      : 'Measure the distance between two points (Escape ends)';
    this.button = h('button', { type: 'button', class: 'btn sm', title, onclick: () => this.setActive(!this.active) }, icon('ruler', 14), 'Measure');
    setPressed(this.button, false);

    const on = <K extends keyof HTMLElementEventMap>(target: HTMLElement | Window, type: K, fn: (e: HTMLElementEventMap[K]) => void, capture = false) => {
      target.addEventListener(type, fn as EventListener, capture);
      this.cleanup.push(() => target.removeEventListener(type, fn as EventListener, capture));
    };
    on(host.surface, 'pointerdown', (e) => {
      if (this.active && e.button === 0) this.down = { x: e.clientX, y: e.clientY };
    });
    on(host.surface, 'pointerup', (e) => {
      const d = this.down;
      this.down = null;
      if (!this.active || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_PX) return;
      this.pick(this.probe(e.clientX, e.clientY));
    });
    // In measuring mode a click must not follow links or select text in the document.
    on(host.surface, 'click', (e) => {
      if (this.active) e.preventDefault();
    }, true);
    on(host.surface, 'pointermove', (e) => {
      if (!this.active || e.buttons || e.pointerType === 'touch') return;
      this.hover = this.probe(e.clientX, e.clientY);
      host.surface.title = this.hover ? this.kind(this.hover) : '';
      this.update();
    });
    on(window, 'keydown', (e) => {
      if (!this.active || e.key !== 'Escape' || (e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      if (this.a) this.clear();
      else this.setActive(false);
    });
    host.settings?.addEventListener('input', () => {
      this.render();
      this.update();
    });
    this.render();
  }

  setActive(on: boolean): void {
    this.active = on;
    setPressed(this.button, on);
    this.host.overlay.classList.toggle('measuring', on);
    this.host.surface.classList.toggle('measuring', on);
    this.host.surface.title = '';
    this.clear();
  }

  private clear(): void {
    this.a = this.b = this.hover = null;
    this.render();
    this.update();
  }

  private probe(clientX: number, clientY: number): Point2 | null {
    const p = this.host.toWorld(clientX, clientY);
    if (!p) return null;
    return this.host.snap?.(p, this.host.unitsPerPixel() * SNAP_PX) ?? p;
  }

  private pick(p: Point2 | null): void {
    if (!p) {
      if (this.a) this.clear();
      return;
    }
    if (!this.a || this.b || (this.a.page !== undefined && this.a.page !== p.page)) {
      this.a = p;
      this.b = null;
    } else {
      this.b = p;
    }
    this.hover = null;
    this.render();
    this.update();
  }

  private format(length: number): string {
    const unit = this.host.unit();
    return `${num(this.host.convert(length))}${unit ? ` ${unit}` : ''}`;
  }

  private circle(p: Point2): string {
    return p.radius === undefined ? '' : p.arc ? `R ${this.format(p.radius)}` : `Ø ${this.format(2 * p.radius)}`;
  }

  /** What a snapped point is, for the card and the tooltip. */
  private kind(p: Point2): string {
    if (p.radius !== undefined) return `${p.arc ? 'Arc center' : 'Circle center'} ${this.circle(p)}`;
    return p.edge ? 'Line' : '';
  }

  private describe(p: Point2): string {
    const where = this.host.describe?.(p) ?? `X ${num(p.x)} · Y ${num(p.y)}`;
    const kind = this.kind(p);
    return kind ? `${kind} · ${where}` : where;
  }

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
    const main = (label: string, value: string) => h('div', { class: 'mc-main' }, h('span', {}, label), h('b', {}, value));
    if (!this.a) {
      rows.push(h('div', { class: 'mc-hint' }, this.host.snap
        ? 'Click a point. End points, midpoints and circle centers snap, as do lines and circles; small circles also via their rim. Two lines show their angle.'
        : 'Click the first point.'));
    } else if (!this.b) {
      if (this.a.radius !== undefined) rows.push(main(this.a.arc ? 'Radius' : 'Diameter', this.circle(this.a)));
      rows.push(h('div', { class: 'mc-row' }, h('span', {}, 'A'), h('span', { class: 'v' }, this.describe(this.a))));
      rows.push(h('div', { class: 'mc-hint' }, this.a.edge ? 'Click the second point, or a second line for the angle.' : 'Click the second point.'));
    } else {
      const dx = this.b.x - this.a.x;
      const dy = this.b.y - this.a.y;
      const relation = edgeRelation(this.a, this.b);
      const centers = this.a.radius !== undefined && this.b.radius !== undefined;
      if (relation?.parallel) rows.push(main('Distance between the parallel lines', this.format(relation.distance)));
      else if (relation) rows.push(main('Angle between the lines', `${num(relation.angle)}°`));
      rows.push(main(centers ? 'Center to center' : relation ? 'Distance between the points' : 'Distance', this.format(Math.hypot(dx, dy))));
      rows.push(h('div', { class: 'mc-sub' }, `ΔX ${this.format(dx)} · ΔY ${this.format(dy)} · ${num(degrees(Math.atan2(dy, dx)), 1)}°`));
      rows.push(h('div', { class: 'mc-row' }, h('span', {}, 'A'), h('span', { class: 'v' }, this.describe(this.a))));
      rows.push(h('div', { class: 'mc-row' }, h('span', {}, 'B'), h('span', { class: 'v' }, this.describe(this.b))));
    }
    if (this.host.settings) rows.push(this.host.settings);
    this.card.replaceChildren(head, h('div', { class: 'mc-body' }, ...rows));
  }

  /** Line or circle a point snapped to, highlighted under the marks. */
  private shape(p: Point2, cls: string): SVGElement | null {
    if (p.edge) {
      const s1 = this.host.toScreen(p.edge[0]);
      const s2 = this.host.toScreen(p.edge[1]);
      if (!s1 || !s2) return null;
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(s1.x));
      line.setAttribute('y1', String(s1.y));
      line.setAttribute('x2', String(s2.x));
      line.setAttribute('y2', String(s2.y));
      line.setAttribute('class', `m-shape ${cls}`);
      return line;
    }
    if (p.radius !== undefined) {
      const c = this.host.toScreen(p);
      const r = this.host.toScreen({ x: p.x + p.radius, y: p.y, page: p.page });
      if (!c || !r) return null;
      const ring = document.createElementNS(SVG_NS, 'circle');
      ring.setAttribute('cx', String(c.x));
      ring.setAttribute('cy', String(c.y));
      ring.setAttribute('r', String(Math.hypot(r.x - c.x, r.y - c.y)));
      // An arc is shown with its whole circle, dashed.
      ring.setAttribute('class', `m-shape ${cls}${p.arc ? ' arc' : ''}`);
      return ring;
    }
    return null;
  }

  /** Redraws the marks; call it whenever the view moved or zoomed. */
  update(): void {
    const dot = (p: { x: number; y: number }, cls: string) => {
      const c = document.createElementNS(SVG_NS, 'circle');
      c.setAttribute('cx', String(p.x));
      c.setAttribute('cy', String(p.y));
      c.setAttribute('r', cls === 'hover' ? '4.5' : '5.5');
      c.setAttribute('class', `m-dot ${cls}`);
      return c;
    };
    const items: (SVGElement | null)[] = [];
    const hover = this.active ? this.hover : null;
    if (this.a) items.push(this.shape(this.a, 'a'));
    if (this.b) items.push(this.shape(this.b, 'b'));
    if (hover) items.push(this.shape(hover, 'hover'));
    const sa = this.a ? this.host.toScreen(this.a) : null;
    const sb = this.b ? this.host.toScreen(this.b) : null;
    if (sa && sb) {
      const line = document.createElementNS(SVG_NS, 'line');
      line.setAttribute('x1', String(sa.x));
      line.setAttribute('y1', String(sa.y));
      line.setAttribute('x2', String(sb.x));
      line.setAttribute('y2', String(sb.y));
      line.setAttribute('class', 'm-line');
      items.push(line);
    }
    if (sa) items.push(dot(sa, 'a'));
    if (sb) items.push(dot(sb, 'b'));
    const sh = hover ? this.host.toScreen(hover) : null;
    if (sh) items.push(dot(sh, 'hover'));
    this.svg.replaceChildren(...items.filter((item): item is SVGElement => item !== null));

    [this.a, this.b].forEach((p, i) => {
      const label = this.circleLabels[i];
      const at = p?.radius !== undefined ? (i === 0 ? sa : sb) : null;
      label.hidden = !at;
      if (!at || !p) return;
      label.textContent = this.circle(p);
      label.style.transform = `translate(${at.x}px, ${at.y}px) translate(-50%, 50%)`;
    });
    this.label.hidden = !(sa && sb);
    if (sa && sb && this.a && this.b) {
      this.label.textContent = this.format(Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y));
      this.label.style.transform = `translate(${(sa.x + sb.x) / 2}px, ${(sa.y + sb.y) / 2}px) translate(-50%, -150%)`;
    }
  }

  dispose(): void {
    for (const off of this.cleanup) off();
    this.svg.remove();
    this.label.remove();
    for (const label of this.circleLabels) label.remove();
  }
}

/** Grid of snap points for fast lookup near the cursor. */
export class SnapIndex {
  private readonly cells = new Map<string, Point2[]>();

  constructor(
    points: Point2[],
    private readonly cell: number,
  ) {
    for (const p of points) {
      const key = this.key(Math.floor(p.x / cell), Math.floor(p.y / cell));
      const list = this.cells.get(key);
      if (list) list.push(p);
      else this.cells.set(key, [p]);
    }
  }

  private key(i: number, j: number): string {
    return `${i},${j}`;
  }

  nearest(p: Point2, tolerance: number): Point2 | null {
    const reach = Math.ceil(tolerance / this.cell);
    const ci = Math.floor(p.x / this.cell);
    const cj = Math.floor(p.y / this.cell);
    let best: Point2 | null = null;
    let bestDistance = tolerance;
    // Very small cells relative to the tolerance would mean scanning many of them; cap the search.
    const limit = Math.min(reach, 50);
    for (let i = ci - limit; i <= ci + limit; i++) {
      for (let j = cj - limit; j <= cj + limit; j++) {
        for (const q of this.cells.get(this.key(i, j)) ?? []) {
          const d = Math.hypot(q.x - p.x, q.y - p.y);
          if (d < bestDistance) {
            bestDistance = d;
            best = q;
          }
        }
      }
    }
    return best;
  }
}

/** A straight line between two points, or a circle; arcs run counterclockwise from start to end angle (radians). */
export type Shape2 =
  | { kind: 'line'; a: Point2; b: Point2 }
  | { kind: 'circle'; center: Point2; radius: number; start?: number; end?: number };

/** Lines and circles on a grid, to find the one under the cursor. */
export class ShapeIndex {
  private readonly cells = new Map<string, number[]>();

  constructor(
    private readonly shapes: Shape2[],
    private readonly cell: number,
  ) {
    shapes.forEach((shape, index) => {
      // Sampled at half a cell, so every cell the shape passes through knows it.
      const at = (x: number, y: number) => {
        const key = `${Math.floor(x / cell)},${Math.floor(y / cell)}`;
        const list = this.cells.get(key);
        if (!list) this.cells.set(key, [index]);
        else if (list[list.length - 1] !== index) list.push(index);
      };
      if (shape.kind === 'line') {
        const steps = Math.min(4096, Math.ceil((2 * Math.hypot(shape.b.x - shape.a.x, shape.b.y - shape.a.y)) / cell));
        for (let s = 0; s <= steps; s++) at(shape.a.x + ((shape.b.x - shape.a.x) * s) / (steps || 1), shape.a.y + ((shape.b.y - shape.a.y) * s) / (steps || 1));
      } else {
        const start = shape.start ?? 0;
        const sweep = shape.end === undefined ? 2 * Math.PI : (((shape.end - start) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) || 2 * Math.PI;
        const steps = Math.max(8, Math.min(4096, Math.ceil((2 * shape.radius * sweep) / cell)));
        for (let s = 0; s <= steps; s++) {
          const angle = start + (sweep * s) / steps;
          at(shape.center.x + shape.radius * Math.cos(angle), shape.center.y + shape.radius * Math.sin(angle));
        }
      }
    });
  }

  /**
   * The closest line (snapped onto it) or circle within the tolerance. Circles up to centerRadius snap to their center;
   * larger ones (outlines, long arcs) to the nearest point on the curve, so the point never jumps far away.
   */
  nearest(p: Point2, tolerance: number, centerRadius: number): Point2 | null {
    const limit = Math.min(Math.ceil(tolerance / this.cell), 50);
    const ci = Math.floor(p.x / this.cell);
    const cj = Math.floor(p.y / this.cell);
    const seen = new Set<number>();
    let best: Point2 | null = null;
    let bestDistance = tolerance;
    for (let i = ci - limit; i <= ci + limit; i++) {
      for (let j = cj - limit; j <= cj + limit; j++) {
        for (const index of this.cells.get(`${i},${j}`) ?? []) {
          if (seen.has(index)) continue;
          seen.add(index);
          const shape = this.shapes[index];
          if (shape.kind === 'line') {
            const dx = shape.b.x - shape.a.x;
            const dy = shape.b.y - shape.a.y;
            const length2 = dx * dx + dy * dy;
            const t = length2 ? Math.min(1, Math.max(0, ((p.x - shape.a.x) * dx + (p.y - shape.a.y) * dy) / length2)) : 0;
            const x = shape.a.x + t * dx;
            const y = shape.a.y + t * dy;
            const d = Math.hypot(p.x - x, p.y - y);
            if (d < bestDistance) {
              bestDistance = d;
              best = { x, y, edge: [shape.a, shape.b] };
            }
          } else {
            const angle = Math.atan2(p.y - shape.center.y, p.x - shape.center.x);
            const d = Math.abs(Math.hypot(p.x - shape.center.x, p.y - shape.center.y) - shape.radius);
            if (d >= bestDistance || !onArc(shape, angle)) continue;
            bestDistance = d;
            best = shape.radius <= centerRadius
              ? { x: shape.center.x, y: shape.center.y, radius: shape.radius, arc: shape.end !== undefined }
              : { x: shape.center.x + shape.radius * Math.cos(angle), y: shape.center.y + shape.radius * Math.sin(angle) };
          }
        }
      }
    }
    return best;
  }
}

function onArc(circle: Extract<Shape2, { kind: 'circle' }>, angle: number): boolean {
  if (circle.start === undefined || circle.end === undefined) return true;
  const turn = 2 * Math.PI;
  const sweep = (((circle.end - circle.start) % turn) + turn) % turn || turn;
  return (((angle - circle.start) % turn) + turn) % turn <= sweep;
}
