// SPDX-License-Identifier: GPL-3.0-or-later
// HP-GL and HP-GL/2 plot files to DXF text, so that the 2D drawing view can show them: lines, arcs and circles,
// filled and outlined rectangles, wedges and polygons, labels, one layer per pen in the pen's color. A PCL or PJL
// wrapper around HP-GL/2 is skipped, raster (RTL) data in it too. One plotter unit is 0.025 mm; the DXF is in mm.

const PLU_MM = 0.025;
/** ISO A4 landscape, used for P1/P2 and the hard-clip limits until the file sets them. */
const DEFAULT_LIMITS = { x: 11880, y: 8400 };

/** HP-GL/2 default palette: pen 0 white, 1 black, 2 red, 3 green, 4 yellow, 5 blue, 6 magenta, 7 cyan. */
const DEFAULT_COLORS: [number, number, number][] = [
  [255, 255, 255], [0, 0, 0], [255, 0, 0], [0, 255, 0], [255, 255, 0], [0, 0, 255], [255, 0, 255], [0, 255, 255],
];

// Every HP-GL, HP-GL/2 and RTL-in-HP-GL mnemonic, to tell plot files from other text that happens to use .plt.
const MNEMONICS = new Set(
  ('AA AC AD AF AH AP AR AS AT BF BL BP BR BZ CA CC CF CI CM CO CP CR CS CT CV DC DF DI DL DP DR DS DT DV EA EC EP ER ES ' +
    'EW FI FN FP FR FS FT GC GM GP IM IN IP IR IV IW KY LA LB LM LO LT MC MG MT NP NR OA OC OD OE OF OG OH OI OK OL OO OP ' +
    'OS OT OW PA PB PC PD PE PG PM PP PR PS PT PU PW QL RA RF RO RP RR RT SA SB SC SD SG SI SL SM SP SR SS ST SV TD TL TR ' +
    'UC UL VS WD WG WU XT YT').split(' '),
);
/** Instructions that put something on paper; a plot file has at least one of them. */
const DRAWING = new Set(['PD', 'PE', 'PA', 'PR', 'CI', 'AA', 'AR', 'AT', 'RT', 'EA', 'ER', 'RA', 'RR', 'EW', 'WG', 'LB', 'BZ', 'BR', 'FP', 'EP']);

type Point = [number, number];

interface Polyline { pen: number; points: Point[]; closed: boolean }
interface Arc { pen: number; cx: number; cy: number; r: number; start: number; end: number; full: boolean }
interface Label { pen: number; x: number; y: number; height: number; width: number; rotation: number; text: string; h: number; v: number }
interface Fill { pen: number; loops: Point[][]; solid: boolean; angle: number; spacing: number; cross: boolean }

export interface HpglResult {
  /** False when the text is not HP-GL at all (e.g. a gnuplot script). */
  isHpgl: boolean;
  dxf: string;
  warnings: string[];
  /** "HP-GL/2" when HP-GL/2 instructions or a PCL wrapper were seen, else "HP-GL". */
  dialect: string;
  entities: number;
}

// ---- PCL / PJL wrapper ------------------------------------------------------------------------------------------------

