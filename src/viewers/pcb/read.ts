// SPDX-License-Identifier: GPL-3.0-or-later
// Reads Gerber (RS-274X, X2) and Excellon drill files with the parser and plotter of tracespace (MIT): which board
// layer each file is, and its shapes in millimeters. The plotter knows neither polarity nor step and repeat, so a
// Gerber file is cut at %LP and %SR and each part plotted on its own, starting with the tools, modes and position the
// part before it ended with.
import { parse, COMMENT, COORDINATE_FORMAT, DONE, DRILL, DRILL_HEADER, GRAPHIC, INTERPOLATE_MODE, LOAD_POLARITY, MOVE, QUADRANT_MODE, STEP_REPEAT, TOOL_CHANGE, TOOL_DEFINITION, TOOL_MACRO, UNITS } from '@tracespace/parser';
import type { GerberNode, GerberTree } from '@tracespace/parser';
import { plot, BoundingBox, ARC, CIRCLE, IMAGE_PATH, IMAGE_REGION, IMAGE_SHAPE, LAYERED_SHAPE, OUTLINE, POLYGON, RECTANGLE } from '@tracespace/plotter';
import type { ImageGraphic, PathSegment, Shape } from '@tracespace/plotter';
import { identifyLayers } from '@tracespace/identify-layers';

export type { ImageGraphic, PathSegment, Shape } from '@tracespace/plotter';

export type LayerType = 'copper' | 'soldermask' | 'silkscreen' | 'solderpaste' | 'drill' | 'outline' | 'drawing' | 'other';
export type LayerSide = 'top' | 'bottom' | 'inner' | 'all';

/** Consecutive graphics of one polarity: dark adds to the layer, clear erases what is below. */
export interface PcbRun {
  dark: boolean;
  graphics: ImageGraphic[];
}

export interface PcbBlock {
  /** Step and repeat: copies along X and Y and their distances in mm. */
  repeat: { nx: number; ny: number; dx: number; dy: number } | null;
  runs: PcbRun[];
}

export interface PcbLayer {
  name: string;
  /** "Gerber X2", "Gerber" or "Excellon". */
  format: string;
  type: LayerType;
  side: LayerSide;
  /** Drill files: plated holes; false for NPTH. */
  plated?: boolean;
  /** Units the file was written in. */
  units: 'mm' | 'in';
  blocks: PcbBlock[];
  /** x1, y1, x2, y2 in mm. */
  bounds: [number, number, number, number] | null;
}

export interface PcbReadResult {
  layers: PcbLayer[];
  warnings: string[];
}

const GERBER_HINT = /%FS[LTD]?[AI]?X\d\dY\d\d|%MO(?:IN|MM)\*%|^G04[ *]/m;
const DRILL_HINT = /^M48\s*$|^(?:METRIC|INCH)(?:,|\s*$)|^T\d+(?:F\d+S\d+)?C\d*\.?\d+/m;

/** Gerber or Excellon, from the content; null for anything else (job files, read-me files, BOMs). */
export function sniffPcbText(text: string): 'gerber' | 'drill' | null {
  const head = text.slice(0, 65536);
  if (head.includes('\0')) return null;
  if (GERBER_HINT.test(head)) return 'gerber';
  if (DRILL_HINT.test(head)) return 'drill';
  return null;
}

/** X2 file function, also from the "#@!" comments KiCad writes into drill files and older Gerber files. */
function fileFunction(text: string): string[] | null {
  const match = /TF\.FileFunction,([^*%\r\n]+)/.exec(text.slice(0, 65536));
  return match ? match[1].split(',').map((part) => part.trim()) : null;
}

