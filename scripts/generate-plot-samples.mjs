// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the plotter and circuit board samples: the flange plate of cad/flange.dxf as HP-GL/2 (in a PJL wrapper, with
// encoded polylines, arcs, several pens, text and a hatched section) and as classic HP-GL, and a small two-layer
// board as Gerber X2/RS-274X and Excellon files, also zipped. Everything is drawn from scratch here, so the output can
// be published as CC0-1.0 like the other samples.
// Usage: node scripts/generate-plot-samples.mjs [file ...] (no dependencies). With file names (relative to samples/),
// only those are written.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..', 'samples');
const written = [];
const only = process.argv.slice(2).map((rel) => rel.replace(/\\/g, '/').replace(/^samples\//, ''));

function write(rel, data) {
  if (only.length && !only.includes(rel)) return;
  const file = path.join(ROOT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  written.push([rel, Buffer.byteLength(data)]);
}

/** ZIP archive with deflated entries; fixed date, so regenerating gives identical bytes. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const plain = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const data = deflateRawSync(plain, { level: 9 });
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(plain);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0x21, 12); // DOS date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(plain.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(plain.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

// ---- HP-GL: the flange plate of cad/flange.dxf ------------------------------------------------------------------------
// Plate 160 × 160 with corner radius 15, bore Ø 60, six holes Ø 13 on a bolt circle Ø 110, center lines, two texts.
// On A3 paper with the plate's center at (210, 160) mm; 1 plotter unit = 0.025 mm.

const ESC = '\x1b';
const ETX = '\x03';
const PLU = 40;
const ORIGIN = [210, 160];
const plu = (x, y) => [Math.round((ORIGIN[0] + x) * PLU), Math.round((ORIGIN[1] + y) * PLU)];
const at = (x, y) => plu(x, y).join(',');
const holes = Array.from({ length: 6 }, (_, i) => [55 * Math.cos((i * Math.PI) / 3), 55 * Math.sin((i * Math.PI) / 3)]);

/** One number in Polyline Encoded form: sign in the lowest bit, base 64 (8-bit) or base 32 (7-bit), lowest digit first. */
function peNumber(n, sevenBit = false) {
  let v = n >= 0 ? 2 * n : 2 * -n + 1;
  const base = sevenBit ? 32 : 64;
  let s = '';
  while (v >= base) {
    s += String.fromCharCode(63 + (v % base));
    v = Math.floor(v / base);
  }
  return s + String.fromCharCode((sevenBit ? 95 : 191) + v);
}
const pe = (values, sevenBit = false) => values.map((v) => peNumber(v, sevenBit)).join('');

function flangeHpgl2() {
  const out = [];
  out.push(`${ESC}%-12345X@PJL JOB NAME = "flange"\r\n@PJL ENTER LANGUAGE = HPGL2\r\n`);
  out.push('BP1,"flange";IN;PS16800,11880;RO0;NP8;PC1,0,0,0;PC2,200,30,30;PC3,30,80,200;PC4,20,140,60;');
  out.push('WU0;PW0.5,1;PW0.35,2;PW0.18,3;PW0.25,4;\n');
  // Outline: straight edges as encoded polylines (pen up to the absolute start, then relative), corners as arcs.
  const s = 80;
  const r = 15;
  const corners = [[s - r, -s + r], [s - r, s - r], [-s + r, s - r], [-s + r, -s + r]];
  const edges = [[2 * (s - r) * PLU, 0], [0, 2 * (s - r) * PLU], [-2 * (s - r) * PLU, 0], [0, -2 * (s - r) * PLU]];
  out.push('SP1;');
  out.push(`PE<=${pe(plu(-s + r, -s))}${pe(edges[0])};`);
  for (let k = 0; k < 4; k++) {
    out.push(`AA${at(...corners[k])},90;`);
    if (k < 3) out.push(`PE${pe(edges[k + 1])};`);
  }
  out.push('PU;\n');
  // Bore and holes.
  out.push(`SP2;PU${at(0, 0)};CI${30 * PLU};`);
  for (const [x, y] of holes) out.push(`PU${at(x, y)};CI${6.5 * PLU};`);
  out.push('PU;\n');
  // Center lines and bolt circle in a dash-dot line type; hole crosses as one encoded polyline in 7-bit mode,
  // selecting pen 3 itself.
  out.push(`SP3;LT4,4;PU${at(-95, 0)};PD${at(95, 0)};PU${at(0, -95)};PD${at(0, 95)};PU${at(0, 0)};CI${55 * PLU};LT;`);
  const crosses = [];
  for (const [x, y] of holes) {
    const [hx, hy] = plu(x, y);
    crosses.push('<=', pe([hx - 9 * PLU, hy], true), pe([18 * PLU, 0], true), '<=', pe([hx, hy - 9 * PLU], true), pe([0, 18 * PLU], true));
  }
  out.push(`PE7:${pe([3], true)}${crosses.join('')};PU;\n`);
  // Section A–A to the right: the plate cut along the vertical center line, hatched at 45°.
  out.push(`SP3;FT3,${3 * PLU},45;PU${at(110, 30)};PM0;PD${at(122, 30)},${at(122, 80)},${at(110, 80)},${at(110, 30)};PM1;`);
  out.push(`PU${at(110, -80)};PD${at(122, -80)},${at(122, -30)},${at(110, -30)},${at(110, -80)};PM2;FP;SP1;EP;PU;\n`);
  // Text in pen 4.
  out.push(`SP4;DT${ETX},1;SI0.49,0.7;PU${at(-80, -115)};LBFLANGE PLATE 160x160x12  -  material S235JR${ETX}`);
  out.push(`SI0.28,0.4;PU${at(-80, -127)};LBSample drawing, generated by generate-plot-samples.mjs${ETX}`);
  out.push(`SI0.35,0.5;LO4;PU${at(116, 86)};LBA-A${ETX}LO1;\n`);
  out.push('PU;SP0;PG;');
  out.push(`${ESC}%-12345X@PJL EOJ\r\n${ESC}%-12345X`);
  return Buffer.from(out.join(''), 'latin1');
}

/** The same plate in classic HP-GL: user units in mm through SC, absolute and relative coordinate lists. */
function flangeHpgl1() {
  const out = [];
  const f = (v) => Number(v.toFixed(3)).toString();
  out.push('IN;IP0,0,16800,11880;SC-210,40,-160,40,2;\n');
  out.push('SP1;PA;PU-65,-80;PD65,-80;AA65,-65,90;PD80,65;AA65,65,90;PD-65,80;AA-65,65,90;PD-80,-65;AA-65,-65,90;PU;\n');
  out.push('SP2;PU0,0;CI30;');
  for (const [x, y] of holes) out.push(`PU${f(x)},${f(y)};CI6.5;`);
  out.push('\nSP3;LT4,2;PU-95,0;PD95,0;PU0,-95;PD0,95;PU0,0;CI55;LT;');
  // Hole crosses with relative moves.
  for (const [x, y] of holes) out.push(`PA;PU${f(x - 9)},${f(y)};PR;PD18,0;PU-9,-9;PD0,18;`);
  out.push('PA;PU;\n');
  out.push(`SP4;SI0.49,0.7;PU-80,-115;LBFLANGE PLATE 160x160x12  -  material S235JR${ETX}`);
  out.push(`SI0.28,0.4;PU-80,-127;LBClassic HP-GL version, generated by generate-plot-samples.mjs${ETX}\n`);
  out.push('PU;SP0;\n');
  return out.join('');
}

// ---- Circuit board: 50 × 30 mm, two layers -------------------------------------------------------------------------

const BOARD = { w: 50, h: 30, r: 2 };
const header = [11.19, 13.73, 16.27, 18.81].map((y, i) => ({ x: 8, y, pin: i + 1 }));
// DIP-8 seen from the top: pins 1–4 along the bottom row, 5–8 back along the top row.
const dip = [20, 22.54, 25.08, 27.62].map((x, i) => ({ x, y: 11.19, pin: i + 1 })).concat([27.62, 25.08, 22.54, 20].map((x, i) => ({ x, y: 18.81, pin: i + 5 })));
const smd = [
  { name: 'R1', x: 37, y: 19 },
  { name: 'D1', x: 37, y: 11 },
];
const smdPads = smd.flatMap((c) => [{ x: c.x - 0.95, y: c.y }, { x: c.x + 0.95, y: c.y }]);
const vias = [{ x: 14, y: 23 }, { x: 31, y: 6 }];
const mounting = [[3.5, 3.5], [46.5, 3.5], [3.5, 26.5], [46.5, 26.5]];
const slot = [[23, 3], [27, 3]];
const groundPads = [header[0], dip[3]];

const top = {
  power: [[8, 13.73], [11, 13.73], [16.08, 18.81], [20, 18.81]],
  signals: [
    [[25.08, 11.19], [26.6, 9.67], [33.4, 9.67], [36.05, 12.32], [36.05, 11]],
    [[36.05, 19], [34, 21.05], [27, 21.05], [25.08, 19.13], [25.08, 18.81]],
    [[8, 16.27], [10.5, 16.27], [14, 19.77], [14, 23]],
    [[31, 6], [37.95, 6], [37.95, 11]],
  ],
};
const bottom = [
  [[8, 18.81], [10.5, 21.31], [12.31, 23], [14, 23]],
  [[22.54, 11.19], [22.54, 8], [24.54, 6], [31, 6]],
];

const coordinate = (v) => String(Math.round(v * 1e6));
const xy = (x, y) => `X${coordinate(x)}Y${coordinate(y)}`;

/** Gerber writer: header with optional X2 file function, apertures numbered from D10. */
function gerber(fileFunction, polarity) {
  const lines = [];
  if (fileFunction) {
    lines.push('%TF.GenerationSoftware,Everything Viewer,generate-plot-samples.mjs,1.0*%');
    lines.push('%TF.SameCoordinates,Original*%');
    lines.push(`%TF.FileFunction,${fileFunction}*%`);
    lines.push(`%TF.FilePolarity,${polarity}*%`);
  } else {
    lines.push('G04 Sample board, generated by generate-plot-samples.mjs*');
  }
  lines.push('%FSLAX46Y46*%', 'G04 Gerber Fmt 4.6, Leading zero omitted, Abs format (unit mm)*', '%MOMM*%', '%LPD*%', 'G01*');
  const apertures = new Map();
  return {
    lines,
    aperture(definition) {
      if (!apertures.has(definition)) {
        const code = 10 + apertures.size;
        apertures.set(definition, code);
        lines.push(`%ADD${code}${definition}*%`);
      }
      lines.push(`D${apertures.get(definition)}*`);
    },
    flash(x, y) {
      lines.push(`${xy(x, y)}D03*`);
    },
    track(points) {
      points.forEach(([x, y], i) => lines.push(`${xy(x, y)}${i ? 'D01' : 'D02'}*`));
    },
    raw(...more) {
      lines.push(...more);
    },
    done() {
      return `${[...lines, 'M02*'].join('\n')}\n`;
    },
  };
}

/** Rounded-rectangle pads as KiCad writes them: a macro of a polygon, corner circles and edge lines. */
const ROUND_RECT_MACRO = [
  '%AMRoundRect*',
  '0 Rectangle with rounded corners*',
  '0 $1 Rounding radius*',
  '0 $2 $3 $4 $5 $6 $7 $8 $9 X,Y pos of 4 corners*',
  '4,1,4,$2,$3,$4,$5,$6,$7,$8,$9,$2,$3,0*',
  '1,1,$1+$1,$2,$3*',
  '1,1,$1+$1,$4,$5*',
  '1,1,$1+$1,$6,$7*',
  '1,1,$1+$1,$8,$9*',
  '20,1,$1+$1,$2,$3,$4,$5,0*',
  '20,1,$1+$1,$4,$5,$6,$7,0*',
  '20,1,$1+$1,$6,$7,$8,$9,0*',
  '20,1,$1+$1,$8,$9,$2,$3,0*%',
];
const roundRect = (w, h, r) => {
  const [x, y] = [w / 2 - r, h / 2 - r];
  return `RoundRect,${[r, -x, -y, x, -y, x, y, -x, y].map((v) => v.toFixed(6)).join('X')}`;
};

/** Through-hole pads of one copper side (both sides carry the same pads). */
function throughHolePads(g, grow = 0) {
  g.aperture(`R,${(1.7 + 2 * grow).toFixed(6)}X${(1.7 + 2 * grow).toFixed(6)}`);
  g.flash(header[0].x, header[0].y);
  g.aperture(`O,${(2 + 2 * grow).toFixed(6)}X${(1.7 + 2 * grow).toFixed(6)}`);
  for (const p of header.slice(1)) g.flash(p.x, p.y);
  g.aperture(`R,${(1.6 + 2 * grow).toFixed(6)}X${(1.6 + 2 * grow).toFixed(6)}`);
  g.flash(dip[0].x, dip[0].y);
  g.aperture(`C,${(1.6 + 2 * grow).toFixed(6)}`);
  for (const p of dip.slice(1)) g.flash(p.x, p.y);
}

function topCopper() {
  const g = gerber('Copper,L1,Top', 'Positive');
  g.raw(...ROUND_RECT_MACRO);
  throughHolePads(g);
  g.aperture(roundRect(1.0, 1.45, 0.25));
  for (const p of smdPads) g.flash(p.x, p.y);
  g.aperture('C,0.600000');
  for (const v of vias) g.flash(v.x, v.y);
  g.aperture('C,0.400000');
  g.track(top.power);
  g.aperture('C,0.250000');
  for (const t of top.signals) g.track(t);
  // A curved track from D1 to R1, counterclockwise around (37.95, 15).
  g.raw('G75*', `${xy(37.95, 11)}D02*`, `G03${xy(37.95, 19)}I0J${coordinate(4)}D01*`, 'G01*');
  return g.done();
}

function bottomCopper() {
  const g = gerber(null);
  // Ground pour: the board inset by 0.5 mm, with clearances cut out in clear polarity, then pads and thermal spokes.
  const [w, h, r, m] = [BOARD.w, BOARD.h, 1.5, 0.5];
  g.raw('G75*', 'G36*', `${xy(m + r, m)}D02*`, `${xy(w - m - r, m)}D01*`, `G03${xy(w - m, m + r)}I0J${coordinate(r)}D01*`, 'G01*');
  g.raw(`${xy(w - m, h - m - r)}D01*`, `G03${xy(w - m - r, h - m)}I${coordinate(-r)}J0D01*`, 'G01*', `${xy(m + r, h - m)}D01*`);
  g.raw(`G03${xy(m, h - m - r)}I0J${coordinate(-r)}D01*`, 'G01*', `${xy(m, m + r)}D01*`, `G03${xy(m + r, m)}I${coordinate(r)}J0D01*`, 'G01*', 'G37*');
  g.raw('%LPC*%');
  throughHolePads(g, 0.4);
  g.aperture('C,1.400000');
  for (const v of vias) g.flash(v.x, v.y);
  g.aperture('C,4.200000');
  for (const [x, y] of mounting) g.flash(x, y);
  g.aperture('C,1.100000');
  for (const t of bottom) g.track(t);
  g.track(slot);
  g.raw('%LPD*%');
  throughHolePads(g);
  g.aperture('C,0.600000');
  for (const v of vias) g.flash(v.x, v.y);
  g.aperture('C,0.250000');
  for (const t of bottom) g.track(t);
  // Thermal spokes connect the ground pads to the pour.
  g.aperture('C,0.400000');
  for (const p of groundPads) {
    g.track([[p.x - 1.9, p.y], [p.x + 1.9, p.y]]);
    g.track([[p.x, p.y - 1.9], [p.x, p.y + 1.9]]);
  }
  return g.done();
}

function solderMask(side) {
  const g = gerber(side === 'Top' ? `Soldermask,${side}` : null, 'Negative');
  if (side === 'Top') g.raw(...ROUND_RECT_MACRO);
  throughHolePads(g, 0.05);
  if (side === 'Top') {
    g.aperture(roundRect(1.1, 1.55, 0.27));
    for (const p of smdPads) g.flash(p.x, p.y);
  }
  g.aperture('C,3.400000');
  for (const [x, y] of mounting) g.flash(x, y);
  g.aperture('C,1.200000');
  g.track(slot);
  return g.done();
}

// Stroke font for the silkscreen, on a grid 4 wide and 6 high.
const GLYPHS = {
  A: [[[0, 0], [0, 4], [2, 6], [4, 4], [4, 0]], [[0, 3], [4, 3]]],
  B: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[3, 3], [4, 2], [4, 1], [3, 0], [0, 0]]],
  D: [[[0, 0], [0, 6], [2, 6], [4, 4], [4, 2], [2, 0], [0, 0]]],
  E: [[[4, 0], [0, 0], [0, 6], [4, 6]], [[0, 3], [3, 3]]],
  J: [[[4, 6], [4, 1], [3, 0], [1, 0], [0, 1]]],
  L: [[[0, 6], [0, 0], [4, 0]]],
  M: [[[0, 0], [0, 6], [2, 3], [4, 6], [4, 0]]],
  O: [[[1, 0], [3, 0], [4, 1], [4, 5], [3, 6], [1, 6], [0, 5], [0, 1], [1, 0]]],
  P: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]]],
  R: [[[0, 0], [0, 6], [3, 6], [4, 5], [4, 4], [3, 3], [0, 3]], [[2, 3], [4, 0]]],
  S: [[[4, 5], [3, 6], [1, 6], [0, 5], [0, 4], [1, 3], [3, 3], [4, 2], [4, 1], [3, 0], [1, 0], [0, 1]]],
  U: [[[0, 6], [0, 1], [1, 0], [3, 0], [4, 1], [4, 6]]],
  V: [[[0, 6], [2, 0], [4, 6]]],
  1: [[[1, 5], [2, 6], [2, 0]], [[1, 0], [3, 0]]],
};