/** The HP-GL parts of the data: PJL headers and PCL commands are dropped, binary PCL data (raster images) skipped. */
function extractHpgl(s: string): { text: string; raster: boolean; wrapped: boolean } {
  let text = '';
  let raster = false;
  let wrapped = false;
  // Data that starts like a PCL job is PCL until it switches to HP-GL/2.
  let hpgl = !/^\s*(?:\x1b%-12345X|@PJL|\x1bE)/.test(s);
  let i = 0;
  const pjl = () => {
    // PJL lines follow a universal exit; ENTER LANGUAGE says what comes after them.
    for (;;) {
      while (i < s.length && /[\r\n\s]/.test(s[i]) && s[i] !== '\x1b') i++;
      if (!s.startsWith('@PJL', i)) return;
      const end = s.indexOf('\n', i);
      const line = s.slice(i, end < 0 ? s.length : end);
      const language = /ENTER\s+LANGUAGE\s*=\s*(\S+)/i.exec(line)?.[1];
      if (language) hpgl = /^HPGL/i.test(language);
      i = end < 0 ? s.length : end + 1;
    }
  };
  if (!hpgl) pjl();
  while (i < s.length) {
    const esc = s.indexOf('\x1b', i);
    const end = esc < 0 ? s.length : esc;
    if (hpgl) text += s.slice(i, end);
    if (esc < 0) break;
    i = esc + 1;
    wrapped = true;
    const c = s[i];
    if (c === '%') {
      // ESC % -12345 X (universal exit), ESC % # B (to HP-GL/2), ESC % # A (to PCL).
      const m = /^%(-?\d*)([ABX])/.exec(s.slice(i, i + 12));
      if (!m) {
        i++;
        continue;
      }
      i += m[0].length;
      if (m[2] === 'B') hpgl = true;
      else if (m[2] === 'A') hpgl = false;
      else {
        hpgl = false;
        pjl();
      }
    } else if (c === '.') {
      // HP-GL/1 device control: ESC . x, some with parameters up to a colon.
      const kind = s[i + 1] ?? '';
      i += 2;
      if ('@HIMNPQST'.includes(kind)) {
        const colon = s.indexOf(':', i);
        if (colon >= 0 && colon - i < 80) i = colon + 1;
      }
    } else if (c !== undefined && c >= '!' && c <= '/') {
      // Parameterized PCL: ESC & l 1 O, ESC * b 120 W <120 bytes>, combined as ESC * r 1 a 0 B.
      const group = s[i + 1] ?? '';
      i += 2;
      for (;;) {
        const m = /^[+-]?\d*\.?\d*([`-~@-^])/.exec(s.slice(i, i + 24));
        if (!m) break;
        i += m[0].length;
        const parameter = m[1];
        const value = Math.abs(parseFloat(m[0])) || 0;
        if (c === '*' && group === 'b' && (parameter === 'W' || parameter === 'w') && value > 0) raster = true;
        if (parameter === 'W' || parameter === 'w' || (c === '&' && group === 'p' && (parameter === 'X' || parameter === 'x'))) i += value;
        if (parameter >= '@' && parameter <= '^') break;
      }
    } else {
      // Two-character escapes such as ESC E (reset).
      i++;
    }
  }
  return { text, raster, wrapped };
}

// ---- Tokens ---------------------------------------------------------------------------------------------------------

interface Instruction {
  op: string;
  /** Numbers, and for BP/CO etc. quoted strings. */
  args: (number | string)[];
  /** LB text, PE data, DT terminator, SM symbol. */
  raw?: string;
}

function* instructions(text: string, stats: { known: number; unknown: number }): Generator<Instruction> {
  const n = text.length;
  let p = 0;
  let terminator = '\x03';
  const isLetter = (c: string) => (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z');
  while (p < n) {
    const c = text[p];
    if (!isLetter(c)) {
      if (!/[\s;,\x00-\x1f]/.test(c)) stats.unknown++;
      p++;
      continue;
    }
    if (!isLetter(text[p + 1] ?? '')) {
      stats.unknown++;
      p++;
      continue;
    }
    const op = (c + text[p + 1]).toUpperCase();
    p += 2;
    if (MNEMONICS.has(op)) stats.known++;
    else stats.unknown++;
    if (op === 'LB') {
      const end = text.indexOf(terminator, p);
      const stop = end < 0 ? n : end;
      yield { op, args: [], raw: text.slice(p, stop) };
      p = stop + 1;
      continue;
    }
    if (op === 'PE') {
      const end = text.indexOf(';', p);
      const stop = end < 0 ? n : end;
      yield { op, args: [], raw: text.slice(p, stop) };
      p = stop + 1;
      continue;
    }
    if (op === 'DT' || op === 'SM') {
      // One character parameter (a terminator for labels, a symbol); DT; alone restores ETX.
      let raw = '';
      if (p < n && text[p] !== ';') raw = text[p++];
      const end = text.indexOf(';', p);
      if (end >= 0 && end - p < 8) p = end + 1;
      if (op === 'DT') terminator = raw || '\x03';
      yield { op, args: [], raw };
      continue;
    }
    if (op === 'WD' || op === 'BL') {
      const end = text.indexOf(terminator, p);
      p = end < 0 ? n : end + 1;
      continue;
    }
    const args: (number | string)[] = [];
    for (;;) {
      while (p < n && /[\s,]/.test(text[p])) p++;
      if (p >= n) break;
      const ch = text[p];
      if (ch === ';') {
        p++;
        break;
      }
      if (ch === '"') {
        const end = text.indexOf('"', p + 1);
        args.push(text.slice(p + 1, end < 0 ? n : end));
        p = end < 0 ? n : end + 1;
        continue;
      }
      const m = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(text.slice(p, p + 32));
      if (!m) break;
      args.push(parseFloat(m[0]));
      p += m[0].length;
    }
    yield { op, args };
  }
}

/** Polyline Encoded (PE) data: flags and base-64 (or base-32 in 7-bit mode) numbers, sign in the lowest bit. */
function* decodePE(data: string): Generator<{ flag: string } | { value: number }> {
  let sevenBit = false;
  let value = 0;
  let scale = 1;
  for (const ch of data) {
    const c = ch.charCodeAt(0);
    if (!sevenBit && c >= 63 && c <= 126) {
      value += (c - 63) * scale;
      scale *= 64;
    } else if (!sevenBit && c >= 191 && c <= 254) {
      value += (c - 191) * scale;
      yield { value: value % 2 ? -(value - 1) / 2 : value / 2 };
      value = 0;
      scale = 1;
    } else if (sevenBit && c >= 63 && c <= 94) {
      value += (c - 63) * scale;
      scale *= 32;
    } else if (sevenBit && c >= 95 && c <= 126) {
      value += (c - 95) * scale;
      yield { value: value % 2 ? -(value - 1) / 2 : value / 2 };
      value = 0;
      scale = 1;
    } else if (':<>=7'.includes(ch)) {
      if (ch === '7') sevenBit = true;
      yield { flag: ch };
    }
  }
}

// ---- Interpreter ----------------------------------------------------------------------------------------------------

export function convertHpgl(bytes: Uint8Array): HpglResult {
  // Labels and PE data use all 8 bits; latin1 keeps every byte as one character.
  const source = new TextDecoder('latin1').decode(bytes);
  const { text, raster, wrapped } = extractHpgl(source);
  const warnings: string[] = [];
  if (raster) warnings.push('The file contains raster (RTL) image data, which is not shown.');

  const polylines: Polyline[] = [];
  const arcs: Arc[] = [];
  const labels: Label[] = [];
  const fills: Fill[] = [];
  const colors = new Map<number, [number, number, number]>();
  const widths = new Map<number, number>();
  const usedPens = new Set<number>();
  const stats = { known: 0, unknown: 0 };
  let drawingOps = 0;
  let hpgl2 = wrapped;

  // State, reset by IN and (partly) DF.
  let pos: Point = [0, 0];
  let down = false;
  let absolute = true;
  let pen = 1;
  let p1: Point = [0, 0];
  let p2: Point = [DEFAULT_LIMITS.x, DEFAULT_LIMITS.y];
  let limits: Point = [DEFAULT_LIMITS.x, DEFAULT_LIMITS.y];
  /** User units → plotter units: x = ox + ux * kx, y = oy + uy * ky. */
  let scale: { ox: number; oy: number; kx: number; ky: number } | null = null;
  let scArgs: number[] | null = null;
  let rotation = 0;
  let fillType = { type: 1, spacing: 0, angle: 0 };
  let colorRange = { min: [0, 0, 0], max: [255, 255, 255] };
  let charSize = { w: 1.9 / PLU_MM, h: 2.7 / PLU_MM };
  let relativeSize: [number, number] | null = null;
  let direction = 0;
  let relativeDirection: [number, number] | null = null;
  let origin = 1;
  let polygon: Point[][] | null = null;
  let polygonDone: Point[][] = [];
  let current: Polyline | null = null;

  const resetScaling = () => {
    scale = null;
    if (scArgs) applyScale(scArgs);
  };
  const applyScale = (args: number[]) => {
    const [x1, x2, y1, y2, type = 0, left = 50, bottom = 50] = args;
    if (type === 2) {
      scale = { ox: p1[0] - x1 * x2, oy: p1[1] - y1 * y2, kx: x2, ky: y2 };
    } else {
      let kx = (p2[0] - p1[0]) / (x2 - x1 || 1);
      let ky = (p2[1] - p1[1]) / (y2 - y1 || 1);
      let ox = p1[0] - x1 * kx;
      let oy = p1[1] - y1 * ky;
      if (type === 1) {
        const k = Math.min(Math.abs(kx), Math.abs(ky));
        const extraX = (p2[0] - p1[0]) - k * Math.abs(x2 - x1) * Math.sign(p2[0] - p1[0] || 1);
        const extraY = (p2[1] - p1[1]) - k * Math.abs(y2 - y1) * Math.sign(p2[1] - p1[1] || 1);
        kx = k * Math.sign(kx);
        ky = k * Math.sign(ky);
        ox = p1[0] + (extraX * left) / 100 - x1 * kx;
        oy = p1[1] + (extraY * bottom) / 100 - y1 * ky;
      }
      scale = { ox, oy, kx, ky };
    }
  };
  const initialize = (full: boolean) => {
    if (full) {
      pos = [0, 0];
      down = false;
      pen = 1;
      p1 = [0, 0];
      p2 = [...limits];
      rotation = 0;
      polygon = null;
    }
    absolute = true;
    scale = null;
    scArgs = null;
    fillType = { type: 1, spacing: 0, angle: 0 };
    charSize = { w: 1.9 / PLU_MM, h: 2.7 / PLU_MM };
    relativeSize = null;
    direction = 0;
    relativeDirection = null;
    origin = 1;
  };
  initialize(true);

  /** User coordinates → plotter units. */
  const toPlu = (x: number, y: number): Point => (scale ? [scale.ox + x * scale.kx, scale.oy + y * scale.ky] : [x, y]);
  const deltaToPlu = (dx: number, dy: number): Point => (scale ? [dx * scale.kx, dy * scale.ky] : [dx, dy]);
  const mirrored = () => !!scale && scale.kx * scale.ky < 0;
  /** Plotter units → output mm, turned by RO. */
  const out = ([x, y]: Point): Point => {
    const a = (rotation * Math.PI) / 180;
    const c = Math.round(Math.cos(a) * 1e9) / 1e9;
    const s = Math.round(Math.sin(a) * 1e9) / 1e9;
    return [(x * c - y * s) * PLU_MM, (x * s + y * c) * PLU_MM];
  };

  const flush = () => {
    if (current && current.points.length > 1) polylines.push(current);
    current = null;
  };
  const use = (p: number) => usedPens.add(p);
  /** Moves the pen; draws a line when it is down. */
  const moveTo = (target: Point, draw: boolean) => {
    if (polygon) {
      if (draw) {
        if (!polygon.length) polygon.push([pos]);
        polygon[polygon.length - 1].push(target);
      } else {
        // A pen-up move starts the next subpolygon.
        const last = polygon[polygon.length - 1];
        if (!last || last.length > 1) polygon.push([target]);
        else last[0] = target;
      }
      pos = target;
      return;
    }
    if (draw && pen > 0) {
      if (!current || current.pen !== pen) {
        flush();
        current = { pen, points: [out(pos)], closed: false };
        use(pen);
      }
      current.points.push(out(target));
    } else if (current) {
      flush();
    }
    pos = target;
  };

  /** An arc around `center` from the current position by `sweep` degrees (counterclockwise when positive). */
  const arc = (center: Point, sweepDegrees: number, draw: boolean) => {
    const sweep = ((mirrored() ? -sweepDegrees : sweepDegrees) * Math.PI) / 180;
    const r = Math.hypot(pos[0] - center[0], pos[1] - center[1]);
    const start = Math.atan2(pos[1] - center[1], pos[0] - center[0]);
    const endPoint: Point = [center[0] + r * Math.cos(start + sweep), center[1] + r * Math.sin(start + sweep)];
    if (polygon || !(draw && pen > 0)) {
      if (polygon && draw) {
        const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
        for (let k = 1; k <= steps; k++) moveTo([center[0] + r * Math.cos(start + (sweep * k) / steps), center[1] + r * Math.sin(start + (sweep * k) / steps)], true);
        return;
      }
      moveTo(endPoint, false);
      return;
    }
    flush();
    if (r > 0) addArc(center, r, start, sweep);
    pos = endPoint;
  };
  const addArc = (center: Point, r: number, start: number, sweep: number) => {
    use(pen);
    const [cx, cy] = out(center);
    const turn = (rotation * Math.PI) / 180;
    const [a, b] = sweep >= 0 ? [start, start + sweep] : [start + sweep, start];
    arcs.push({ pen, cx, cy, r: r * PLU_MM, start: a + turn, end: b + turn, full: Math.abs(sweep) >= 2 * Math.PI - 1e-9 });
  };

  const circleLoop = (center: Point, r: number): Point[] =>
    Array.from({ length: 72 }, (_, k) => [center[0] + r * Math.cos((k * Math.PI) / 36), center[1] + r * Math.sin((k * Math.PI) / 36)] as Point);

  /** A closed outline (EA, ER, EW, EP) or a fill (RA, RR, WG, FP) in plotter units. */
  const shape = (loops: Point[][], filled: boolean) => {
    if (pen <= 0) return;
    use(pen);
    flush();
    // Closed loops without the repeated first point.
    const mm = loops
      .map((l) => (l.length > 1 && l[0][0] === l[l.length - 1][0] && l[0][1] === l[l.length - 1][1] ? l.slice(0, -1) : l))
      .filter((l) => l.length > 2)
      .map((l) => l.map(out));
    if (!mm.length) return;
    if (!filled) {
      for (const points of mm) polylines.push({ pen, points, closed: true });
      return;
    }
    const { type, spacing, angle } = fillType;
    const hatch = type === 3 || type === 4;
    // Hatch spacing is in user units along X; 1 % of the P1-P2 diagonal when not given.
    const defaultSpacing = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) * 0.01;
    const step = (spacing ? Math.abs(deltaToPlu(spacing, 0)[0]) : defaultSpacing) * PLU_MM;
    fills.push({ pen, loops: mm, solid: !hatch, angle: angle + rotation, spacing: step || 1, cross: type === 4 });
  };

  const wedgeLoop = (r: number, startDeg: number, sweepDeg: number): Point[] => {
    const center = pos;
    const radius = Math.abs(deltaToPlu(r, 0)[0]);
    const start = (startDeg * Math.PI) / 180;
    const sweep = (sweepDeg * Math.PI) / 180;
    const steps = Math.max(2, Math.ceil(Math.abs(sweep) / (Math.PI / 36)));
    const points: Point[] = Math.abs(sweepDeg) >= 360 ? [] : [center];
    for (let k = 0; k <= steps; k++) points.push([center[0] + radius * Math.cos(start + (sweep * k) / steps), center[1] + radius * Math.sin(start + (sweep * k) / steps)]);
    return points;
  };

  const rectLoop = (corner: Point): Point[] => [pos, [corner[0], pos[1]], corner, [pos[0], corner[1]]];

  /** Label size in plotter units: SI is in cm, SR in percent of P2 − P1. */
  const labelSize = (): { w: number; h: number } => {
    if (relativeSize) return { w: (relativeSize[0] / 100) * Math.abs(p2[0] - p1[0]), h: (relativeSize[1] / 100) * Math.abs(p2[1] - p1[1]) };
    return charSize;
  };

  const label = (raw: string) => {
    if (pen <= 0) return;
    flush();
    const { w, h } = labelSize();
    const angle = relativeDirection
      ? Math.atan2(relativeDirection[1] * (p2[1] - p1[1]), relativeDirection[0] * (p2[0] - p1[0]))
      : direction;
    const lines = raw.replace(/\r\n?/g, '\n').split('\n');
    const kind = origin % 10;
    const hAlign = kind <= 3 ? 0 : kind <= 6 ? 1 : 2;
    const vAlign = [0, 0, 2, 3][((kind - 1) % 3) + 1];
    const advance = w * 1.5;
    lines.forEach((line, index) => {
      // Control characters other than the line breaks are dropped.
      const clean = line.replace(/[\x00-\x1f\x7f]/g, '');
      const shift = index * h * 2;
      const at: Point = [pos[0] + shift * Math.sin(angle), pos[1] - shift * Math.cos(angle)];
      if (clean.trim()) {
        use(pen);
        const [x, y] = out(at);
        labels.push({ pen, x, y, height: h * PLU_MM, width: Math.min(3, Math.max(0.3, w / h / (1.9 / 2.7))), rotation: (angle * 180) / Math.PI + rotation, text: clean, h: hAlign, v: vAlign });
      }
      if (index === lines.length - 1) pos = [at[0] + clean.length * advance * Math.cos(angle), at[1] + clean.length * advance * Math.sin(angle)];
    });
  };

  const coordinatePairs = (args: (number | string)[]) => {
    const nums = args.filter((a): a is number => typeof a === 'number');
    const pairs: Point[] = [];
    for (let k = 0; k + 1 < nums.length; k += 2) pairs.push([nums[k], nums[k + 1]]);
    return pairs;
  };
  const go = (pairs: Point[], draw: boolean) => {
    for (const [x, y] of pairs) {
      const target = absolute ? toPlu(x, y) : ((d) => [pos[0] + d[0], pos[1] + d[1]] as Point)(deltaToPlu(x, y));
      moveTo(target, draw);
    }
  };

  for (const { op, args, raw } of instructions(text, stats)) {
    const num = (k: number, fallback: number) => (typeof args[k] === 'number' ? (args[k] as number) : fallback);
    if (DRAWING.has(op)) drawingOps++;
    switch (op) {
      case 'IN':
        flush();
        initialize(true);
        break;
      case 'DF':
        initialize(false);
        break;
      case 'PU':
        down = false;
        go(coordinatePairs(args), false);
        if (!args.length && current) flush();
        break;
      case 'PD':
        down = true;
        go(coordinatePairs(args), true);
        break;
      case 'PA':
        absolute = true;
        go(coordinatePairs(args), down);
        break;
      case 'PR':
        absolute = false;
        go(coordinatePairs(args), down);
        break;
      case 'PE': {
        hpgl2 = true;
        let fraction = 1;
        let nextUp = false;
        let nextAbsolute = false;
        let expect: string | null = null;
        let x: number | null = null;
        for (const item of decodePE(raw ?? '')) {
          if ('flag' in item) {
            if (item.flag === '<') nextUp = true;
            else if (item.flag === '=') nextAbsolute = true;
            else if (item.flag === ':' || item.flag === '>') expect = item.flag;
            continue;
          }
          if (expect === ':') {
            flush();
            pen = item.value;
            expect = null;
            continue;
          }
          if (expect === '>') {
            fraction = 2 ** item.value;
            expect = null;
            continue;
          }
          if (x === null) {
            x = item.value / fraction;
            continue;
          }
          const y = item.value / fraction;
          const target = nextAbsolute ? toPlu(x, y) : ((d) => [pos[0] + d[0], pos[1] + d[1]] as Point)(deltaToPlu(x, y));
          down = !nextUp;
          moveTo(target, down);
          x = null;
          nextUp = false;
          nextAbsolute = false;
        }
        break;
      }
      case 'SP':
        flush();
        pen = Math.max(0, Math.round(num(0, 0)));
        break;
      case 'CI': {
        const r = Math.abs(deltaToPlu(num(0, 0), 0)[0]);
        if (!r) break;
        if (polygon) {
          // The circle is a subpolygon of its own; drawing continues in a new one.
          polygon.push(circleLoop(pos, r), [pos]);
          break;
        }
        if (pen <= 0) break;
        flush();
        addArc(pos, r, 0, 2 * Math.PI);
        break;
      }
      case 'AA':
      case 'AR': {
        if (args.length < 3) break;
        const center = op === 'AA' ? toPlu(num(0, 0), num(1, 0)) : ((d) => [pos[0] + d[0], pos[1] + d[1]] as Point)(deltaToPlu(num(0, 0), num(1, 0)));
        arc(center, num(2, 0), down);
        break;
      }
      case 'AT':
      case 'RT': {
        if (args.length < 4) break;
        const rel = (x: number, y: number) => ((d) => [pos[0] + d[0], pos[1] + d[1]] as Point)(deltaToPlu(x, y));
        const mid = op === 'AT' ? toPlu(num(0, 0), num(1, 0)) : rel(num(0, 0), num(1, 0));
        const end = op === 'AT' ? toPlu(num(2, 0), num(3, 0)) : rel(num(2, 0), num(3, 0));
        const center = circumcenter(pos, mid, end);
        if (!center) {
          moveTo(end, down);
          break;
        }
        // Sweep from the start through the middle point to the end.
        const angleOf = (p: Point) => Math.atan2(p[1] - center[1], p[0] - center[0]);
        const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
        const a0 = angleOf(pos);
        const toMid = norm(angleOf(mid) - a0);
        const toEnd = norm(angleOf(end) - a0);
        const sweep = toMid <= toEnd ? toEnd : toEnd - 2 * Math.PI;
        arc(center, ((mirrored() ? -sweep : sweep) * 180) / Math.PI, down);
        pos = end;
        break;
      }
      case 'BZ':
      case 'BR': {
        const pairs = coordinatePairs(args);
        for (let k = 0; k + 2 < pairs.length; k += 3) {
          const p0 = pos;
          const [c1, c2, e] = pairs.slice(k, k + 3).map(([x, y]) => (op === 'BZ' ? toPlu(x, y) : ((d) => [p0[0] + d[0], p0[1] + d[1]] as Point)(deltaToPlu(x, y))));
          for (let t = 1; t <= 16; t++) {
            const u = t / 16;
            const v = 1 - u;
            moveTo([v ** 3 * p0[0] + 3 * v * v * u * c1[0] + 3 * v * u * u * c2[0] + u ** 3 * e[0], v ** 3 * p0[1] + 3 * v * v * u * c1[1] + 3 * v * u * u * c2[1] + u ** 3 * e[1]], down);
          }
        }
        break;
      }
      case 'EA':
      case 'RA':
        if (args.length >= 2) shape([rectLoop(toPlu(num(0, 0), num(1, 0)))], op === 'RA');
        break;
      case 'ER':
      case 'RR':
        if (args.length >= 2) shape([rectLoop(((d) => [pos[0] + d[0], pos[1] + d[1]] as Point)(deltaToPlu(num(0, 0), num(1, 0))))], op === 'RR');
        break;
      case 'EW':
      case 'WG':
        if (args.length >= 3) shape([wedgeLoop(num(0, 0), num(1, 0), num(2, 0))], op === 'WG');
        break;
      case 'PM': {
        const mode = num(0, 0);
        flush();
        if (mode === 0) {
          polygon = [[pos]];
          polygonDone = [];
        } else if (polygon) {
          polygonDone.push(...polygon.filter((l) => l.length > 2));
          polygon = mode === 1 ? [[pos]] : null;
        }
        break;
      }
      case 'EP':
        shape(polygonDone, false);
        break;
      case 'FP':
        shape(polygonDone, true);
        break;
      case 'FT':
        fillType = { type: num(0, 1), spacing: num(1, 0), angle: num(2, 0) };
        break;
      case 'SC':
        if (args.length >= 4) {
          scArgs = args.filter((a): a is number => typeof a === 'number');
          applyScale(scArgs);
        } else {
          scArgs = null;
          scale = null;
        }
        break;
      case 'IP':
        if (args.length >= 2) {
          const [x1, y1, x2, y2] = args as number[];
          const w = p2[0] - p1[0];
          const hgt = p2[1] - p1[1];
          p1 = [x1, y1];
          p2 = args.length >= 4 ? [x2, y2] : [x1 + w, y1 + hgt];
        } else {
          p1 = [0, 0];
          p2 = [...limits];
        }
        resetScaling();
        break;
      case 'IR': {
        const [a = 0, b = 0, c, d = 0] = args as number[];
        p1 = [(a / 100) * limits[0], (b / 100) * limits[1]];
        p2 = c !== undefined ? [(c / 100) * limits[0], (d / 100) * limits[1]] : [p1[0] + p2[0] - p1[0], p1[1] + p2[1] - p1[1]];
        resetScaling();
        break;
      }
      case 'PS':
        if (args.length) {
          limits = [num(0, limits[0]), num(1, limits[1])];
          p1 = [0, 0];
          p2 = [...limits];
        }
        break;
      case 'RO':
        rotation = ((Math.round(num(0, 0) / 90) * 90) % 360 + 360) % 360;
        break;
      case 'SI':
        relativeSize = null;
        charSize = args.length >= 2 ? { w: (num(0, 0.19) * 10) / PLU_MM, h: (num(1, 0.27) * 10) / PLU_MM } : { w: 1.9 / PLU_MM, h: 2.7 / PLU_MM };
        break;
      case 'SR':
        relativeSize = args.length >= 2 ? [num(0, 0.75), num(1, 1.5)] : [0.75, 1.5];
        break;
      case 'SD': {
        // Standard font: kind 4 is the height in points (cap height about 70 % of it), kind 3 the pitch.
        hpgl2 = true;
        const nums = args.filter((a): a is number => typeof a === 'number');
        for (let k = 0; k + 1 < nums.length; k += 2) {
          if (nums[k] === 4) charSize = { ...charSize, h: (nums[k + 1] * 0.3528 * 0.7) / PLU_MM };
          if (nums[k] === 3 && nums[k + 1] > 0) charSize = { ...charSize, w: (25.4 / nums[k + 1] / 1.5) / PLU_MM };
        }
        relativeSize = null;
        break;
      }
      case 'DI':
        relativeDirection = null;
        direction = args.length >= 2 ? Math.atan2(num(1, 0), num(0, 1)) : 0;
        break;
      case 'DR':
        relativeDirection = args.length >= 2 ? [num(0, 1), num(1, 0)] : null;
        if (!relativeDirection) direction = 0;
        break;
      case 'LO':
        origin = Math.max(1, Math.min(19, Math.round(num(0, 1)))) || 1;
        break;
      case 'LB':
        label(raw ?? '');
        break;
      case 'CP': {
        const { w, h } = labelSize();
        const spaces = num(0, 0);
        const lines = num(1, 0);
        pos = [pos[0] + spaces * w * 1.5 * Math.cos(direction) + lines * h * 2 * Math.sin(direction), pos[1] + spaces * w * 1.5 * Math.sin(direction) + lines * h * 2 * Math.cos(direction)];
        break;
      }
      case 'NP':
        hpgl2 = true;
        break;
      case 'CR':
        if (args.length >= 6) colorRange = { min: [num(0, 0), num(2, 0), num(4, 0)], max: [num(1, 255), num(3, 255), num(5, 255)] };
        break;
      case 'PC': {
        hpgl2 = true;
        const p = Math.round(num(0, -1));
        if (p < 0) break;
        if (args.length >= 4) {
          const channel = (k: number) => {
            const lo = colorRange.min[k];
            const hi = colorRange.max[k];
            return Math.round(Math.min(255, Math.max(0, ((num(k + 1, lo) - lo) / (hi - lo || 1)) * 255)));
          };
          colors.set(p, [channel(0), channel(1), channel(2)]);
        } else {
          colors.delete(p);
        }
        break;
      }
      case 'PW': {
        hpgl2 = true;
        const width = num(0, 0.35);
        if (args.length >= 2) widths.set(Math.round(num(1, 0)), width);
        else for (let p = 0; p < 256; p++) widths.set(p, width);
        break;
      }
      case 'BP':
      case 'WU':
      case 'LT':
      case 'CT':
      case 'TR':
      case 'MC':
      case 'PP':
        if (op === 'BP' || op === 'WU') hpgl2 = true;
        break;
    }
  }
  flush();

  const isHpgl = stats.known >= 2 && drawingOps > 0 && stats.unknown <= Math.max(3, stats.known * 0.1);
  const entities = polylines.length + arcs.length + labels.length + fills.length;
  return {
    isHpgl,
    dxf: isHpgl ? writeDxf({ polylines, arcs, labels, fills, colors, widths, pens: [...usedPens].sort((a, b) => a - b) }) : '',
    warnings,
    dialect: hpgl2 ? 'HP-GL/2' : 'HP-GL',
    entities,
  };
}

function circumcenter(a: Point, b: Point, c: Point): Point | null {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-9) return null;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  return [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
}

// ---- DXF ------------------------------------------------------------------------------------------------------------

/** Nearest of the seven basic AutoCAD colors, for readers that ignore true colors. */
function aci([r, g, b]: [number, number, number]): number {
  const basic: [number, [number, number, number]][] = [[1, [255, 0, 0]], [2, [255, 255, 0]], [3, [0, 255, 0]], [4, [0, 255, 255]], [5, [0, 0, 255]], [6, [255, 0, 255]], [7, [255, 255, 255]], [7, [0, 0, 0]]];
  let best = 7;
  let distance = Infinity;
  for (const [index, [cr, cg, cb]] of basic) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < distance) {
      distance = d;
      best = index;
    }
  }
  return best;
}

const fmt = (v: number) => {
  const s = v.toFixed(4);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') || '0' : s;
};

export const penLayer = (pen: number) => `Pen ${pen}`;

function writeDxf(d: {
  polylines: Polyline[];
  arcs: Arc[];
  labels: Label[];
  fills: Fill[];
  colors: Map<number, [number, number, number]>;
  widths: Map<number, number>;
  pens: number[];
}): string {
  const g: string[] = [];
  const add = (...pairs: (string | number)[]) => {
    for (let k = 0; k < pairs.length; k += 2) g.push(String(pairs[k]), typeof pairs[k + 1] === 'number' ? fmt(pairs[k + 1] as number) : String(pairs[k + 1]));
  };
  const colorOf = (pen: number) => d.colors.get(pen) ?? DEFAULT_COLORS[pen < DEFAULT_COLORS.length ? pen : ((pen - 1) % 7) + 1];
  add(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1015', 9, '$INSUNITS', 70, 4, 0, 'ENDSEC');
  add(0, 'SECTION', 2, 'TABLES');
  add(0, 'TABLE', 2, 'LTYPE', 70, 1, 0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0, 0, 'ENDTAB');
  add(0, 'TABLE', 2, 'LAYER', 70, d.pens.length);
  for (const pen of d.pens) {
    const rgb = colorOf(pen);
    const width = d.widths.get(pen);
    // Lineweight in 1/100 mm; the 2D view draws thin lines regardless, other readers may use it.
    add(0, 'LAYER', 2, penLayer(pen), 70, 0, 62, aci(rgb), 420, (rgb[0] << 16) | (rgb[1] << 8) | rgb[2], 6, 'CONTINUOUS');
    if (width !== undefined) add(370, Math.round(width * 100));
  }
  add(0, 'ENDTAB', 0, 'ENDSEC');
  add(0, 'SECTION', 2, 'ENTITIES');
  for (const p of d.polylines) {
    add(0, 'LWPOLYLINE', 8, penLayer(p.pen), 90, p.points.length, 70, p.closed ? 1 : 0);
    for (const [x, y] of p.points) add(10, x, 20, y);
  }
  for (const a of d.arcs) {
    if (a.full) add(0, 'CIRCLE', 8, penLayer(a.pen), 10, a.cx, 20, a.cy, 30, 0, 40, a.r);
    else add(0, 'ARC', 8, penLayer(a.pen), 10, a.cx, 20, a.cy, 30, 0, 40, a.r, 50, (a.start * 180) / Math.PI, 51, (a.end * 180) / Math.PI);
  }
  for (const f of d.fills) {
    add(0, 'HATCH', 8, penLayer(f.pen), 10, 0, 20, 0, 30, 0, 210, 0, 220, 0, 230, 1, 2, f.solid ? 'SOLID' : 'USER', 70, f.solid ? 1 : 0, 71, 0, 91, f.loops.length);
    for (const loop of f.loops) {
      add(92, 3, 72, 0, 73, 1, 93, loop.length);
      for (const [x, y] of loop) add(10, x, 20, y);
      add(97, 0);
    }
    add(75, 0, 76, f.solid ? 1 : 0);
    if (!f.solid) {
      const angles = f.cross ? [f.angle, f.angle + 90] : [f.angle];
      add(52, 0, 41, 1, 77, 0, 78, angles.length);
      for (const angle of angles) {
        const a = (angle * Math.PI) / 180;
        add(53, angle, 43, 0, 44, 0, 45, -f.spacing * Math.sin(a), 46, f.spacing * Math.cos(a), 79, 0);
      }
    }
    add(98, 0);
  }
  for (const t of d.labels) {
    add(0, 'TEXT', 8, penLayer(t.pen), 10, t.x, 20, t.y, 30, 0, 40, t.height, 1, t.text, 50, t.rotation, 41, t.width);
    if (t.h || t.v) add(72, t.h, 11, t.x, 21, t.y, 31, 0, 73, t.v);
  }
  add(0, 'ENDSEC', 0, 'EOF');
  return `${g.join('\r\n')}\r\n`;
}