function fromFileFunction(parts: string[]): { type: LayerType; side: LayerSide; plated?: boolean } {
  const [what, ...rest] = parts;
  const side = (value: string | undefined): LayerSide => (/^top$/i.test(value ?? '') ? 'top' : /^bot/i.test(value ?? '') ? 'bottom' : 'all');
  switch (what.toLowerCase()) {
    case 'copper': {
      const where = rest.find((p) => /^(?:top|bot|inr)$/i.test(p));
      return { type: 'copper', side: /^inr$/i.test(where ?? '') ? 'inner' : side(where) };
    }
    case 'soldermask':
      return { type: 'soldermask', side: side(rest[0]) };
    case 'legend':
      return { type: 'silkscreen', side: side(rest[0]) };
    case 'paste':
      return { type: 'solderpaste', side: side(rest[0]) };
    case 'profile':
      return { type: 'outline', side: 'all' };
    case 'plated':
      return { type: 'drill', side: 'all', plated: true };
    case 'nonplated':
      return { type: 'drill', side: 'all', plated: false };
    default:
      return { type: 'drawing', side: side(rest.find((p) => /^(?:top|bot)$/i.test(p))) };
  }
}

const baseName = (name: string) => name.replace(/\\/g, '/').replace(/^.*\//, '');

/** Multiplies every coordinate and size; plots are in the file's units, the viewer works in mm. */
function scaleSegment(s: PathSegment, k: number): PathSegment {
  if (s.type === ARC) {
    return { type: ARC, start: [s.start[0] * k, s.start[1] * k, s.start[2]], end: [s.end[0] * k, s.end[1] * k, s.end[2]], center: [s.center[0] * k, s.center[1] * k], radius: s.radius * k };
  }
  return { type: s.type, start: [s.start[0] * k, s.start[1] * k], end: [s.end[0] * k, s.end[1] * k] };
}

function scaleShape(shape: Shape, k: number): Shape {
  switch (shape.type) {
    case CIRCLE:
      return { ...shape, cx: shape.cx * k, cy: shape.cy * k, r: shape.r * k };
    case RECTANGLE:
      return { ...shape, x: shape.x * k, y: shape.y * k, xSize: shape.xSize * k, ySize: shape.ySize * k, ...(shape.r !== undefined ? { r: shape.r * k } : {}) };
    case POLYGON:
      return { ...shape, points: shape.points.map(([x, y]) => [x * k, y * k]) };
    case OUTLINE:
      return { ...shape, segments: shape.segments.map((s) => scaleSegment(s, k)) };
    case LAYERED_SHAPE:
      return { ...shape, shapes: shape.shapes.map((s) => scaleShape(s, k) as typeof s) };
  }
}

function scaleGraphic(g: ImageGraphic, k: number): ImageGraphic {
  if (k === 1) return g;
  switch (g.type) {
    case IMAGE_SHAPE:
      return { type: IMAGE_SHAPE, shape: scaleShape(g.shape, k) };
    case IMAGE_PATH:
      return { type: IMAGE_PATH, width: g.width * k, segments: g.segments.map((s) => scaleSegment(s, k)) };
    case IMAGE_REGION:
      return { type: IMAGE_REGION, segments: g.segments.map((s) => scaleSegment(s, k)) };
  }
}

type Position = [number, number];

const convexHull = (points: Position[]): Position[] => {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: Position, a: Position, b: Position) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list: Position[]) => {
    const hull: Position[] = [];
    for (const p of list) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  return [...half(sorted), ...half(sorted.reverse())];
};

/**
 * Works around two bugs of the tracespace plotter (5.0.0-alpha.0), rebuilding the shapes from the points it got right:
 * vector-line macro primitives (code 20, used by KiCad's rounded pads) come out offset along the line instead of across
 * it, and strokes with rectangular apertures pick their outline corners by a wrong angle.
 */
