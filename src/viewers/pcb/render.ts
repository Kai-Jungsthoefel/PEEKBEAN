// SPDX-License-Identifier: GPL-3.0-or-later
// Draws plotted board layers on a 2D canvas: every layer as Path2D in mm, the board as seen from the top or bottom
// (substrate, copper, solder mask, finish, silkscreen, holes) composed from the layers like pcb-stackup does, and the
// points and edges that measuring snaps to.
import type { ErasableShape, ImageGraphic, PathSegment, Position, Shape } from '@tracespace/plotter';
import type { Point2, Shape2 } from '../measure2d';
import type { LayerType, PcbLayer } from './read';

export type Box = [number, number, number, number];

interface RunPaths {
  dark: boolean;
  /** Pads, regions and polygons, all wound the same way so that overlaps add up. */
  fill: Path2D;
  /** Shapes with holes in them (pads with a hole, thermals). */
  evenOdd: Path2D;
  /** Strokes by width in mm; 0 is a hairline. */
  strokes: Map<number, Path2D>;
  /** Macro pads with parts that erase other parts of the same pad. */
  erasable: { paths: { path: Path2D; erase: boolean; evenOdd: boolean }[]; box: Box }[];
}

export interface LayerPaths {
  blocks: { offsets: [number, number][]; runs: RunPaths[] }[];
}

// ---- Geometry -------------------------------------------------------------------------------------------------------

const same = (a: Position, b: Position) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;

/** Twice the signed area; arcs count with their middle point. Positive means counterclockwise. */
function windingOf(contour: PathSegment[]): number {
  const points: Position[] = [];
  for (const s of contour) {
    points.push([s.start[0], s.start[1]]);
    if (s.type === 'arc') {
      const middle = (s.start[2] + s.end[2]) / 2;
      points.push([s.center[0] + s.radius * Math.cos(middle), s.center[1] + s.radius * Math.sin(middle)]);
    }
  }
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  return area;
}

function reverse(contour: PathSegment[]): PathSegment[] {
  return contour
    .slice()
    .reverse()
    .map((s) => (s.type === 'arc' ? { ...s, start: s.end, end: s.start } : { ...s, start: s.end, end: s.start }));
}

/** Splits a list of segments where it jumps, e.g. the contours of one region. */
function contours(segments: PathSegment[]): PathSegment[][] {
  const result: PathSegment[][] = [];
  let current: PathSegment[] = [];
  for (const s of segments) {
    const last = current[current.length - 1];
    if (last && !same([last.end[0], last.end[1]], [s.start[0], s.start[1]])) {
      result.push(current);
      current = [];
    }
    current.push(s);
  }
  if (current.length) result.push(current);
  return result;
}

function addSegments(path: Path2D, segments: PathSegment[], close: boolean): void {
  let at: Position | null = null;
  for (const s of segments) {
    if (!at || !same(at, [s.start[0], s.start[1]])) {
      if (at && close) path.closePath();
      path.moveTo(s.start[0], s.start[1]);
    }
    if (s.type === 'arc') path.arc(s.center[0], s.center[1], s.radius, s.start[2], s.end[2], s.end[2] < s.start[2]);
    else path.lineTo(s.end[0], s.end[1]);
    at = [s.end[0], s.end[1]];
  }
  if (at && close) path.closePath();
}

/** Adds closed contours, each turned counterclockwise. */
function addFilled(path: Path2D, segments: PathSegment[]): void {
  for (const contour of contours(segments)) addSegments(path, windingOf(contour) < 0 ? reverse(contour) : contour, true);
}

function addPolygon(path: Path2D, points: Position[]): void {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    area += x1 * y2 - x2 * y1;
  }
  const ordered = area < 0 ? points.slice().reverse() : points;
  ordered.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  path.closePath();
}

/** Simple shapes into a path; returns whether it needs the even-odd rule (it has holes). */
function addShape(path: Path2D, shape: Exclude<Shape, { type: 'layeredShape' }>): boolean {
  switch (shape.type) {
    case 'circle':
      path.moveTo(shape.cx + shape.r, shape.cy);
      path.arc(shape.cx, shape.cy, shape.r, 0, 2 * Math.PI);
      path.closePath();
      return false;
    case 'rectangle':
      if (shape.r) path.roundRect(shape.x, shape.y, shape.xSize, shape.ySize, Math.min(shape.r, shape.xSize / 2, shape.ySize / 2));
      else path.rect(shape.x, shape.y, shape.xSize, shape.ySize);
      return false;
    case 'polygon':
      addPolygon(path, shape.points);
      return false;
    case 'outline':
      addSegments(path, shape.segments, true);
      return true;
  }
}