function text(g, string, x, y, height) {
  const unit = height / 6;
  [...string].forEach((ch, i) => {
    for (const stroke of GLYPHS[ch] ?? []) g.track(stroke.map(([u, v]) => [x + (i * 6 + u) * unit, y + v * unit]));
  });
}

function topSilkscreen() {
  const g = gerber(null);
  g.aperture('C,0.150000');
  const rect = (x1, y1, x2, y2) => g.track([[x1, y1], [x2, y1], [x2, y2], [x1, y2], [x1, y1]]);
  rect(6.6, 9.8, 9.4, 20.2);
  g.track([[6.6, 12.46], [9.4, 12.46]]);
  // DIP outline with the pin-1 notch on the left.
  g.track([[18.7, 16.2], [18.7, 17.6], [28.9, 17.6], [28.9, 12.4], [18.7, 12.4], [18.7, 13.8]]);
  g.raw('G75*', `${xy(18.7, 13.8)}D02*`, `G03${xy(18.7, 16.2)}I0J${coordinate(1.2)}D01*`, 'G01*');
  for (const c of smd) rect(c.x - 1.9, c.y - 1.15, c.x + 1.9, c.y + 1.15);
  // LED polarity bar.
  g.track([[smd[1].x - 2.2, smd[1].y - 1.15], [smd[1].x - 2.2, smd[1].y + 1.15]]);
  text(g, 'J1', 6.4, 21, 1.2);
  text(g, 'U1', 22.4, 20.3, 1.2);
  text(g, 'R1', 35.6, 21, 1.2);
  text(g, 'D1', 35.6, 13, 1.2);
  text(g, 'SAMPLE BOARD REV A', 12.6, 26.2, 1.2);
  return g.done();
}