function repairShape(shape: Shape): Shape {
  if (shape.type !== LAYERED_SHAPE) return shape;
  return {
    ...shape,
    shapes: shape.shapes.map((s) => {
      if (s.type !== POLYGON) return s;
      const p = s.points as Position[];
      if (s.erase === undefined && p.length === 6) {
        // A stroke: points 0, 1 and 5 are corners of the rectangle at the start, 2–4 of the one at the end.
        const corners = (list: Position[]) => {
          const xs = list.map((q) => q[0]);
          const ys = list.map((q) => q[1]);
          return [Math.min(...xs), Math.max(...xs)].flatMap((x) => [Math.min(...ys), Math.max(...ys)].map((y): Position => [x, y]));
        };
        return { ...s, points: convexHull([...corners([p[0], p[1], p[5]]), ...corners([p[2], p[3], p[4]])]) };
      }
      if (p.length !== 4) return s;
      const ux = p[1][0] - p[0][0];
      const uy = p[1][1] - p[0][1];
      const vx = p[3][0] - p[0][0];
      const vy = p[3][1] - p[0][1];
      if (Math.abs(ux * vx + uy * vy) <= 1e-9 * (Math.hypot(ux, uy) * Math.hypot(vx, vy) + 1e-9)) return s;
      // A vector line: its ends are the middles of the short sides, its half width their length.
      const start: Position = [(p[0][0] + p[3][0]) / 2, (p[0][1] + p[3][1]) / 2];
      const end: Position = [(p[1][0] + p[2][0]) / 2, (p[1][1] + p[2][1]) / 2];
      const half = Math.hypot(vx, vy) / 2;
      const length = Math.hypot(end[0] - start[0], end[1] - start[1]);
      if (!(length > 0) || !Number.isFinite(half)) return { ...s, points: [] };
      const nx = ((end[1] - start[1]) / length) * half;
      const ny = (-(end[0] - start[0]) / length) * half;
      return { ...s, points: [[start[0] + nx, start[1] + ny], [end[0] + nx, end[1] + ny], [end[0] - nx, end[1] - ny], [start[0] - nx, start[1] - ny]] };
    }),
  };
}

/** The tree's nodes in parts that differ in polarity or step and repeat, each a tree the plotter can take alone. */
function splitTree(tree: GerberTree): { dark: boolean; repeat: Record<string, number> | null; tree: GerberTree }[] {
  const nodes = tree.children;
  if (!nodes.some((n) => n.type === LOAD_POLARITY || n.type === STEP_REPEAT)) return [{ dark: true, repeat: null, tree }];
  const state: GerberNode[] = [];
  let tool: string | undefined;
  let interpolate: GerberNode | undefined;
  let quadrant: GerberNode | undefined;
  let x: string | undefined;
  let y: string | undefined;
  let dark = true;
  let repeat: Record<string, number> | null = null;
  let current: GerberNode[] = [];
  const parts: { dark: boolean; repeat: Record<string, number> | null; tree: GerberTree }[] = [];
  const close = () => {
    if (current.some((n) => n.type === GRAPHIC)) parts.push({ dark, repeat, tree: { ...tree, children: [...current, { type: DONE }] } });
    const resume: GerberNode[] = [...state];
    if (tool !== undefined) resume.push({ type: TOOL_CHANGE, code: tool });
    if (interpolate) resume.push(interpolate);
    if (quadrant) resume.push(quadrant);
    if (x !== undefined || y !== undefined) resume.push({ type: GRAPHIC, graphic: MOVE, coordinates: { ...(x !== undefined && { x }), ...(y !== undefined && { y }) } });
    current = resume;
  };
  for (const node of nodes) {
    switch (node.type) {
      case LOAD_POLARITY:
        close();
        dark = node.polarity !== 'clear';
        continue;
      case STEP_REPEAT: {
        close();
        const { x: nx = 1, y: ny = 1 } = node.stepRepeat;
        repeat = nx > 1 || ny > 1 ? node.stepRepeat : null;
        continue;
      }
      case UNITS:
      case COORDINATE_FORMAT:
      case TOOL_MACRO:
      case DRILL_HEADER:
        state.push(node);
        break;
      case COMMENT:
        if (/FORMAT|suppress|keep zeros/i.test(node.comment)) state.push(node);
        break;
      case TOOL_DEFINITION:
        state.push(node);
        tool = node.code;
        break;
      case TOOL_CHANGE:
        tool = node.code;
        break;
      case INTERPOLATE_MODE:
        interpolate = node;
        break;
      case QUADRANT_MODE:
        quadrant = node;
        break;
      case GRAPHIC:
        x = node.coordinates.x ?? x;
        y = node.coordinates.y ?? y;
        break;
    }
    current.push(node);
  }
  close();
  return parts;
}