function shapeBox(shape: Shape): Box {
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (x: number, y: number, r = 0) => {
    box[0] = Math.min(box[0], x - r);
    box[1] = Math.min(box[1], y - r);
    box[2] = Math.max(box[2], x + r);
    box[3] = Math.max(box[3], y + r);
  };
  const visit = (s: Shape) => {
    switch (s.type) {
      case 'circle':
        add(s.cx, s.cy, s.r);
        break;
      case 'rectangle':
        add(s.x, s.y);
        add(s.x + s.xSize, s.y + s.ySize);
        break;
      case 'polygon':
        for (const [x, y] of s.points) add(x, y);
        break;
      case 'outline':
        for (const seg of s.segments) {
          add(seg.start[0], seg.start[1]);
          if (seg.type === 'arc') add(seg.center[0], seg.center[1], seg.radius);
        }
        break;
      case 'layeredShape':
        s.shapes.forEach(visit);
        break;
    }
  };
  visit(shape);
  return box;
}

function runPaths(dark: boolean, graphics: ImageGraphic[]): RunPaths {
  const run: RunPaths = { dark, fill: new Path2D(), evenOdd: new Path2D(), strokes: new Map(), erasable: [] };
  const stroke = (width: number) => {
    let path = run.strokes.get(width);
    if (!path) run.strokes.set(width, (path = new Path2D()));
    return path;
  };
  for (const g of graphics) {
    if (g.type === 'imagePath') {
      addSegments(stroke(g.width), g.segments, false);
    } else if (g.type === 'imageRegion') {
      addFilled(run.fill, g.segments);
    } else if (g.shape.type === 'layeredShape') {
      const parts = g.shape.shapes;
      if (parts.some((s) => s.erase)) {
        run.erasable.push({
          box: shapeBox(g.shape),
          paths: parts.map((s: ErasableShape) => {
            const path = new Path2D();
            const evenOdd = addShape(path, s);
            return { path, evenOdd, erase: !!s.erase };
          }),
        });
      } else {
        for (const s of parts) addShape(s.type === 'outline' ? run.evenOdd : run.fill, s);
      }
    } else {
      addShape(g.shape.type === 'outline' ? run.evenOdd : run.fill, g.shape);
    }
  }
  return run;
}

export function layerPaths(layer: PcbLayer): LayerPaths {
  return {
    blocks: layer.blocks.map((block) => {
      const offsets: [number, number][] = [];
      const { nx, ny, dx, dy } = block.repeat ?? { nx: 1, ny: 1, dx: 0, dy: 0 };
      for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) offsets.push([i * dx, j * dy]);
      return { offsets, runs: block.runs.map((run) => runPaths(run.dark, run.graphics)) };
    }),
  };
}

// ---- Board outline ---------------------------------------------------------------------------------------------------

