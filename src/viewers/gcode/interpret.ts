// SPDX-License-Identifier: GPL-3.0-or-later
// Turns a G-code program into tool paths: straight and arc moves (G0–G3 in the G17/G18/G19 planes), units,
// absolute and incremental coordinates, G92 offsets and the drilling cycles G73/G81–G89. 3D printer files are
// recognized by their extrusion words (E). Variables, expressions and subprograms are not evaluated.
// Every segment keeps its source line, in program order, for playback and for linking code and 3D view.

export interface GcodeResult {
  /** All moves in program order: start and end point (x y z each) per segment. */
  positions: Float32Array;
  /** Source line (0-based) of each segment. */
  lines: Uint32Array;
  /** 0 = rapid or travel move, 1 = cutting or extrusion move. */
  kinds: Uint8Array;
  /** Tool number in use for each segment (0 before the first tool change). */
  tools: Uint32Array;
  /** Bottom points of drilled holes (x y z each), their tool, and the segment count once each is drilled. */
  holes: Float32Array;
  holeTools: Uint32Array;
  holeDoneAt: Uint32Array;
  /** Arcs as the program states them, 7 values each: center x y z, radius, full circle (1/0), first segment, segment count. */
  arcs: Float64Array;
  unit: 'mm' | 'in';
  /** Extrusion words found: a 3D printer program, where moves without extrusion are travel. */
  printer: boolean;
  lineCount: number;
  feedLength: number;
  rapidLength: number;
  /** Lines with variables, expressions or calls that were left out. */
  skipped: number;
}

const WORD = /([A-Z])\s*([+-]?(?:\d+\.?\d*|\.\d+))/g;
const CYCLES = new Set([73, 81, 82, 83, 84, 85, 86, 87, 88, 89]);
/** G codes whose axis words are not a move (dwell, offsets, home, machine coordinates). */
const NO_MOVE = new Set([4, 10, 28, 30, 53, 92]);
const ARC_STEP = Math.PI / 36;

/** Plane axes for arcs: first and second axis of the circle, the linear axis, and the center-offset letters. */
const PLANES: Record<number, { a: number; b: number; c: number; ia: string; ib: string }> = {
  17: { a: 0, b: 1, c: 2, ia: 'I', ib: 'J' },
  18: { a: 2, b: 0, c: 1, ia: 'K', ib: 'I' },
  19: { a: 1, b: 2, c: 0, ia: 'J', ib: 'K' },
};

type Vec = [number, number, number];