function edgeCuts() {
  const g = gerber('Profile,NP', 'Positive');
  const { w, h, r } = BOARD;
  g.aperture('C,0.100000');
  g.raw('G75*', `${xy(r, 0)}D02*`, `G01${xy(w - r, 0)}D01*`, `G03${xy(w, r)}I0J${coordinate(r)}D01*`);
  g.raw(`G01${xy(w, h - r)}D01*`, `G03${xy(w - r, h)}I${coordinate(-r)}J0D01*`, `G01${xy(r, h)}D01*`);
  g.raw(`G03${xy(0, h - r)}I0J${coordinate(-r)}D01*`, `G01${xy(0, r)}D01*`, `G03${xy(r, 0)}I${coordinate(r)}J0D01*`, 'G01*');
  return g.done();
}

function drill(plated) {
  const lines = ['M48', '; DRILL file, generated by generate-plot-samples.mjs', '; FORMAT={-:-/ absolute / metric / decimal}'];
  lines.push(plated ? '; #@! TF.FileFunction,Plated,1,2,PTH' : '; #@! TF.FileFunction,NonPlated,1,2,NPTH', 'FMAT,2', 'METRIC');
  const f = (v) => v.toFixed(3);
  const tools = plated
    ? [['0.300', vias], ['0.800', dip], ['1.000', header]]
    : [['3.200', mounting.map(([x, y]) => ({ x, y }))], ['1.000', []]];
  tools.forEach(([d], i) => lines.push(`T${i + 1}C${d}`));
  lines.push('%', 'G90', 'G05');
  tools.forEach(([, points], i) => {
    if (!points.length) return;
    lines.push(`T${i + 1}`);
    for (const p of points) lines.push(`X${f(p.x)}Y${f(p.y)}`);
  });
  if (!plated) lines.push('T2', `X${f(slot[0][0])}Y${f(slot[0][1])}G85X${f(slot[1][0])}Y${f(slot[1][1])}`);
  lines.push('T0', 'M30');
  return `${lines.join('\n')}\n`;
}

// ---- Write ------------------------------------------------------------------------------------------------------------

write('cad/flange.plt', flangeHpgl2());
write('cad/flange-hpgl1.hpgl', flangeHpgl1());

const boardFiles = [
  ['board-F_Cu.gbr', topCopper()],
  ['board-B_Cu.gbr', bottomCopper()],
  ['board-F_Mask.gbr', solderMask('Top')],
  ['board-B_Mask.gbr', solderMask('Bottom')],
  ['board-F_SilkS.gbr', topSilkscreen()],
  ['board-Edge_Cuts.gbr', edgeCuts()],
  ['board-PTH.drl', drill(true)],
  ['board-NPTH.drl', drill(false)],
];
for (const [name, content] of boardFiles) write(`pcb/${name}`, content);
write('pcb/board-gerbers.zip', zip(boardFiles));

for (const [rel, size] of written) console.log(`${rel.padEnd(28)} ${size.toLocaleString('en-US')} bytes`);