/** Closes the outline layer's edges into loops; the board is what they enclose (even-odd, so cut-outs stay open). */
export function boardShape(outline: PcbLayer[]): { path: Path2D; box: Box } | null {
  const segments: PathSegment[] = [];
  const loops: PathSegment[][] = [];
  for (const layer of outline) {
    for (const block of layer.blocks) {
      for (const run of block.runs) {
        if (!run.dark) continue;
        for (const g of run.graphics) {
          if (g.type === 'imagePath' || g.type === 'imageRegion') segments.push(...g.segments);
          else if (g.shape.type === 'outline') segments.push(...g.shape.segments);
        }
      }
    }
  }
  if (!segments.length) return null;
  const tolerance = 0.05;
  const key = (p: Position | number[]) => `${Math.round(p[0] / tolerance)},${Math.round(p[1] / tolerance)}`;
  const ends = new Map<string, number[]>();
  const used = new Uint8Array(segments.length);
  segments.forEach((s, i) => {
    if (same([s.start[0], s.start[1]], [s.end[0], s.end[1]])) {
      // A full circle is a loop of its own.
      if (s.type === 'arc') loops.push([s]);
      used[i] = 1;
      return;
    }
    for (const p of [s.start, s.end]) {
      const k = key(p);
      ends.set(k, [...(ends.get(k) ?? []), i]);
    }
  });
  const near = (p: number[]) => {
    const cx = Math.round(p[0] / tolerance);
    const cy = Math.round(p[1] / tolerance);
    const found: number[] = [];
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) for (const s of ends.get(`${cx + i},${cy + j}`) ?? []) if (!used[s]) found.push(s);
    return found;
  };
  const close = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tolerance * 2;
  for (let first = 0; first < segments.length; first++) {
    if (used[first]) continue;
    used[first] = 1;
    const loop = [segments[first]];
    for (;;) {
      const tail = loop[loop.length - 1].end;
      if (loop.length > 1 && close(tail, loop[0].start)) {
        loops.push(loop);
        break;
      }
      const next = near(tail).find((i) => close(segments[i].start, tail) || close(segments[i].end, tail));
      if (next === undefined) break;
      used[next] = 1;
      const s = segments[next];
      loop.push(close(s.start, tail) ? s : reverse([s])[0]);
    }
  }
  if (!loops.length) return null;
  const path = new Path2D();
  const box: Box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const loop of loops) {
    addSegments(path, loop, true);
    for (const s of loop) {
      for (const [x, y] of s.type === 'arc' ? [[s.center[0] - s.radius, s.center[1] - s.radius], [s.center[0] + s.radius, s.center[1] + s.radius]] : [s.start, s.end]) {
        box[0] = Math.min(box[0], x);
        box[1] = Math.min(box[1], y);
        box[2] = Math.max(box[2], x);
        box[3] = Math.max(box[3], y);
      }
    }
  }
  return { path, box };
}

// ---- Snapping --------------------------------------------------------------------------------------------------------

const MAX_SNAP_POINTS = 400_000;

/** Pad and hole centers (circles with their radius), ends of tracks and edges; lines and arcs to snap onto. */
export function snapData(layers: PcbLayer[]): { points: Point2[]; shapes: Shape2[] } {
  const points: Point2[] = [];
  const shapes: Shape2[] = [];
  const addSegments = (segments: PathSegment[], dx: number, dy: number, lines: boolean) => {
    for (const s of segments) {
      if (points.length > MAX_SNAP_POINTS) return;
      const a = { x: s.start[0] + dx, y: s.start[1] + dy };
      const b = { x: s.end[0] + dx, y: s.end[1] + dy };
      points.push(a, b);
      if (s.type === 'arc') {
        const center = { x: s.center[0] + dx, y: s.center[1] + dy };
        points.push({ ...center, radius: s.radius, arc: Math.abs(s.end[2] - s.start[2]) < 2 * Math.PI - 1e-6 });
        const [start, end] = s.end[2] >= s.start[2] ? [s.start[2], s.end[2]] : [s.end[2], s.start[2]];
        if (lines) shapes.push({ kind: 'circle', center, radius: s.radius, ...(end - start < 2 * Math.PI - 1e-6 ? { start, end } : {}) });
      } else if (lines) {
        shapes.push({ kind: 'line', a, b });
      }
    }
  };
  const addShape = (shape: Shape, dx: number, dy: number) => {
    switch (shape.type) {
      case 'circle':
        points.push({ x: shape.cx + dx, y: shape.cy + dy, radius: shape.r });
        shapes.push({ kind: 'circle', center: { x: shape.cx + dx, y: shape.cy + dy }, radius: shape.r });
        break;
      case 'rectangle':
        points.push({ x: shape.x + shape.xSize / 2 + dx, y: shape.y + shape.ySize / 2 + dy });
        break;
      default: {
        const [x1, y1, x2, y2] = shapeBox(shape);
        if (Number.isFinite(x1)) points.push({ x: (x1 + x2) / 2 + dx, y: (y1 + y2) / 2 + dy });
      }
    }
  };
  for (const layer of layers) {
    const edges = layer.type === 'outline';
    for (const block of layer.blocks) {
      const { nx, ny, dx, dy } = block.repeat ?? { nx: 1, ny: 1, dx: 0, dy: 0 };
      for (let i = 0; i < nx; i++) {
        for (let j = 0; j < ny; j++) {
          for (const run of block.runs) {
            if (!run.dark) continue;
            for (const g of run.graphics) {
              if (points.length > MAX_SNAP_POINTS) break;
              if (g.type === 'imageShape') addShape(g.shape, i * dx, j * dy);
              else addSegments(g.segments, i * dx, j * dy, edges || g.type === 'imagePath');
            }
          }
        }
      }
    }
  }
  return { points, shapes };
}