export function interpret(text: string): GcodeResult {
  const printer = /^[^;(\n]*\bG[01]\b[^;(\n]*\bE[+-]?[\d.]/im.test(text);
  const usesM6 = /\bM0*6\b/i.test(text);
  const positions: number[] = [];
  const segLines: number[] = [];
  const segKinds: number[] = [];
  const segTools: number[] = [];
  const holes: number[] = [];
  const holeTools: number[] = [];
  const holeDoneAt: number[] = [];
  const arcs: number[] = [];
  let unit: 'mm' | 'in' | null = null;
  let pos: Vec = [0, 0, 0];
  const offset: Vec = [0, 0, 0];
  let absolute = true;
  let arcAbsolute = false;
  let plane = 17;
  let motion = 0;
  let tool = 0;
  let nextTool = 0;
  let retractToInitial = true;
  let cycleZ = 0;
  let cycleR = 0;
  let initialZ = 0;
  let extrusion = 0;
  let relativeExtrusion = false;
  let feedLength = 0;
  let rapidLength = 0;
  let skipped = 0;
  let lineNo = 0;

  const add = (feed: boolean, from: Vec, to: Vec) => {
    const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    if (length === 0) return;
    if (feed) feedLength += length;
    else rapidLength += length;
    positions.push(from[0], from[1], from[2], to[0], to[1], to[2]);
    segLines.push(lineNo);
    segKinds.push(feed ? 1 : 0);
    segTools.push(tool);
  };

  const arc = (clockwise: boolean, from: Vec, to: Vec, words: Map<string, number>) => {
    const p = PLANES[plane];
    const fa = from[p.a];
    const fb = from[p.b];
    const ta = to[p.a];
    const tb = to[p.b];
    let ca: number;
    let cb: number;
    const r = words.get('R');
    if (r !== undefined) {
      // Radius form: the center lies on the perpendicular bisector; R < 0 asks for the arc over 180°.
      const dx = ta - fa;
      const dy = tb - fb;
      const d = Math.hypot(dx, dy);
      if (d === 0) return add(true, from, to);
      const h = Math.sqrt(Math.max(0, r * r - (d * d) / 4));
      const side = (clockwise ? -1 : 1) * (r < 0 ? -1 : 1);
      ca = (fa + ta) / 2 - (side * h * dy) / d;
      cb = (fb + tb) / 2 + (side * h * dx) / d;
    } else {
      const ia = words.get(p.ia) ?? 0;
      const ib = words.get(p.ib) ?? 0;
      ca = arcAbsolute ? ia + offset[p.a] : fa + ia;
      cb = arcAbsolute ? ib + offset[p.b] : fb + ib;
    }
    const radius = Math.hypot(fa - ca, fb - cb);
    const start = Math.atan2(fb - cb, fa - ca);
    let end = Math.atan2(tb - cb, ta - ca);
    if (clockwise) {
      if (end >= start - 1e-9) end -= 2 * Math.PI;
    } else if (end <= start + 1e-9) end += 2 * Math.PI;
    const sweep = end - start;
    const steps = Math.min(720, Math.max(4, Math.ceil(Math.abs(sweep) / ARC_STEP)));
    // The exact center and radius, for measuring; a helix gets its center halfway up.
    const center: Vec = [0, 0, 0];
    center[p.a] = ca;
    center[p.b] = cb;
    center[p.c] = (from[p.c] + to[p.c]) / 2;
    const first = segLines.length;
    let prev: Vec = from;
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      const angle = start + sweep * t;
      const next: Vec = [0, 0, 0];
      next[p.a] = ca + radius * Math.cos(angle);
      next[p.b] = cb + radius * Math.sin(angle);
      next[p.c] = from[p.c] + (to[p.c] - from[p.c]) * t;
      add(true, prev, s === steps ? to : next);
      prev = next;
    }
    if (radius > 0) arcs.push(...center, radius, Math.abs(sweep) >= 2 * Math.PI - 1e-6 ? 1 : 0, first, segLines.length - first);
  };

  const drill = (words: Map<string, number>) => {
    if (words.has('R')) cycleR = words.get('R')!;
    if (words.has('Z')) cycleZ = words.get('Z')!;
    const x = words.has('X') ? (absolute ? words.get('X')! + offset[0] : pos[0] + words.get('X')!) : pos[0];
    const y = words.has('Y') ? (absolute ? words.get('Y')! + offset[1] : pos[1] + words.get('Y')!) : pos[1];
    // Incremental: R is measured from the initial height, Z from the R plane.
    const rPlane = absolute ? cycleR + offset[2] : initialZ + cycleR;
    const bottom = absolute ? cycleZ + offset[2] : rPlane + cycleZ;
    const above: Vec = [x, y, pos[2]];
    add(false, pos, above);
    add(false, above, [x, y, rPlane]);
    add(true, [x, y, rPlane], [x, y, bottom]);
    const back: Vec = [x, y, retractToInitial ? Math.max(initialZ, rPlane) : rPlane];
    add(false, [x, y, bottom], back);
    holes.push(x, y, bottom);
    holeTools.push(tool);
    holeDoneAt.push(segLines.length);
    pos = back;
  };

  const rawLines = text.split('\n');
  for (; lineNo < rawLines.length; lineNo++) {
    const line = rawLines[lineNo].replace(/\([^)]*\)/g, '').replace(/;.*/, '').trim().toUpperCase().replace(/^\//, '');
    if (!line || line.startsWith('%') || line.startsWith('O')) continue;
    if (/[#[=]|^[A-Z_]{2,}/.test(line)) {
      skipped++;
      continue;
    }
    const gs: number[] = [];
    const ms: number[] = [];
    const words = new Map<string, number>();
    for (const [, letter, value] of line.matchAll(WORD)) {
      const n = Number(value);
      if (letter === 'G') gs.push(n);
      else if (letter === 'M') ms.push(n);
      else words.set(letter, n);
    }

    let moves = true;
    const wasCycle = CYCLES.has(motion);
    for (const g of gs) {
      if (g === 0 || g === 1 || g === 2 || g === 3) motion = g;
      else if (g === 17 || g === 18 || g === 19) plane = g;
      else if (g === 20) unit ??= 'in';
      else if (g === 21) unit ??= 'mm';
      else if (g === 90) absolute = true;
      else if (g === 91) absolute = false;
      else if (g === 90.1) arcAbsolute = true;
      else if (g === 91.1) arcAbsolute = false;
      else if (g === 98) retractToInitial = true;
      else if (g === 99) retractToInitial = false;
      // After a cycle is cancelled, plain coordinates are taken as rapid moves.
      else if (g === 80) motion = 0;
      else if (CYCLES.has(g)) motion = g;
      if (NO_MOVE.has(g)) moves = false;
      if (g === 92) {
        // Sets the current position to the given values without moving: shifts the program origin.
        (['X', 'Y', 'Z'] as const).forEach((axis, i) => {
          if (words.has(axis)) offset[i] = pos[i] - words.get(axis)!;
        });
        if (words.has('E')) extrusion = words.get('E')!;
      }
    }
    if (CYCLES.has(motion) && !wasCycle) initialZ = pos[2];
    for (const m of ms) {
      if (m === 82) relativeExtrusion = false;
      else if (m === 83) relativeExtrusion = true;
    }
    if (words.has('T')) {
      nextTool = words.get('T')!;
      if (!usesM6) tool = nextTool;
    }
    if (ms.includes(6)) tool = nextTool;
    if (!moves) continue;

    const hasAxis = words.has('X') || words.has('Y') || words.has('Z');
    if (CYCLES.has(motion)) {
      if (hasAxis || words.has('R')) drill(words);
      continue;
    }
    const hasArc = motion >= 2 && (words.has('I') || words.has('J') || words.has('K') || words.has('R'));
    if (!hasAxis && !hasArc) continue;
    const target: Vec = [...pos];
    (['X', 'Y', 'Z'] as const).forEach((axis, i) => {
      if (words.has(axis)) target[i] = absolute ? words.get(axis)! + offset[i] : pos[i] + words.get(axis)!;
    });
    if (motion === 0) add(false, pos, target);
    else if (motion === 1) {
      let feed = true;
      if (printer) {
        const e = words.get('E');
        feed = e !== undefined && (relativeExtrusion ? e > 0 : e > extrusion);
        if (e !== undefined && !relativeExtrusion) extrusion = e;
      }
      add(feed, pos, target);
    } else arc(motion === 2, pos, target, words);
    pos = target;
  }

  return {
    positions: new Float32Array(positions),
    lines: new Uint32Array(segLines),
    kinds: new Uint8Array(segKinds),
    tools: new Uint32Array(segTools),
    holes: new Float32Array(holes),
    holeTools: new Uint32Array(holeTools),
    holeDoneAt: new Uint32Array(holeDoneAt),
    arcs: new Float64Array(arcs),
    unit: unit ?? 'mm',
    printer,
    lineCount: rawLines.length,
    feedLength,
    rapidLength,
    skipped,
  };
}