function readOne(name: string, text: string): Omit<PcbLayer, 'type' | 'side'> & { tree: GerberTree; func: string[] | null } {
  const tree = parse(text);
  const func = fileFunction(text);
  const blocks: PcbBlock[] = [];
  let units: 'mm' | 'in' = 'in';
  let box = BoundingBox.empty();
  for (const part of splitTree(tree)) {
    const image = plot(part.tree);
    units = image.units === 'mm' ? 'mm' : 'in';
    const k = units === 'in' ? 25.4 : 1;
    const graphics = image.children.map((g) => scaleGraphic(g.type === IMAGE_SHAPE ? { ...g, shape: repairShape(g.shape) } : g, k));
    const repeat = part.repeat ? { nx: Math.max(1, Math.round(part.repeat.x ?? 1)), ny: Math.max(1, Math.round(part.repeat.y ?? 1)), dx: (part.repeat.i ?? 0) * k, dy: (part.repeat.j ?? 0) * k } : null;
    const last = blocks[blocks.length - 1];
    const block = last && (last.repeat === repeat || JSON.stringify(last.repeat) === JSON.stringify(repeat)) ? last : (blocks.push({ repeat, runs: [] }), blocks[blocks.length - 1]);
    const previous = block.runs[block.runs.length - 1];
    if (previous && previous.dark === part.dark) previous.graphics.push(...graphics);
    else block.runs.push({ dark: part.dark, graphics });
    if (part.dark && graphics.length) {
      const own = BoundingBox.fromGraphics(graphics);
      if (!BoundingBox.isEmpty(own)) {
        const [x1, y1, x2, y2] = own;
        const far = repeat ? [x2 + (repeat.nx - 1) * repeat.dx, y2 + (repeat.ny - 1) * repeat.dy] : [x2, y2];
        box = BoundingBox.add(box, [x1, y1, far[0], far[1]]);
      }
    }
  }
  const x2 = func !== null && tree.filetype !== DRILL;
  return {
    name,
    format: tree.filetype === DRILL ? 'Excellon' : x2 ? 'Gerber X2' : 'Gerber',
    units,
    blocks,
    bounds: BoundingBox.isEmpty(box) ? null : (box as [number, number, number, number]),
    tree,
    func,
  };
}

/** Reads all files that are Gerber or Excellon; others are skipped, broken ones reported. */
export function readPcbFiles(files: { name: string; text: string }[]): PcbReadResult {
  const warnings: string[] = [];
  const read: ReturnType<typeof readOne>[] = [];
  for (const { name, text } of files) {
    if (!sniffPcbText(text)) continue;
    try {
      const layer = readOne(name, text);
      if (layer.blocks.some((b) => b.runs.some((r) => r.graphics.length))) read.push(layer);
    } catch (error) {
      warnings.push(`${baseName(name)}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const gerberNames = read.filter((l) => l.tree.filetype !== DRILL).map((l) => baseName(l.name).toLowerCase());
  const byName = identifyLayers(gerberNames);
  const layers = read.map(({ tree, func, ...layer }): PcbLayer => {
    const lower = baseName(layer.name).toLowerCase();
    if (tree.filetype === DRILL) {
      const plated = func ? !/^nonplated$/i.test(func[0]) : !/npth|non[-_ ]?plated/i.test(lower);
      return { ...layer, type: 'drill', side: 'all', plated };
    }
    if (func) return { ...layer, ...fromFileFunction(func) };
    // A plain .gbr or .ger says nothing about the layer; tracespace calls that a drawing.
    const identity = byName[lower];
    if (identity?.type && identity.type !== 'drawing') return { ...layer, type: identity.type, side: identity.side ?? 'all' };
    return { ...layer, type: 'other', side: 'all' };
  });
  return { layers, warnings };
}