// ---- Colors ----------------------------------------------------------------------------------------------------------

/** Layer colors for the layer view, on dark and on light paper, after the KiCad defaults. */
const PALETTE: Record<string, [dark: string, light: string]> = {
  'copper-top': ['#e05a47', '#c8352a'],
  'copper-bottom': ['#4f8fe0', '#2a62b8'],
  'copper-inner': ['#d3b23a', '#94780c'],
  'soldermask-top': ['#b06ad8', '#8e44b8'],
  'soldermask-bottom': ['#2fb7a9', '#13867a'],
  'silkscreen-top': ['#f0ec9c', '#7c7400'],
  'silkscreen-bottom': ['#e8b2a7', '#9a5a4c'],
  'solderpaste-top': ['#b4a0a0', '#7d6a6a'],
  'solderpaste-bottom': ['#9fb0c0', '#5a6e80'],
  drill: ['#e9edf2', '#1b1e23'],
  outline: ['#f2c94c', '#a87a00'],
  other: ['#8f99a5', '#6b7480'],
};

export function layerColor(layer: Pick<PcbLayer, 'type' | 'side'>, darkPaper: boolean): string {
  const key = layer.type === 'drill' || layer.type === 'outline' ? layer.type : `${layer.type}-${layer.side}`;
  return (PALETTE[key] ?? PALETTE.other)[darkPaper ? 0 : 1];
}

const LAYER_ALPHA: Partial<Record<LayerType, number>> = { copper: 0.82, soldermask: 0.55, solderpaste: 0.7 };
export const layerAlpha = (type: LayerType) => LAYER_ALPHA[type] ?? 0.9;

/** The finished board: green mask, gold (ENIG) finish on open copper, white print. */
export const BOARD = {
  substrate: '#7d7445',
  copper: '#b5793a',
  mask: 'rgba(16, 92, 46, 0.86)',
  finish: '#d9b35b',
  silk: '#f3f3ee',
  paste: '#a9a9a9',
};

// ---- Drawing ---------------------------------------------------------------------------------------------------------

export type Matrix = [number, number, number, number, number, number];

/** Draws a layer in one color; clear polarity erases what the layer drew before. */
export function drawLayer(ctx: CanvasRenderingContext2D, paths: LayerPaths, view: Matrix, pixel: number, color: string): void {
  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const block of paths.blocks) {
    for (const [dx, dy] of block.offsets) {
      const [a, b, c, d, e, f] = view;
      ctx.setTransform(a, b, c, d, e + a * dx + c * dy, f + b * dx + d * dy);
      for (const run of block.runs) {
        ctx.globalCompositeOperation = run.dark ? 'source-over' : 'destination-out';
        ctx.fill(run.fill, 'nonzero');
        ctx.fill(run.evenOdd, 'evenodd');
        for (const [width, path] of run.strokes) {
          ctx.lineWidth = Math.max(width, pixel);
          ctx.stroke(path);
        }
        for (const pad of run.erasable) drawErasable(ctx, pad);
      }
    }
  }
  ctx.globalCompositeOperation = 'source-over';
}

/** A macro pad whose later parts erase earlier ones: each part is drawn clipped to outside the erasing parts after it. */
function drawErasable(ctx: CanvasRenderingContext2D, pad: RunPaths['erasable'][number]): void {
  const [x1, y1, x2, y2] = pad.box;
  pad.paths.forEach((part, i) => {
    if (part.erase) return;
    ctx.save();
    for (const later of pad.paths.slice(i + 1)) {
      if (!later.erase) continue;
      const outside = new Path2D();
      outside.rect(x1 - 1, y1 - 1, x2 - x1 + 2, y2 - y1 + 2);
      outside.addPath(later.path);
      ctx.clip(outside, 'evenodd');
    }
    ctx.fill(part.path, part.evenOdd ? 'evenodd' : 'nonzero');
    ctx.restore();
  });
}
