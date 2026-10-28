// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the sample files in samples/. Everything is drawn from scratch here, so the output can be published as CC0-1.0,
// except the font samples, which are copies of IBM Plex Sans (OFL-1.1) with its license next to them.
// Usage: node scripts/generate-samples.mjs [file ...] (after npm install; the SQLite sample needs sql.js). With file
// names (relative to samples/), only those are written.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync, gzipSync } from 'node:zlib';

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

// Deterministic pseudo-random numbers, so regenerating gives identical files.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

// ---- Raster images ------------------------------------------------------------------------------------------

/** Sample motif: warm gradient, a circle and a semi-transparent stripe on the left. Returns RGBA. */
function motif(x, y, w, h) {
  const dx = x - w * 0.62;
  const dy = y - h * 0.5;
  const inCircle = dx * dx + dy * dy < (h * 0.3) ** 2;
  const ring = Math.abs(Math.sqrt(dx * dx + dy * dy) - h * 0.3) < h * 0.02;
  if (ring) return [27, 30, 35, 255];
  if (inCircle) return [255, 255, 255, 255];
  const alpha = x < w * 0.08 ? 90 : 255;
  return [242, Math.round(90 + 110 * (x / w)), Math.round(40 + 160 * (y / h)), alpha];
}

function pixels(w, h, fn = motif) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) rgba.set(fn(x, y, w, h), (y * w + x) * 4);
  }
  return rgba;
}

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 24-bit BMP, alpha is blended onto white. */
function bmp(w, h, rgba) {
  const stride = Math.ceil((w * 3) / 4) * 4;
  const out = Buffer.alloc(54 + stride * h);
  out.write('BM', 0, 'latin1');
  out.writeUInt32LE(out.length, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(w, 18);
  out.writeInt32LE(h, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(stride * h, 34);
  for (let y = 0; y < h; y++) {
    const row = 54 + (h - 1 - y) * stride; // bottom-up
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const a = rgba[i + 3] / 255;
      for (let c = 0; c < 3; c++) out[row + x * 3 + (2 - c)] = Math.round(rgba[i + c] * a + 255 * (1 - a));
    }
  }
  return out;
}

/** ICO with one embedded PNG image. */
function ico(size, pngData) {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(1, 4); // one image
  header[6] = size;
  header[7] = size;
  header.writeUInt16LE(1, 10); // planes
  header.writeUInt16LE(32, 12); // bits per pixel
  header.writeUInt32LE(pngData.length, 14);
  header.writeUInt32LE(22, 18);
  return Buffer.concat([header, pngData]);
}

/** Animated GIF with a 6×6×6 color cube palette; LZW stays at 9-bit codes by clearing the table regularly. */
function animatedGif(w, h, frames, frameFn) {
  const parts = [Buffer.from('GIF89a', 'latin1')];
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(w, 0);
  screen.writeUInt16LE(h, 2);
  screen[4] = 0xf7; // global color table, 256 entries
  parts.push(screen);
  const palette = Buffer.alloc(768);
  for (let i = 0; i < 216; i++) palette.set([(Math.floor(i / 36) % 6) * 51, (Math.floor(i / 6) % 6) * 51, (i % 6) * 51], i * 3);
  parts.push(palette);
  // Netscape extension: loop forever.
  parts.push(Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from('NETSCAPE2.0', 'latin1'), 0x03, 0x01, 0x00, 0x00, 0x00]));

  const index = ([r, g, b]) => Math.round(r / 51) * 36 + Math.round(g / 51) * 6 + Math.round(b / 51);
  for (let f = 0; f < frames; f++) {
    parts.push(Buffer.from([0x21, 0xf9, 0x04, 0x00, 10, 0x00, 0x00, 0x00])); // 100 ms per frame
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(w, 5);
    descriptor.writeUInt16LE(h, 7);
    parts.push(descriptor);

    const codes = [];
    let sinceClear = 0;
    codes.push(256);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (sinceClear === 250) {
          codes.push(256);
          sinceClear = 0;
        }
        codes.push(index(frameFn(x, y, f)));
        sinceClear++;
      }
    }
    codes.push(257);
    const bytes = [];
    let acc = 0;
    let bits = 0;
    for (const code of codes) {
      acc |= code << bits;
      bits += 9;
      while (bits >= 8) {
        bytes.push(acc & 0xff);
        acc >>>= 8;
        bits -= 8;
      }
    }
    if (bits > 0) bytes.push(acc & 0xff);
    const data = [8];
    for (let i = 0; i < bytes.length; i += 255) {
      const block = bytes.slice(i, i + 255);
      data.push(block.length, ...block);
    }
    data.push(0);
    parts.push(Buffer.from(data));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

// ---- PDF ----------------------------------------------------------------------------------------------------

const pdfString = (s) => `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;

function pdfDocument(pages, info) {
  // Object 1: catalog, 2: pages, 3: font, 4: info, then page/content pairs, then the layers (optional content groups).
  const objects = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  const layers = info.layers ?? [];
  const layerIds = layers.map((_, i) => 5 + pages.length * 2 + i);
  layers.forEach((layer, i) => (objects[layerIds[i]] = `<< /Type /OCG /Name ${pdfString(layer.name)} >>`));
  // Layer panel order: layer indices, and nested lists that start with a heading text.
  const order = (items) => `[${items.map((item) => (Array.isArray(item) ? order(item) : typeof item === 'string' ? pdfString(item) : `${layerIds[item]} 0 R`)).join(' ')}]`;
  const off = layerIds.filter((_, i) => layers[i].off).map((id) => `${id} 0 R`);
  const ocProperties = layers.length
    ? ` /OCProperties << /OCGs [${layerIds.map((id) => `${id} 0 R`).join(' ')}] /D << /Order ${order(info.layerOrder ?? layers.map((_, i) => i))} /OFF [${off.join(' ')}] >> >>`
    : '';
  const properties = layers.length ? ` /Properties << ${layerIds.map((id, i) => `/L${i} ${id} 0 R`).join(' ')} >>` : '';
  objects[1] = `<< /Type /Catalog /Pages 2 0 R${ocProperties} >>`;
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objects[4] = `<< /Title ${pdfString(info.title)} /Author ${pdfString(info.author)} /Producer (generate-samples.mjs) >>`;
  pages.forEach((page, i) => {
    const id = pageIds[i];
    const [w, h] = page.size ?? [595, 842];
    const extra = page.rotate ? ` /Rotate ${page.rotate}` : '';
    const annots = page.links?.length
      ? ` /Annots [${page.links.map((l) => `<< /Type /Annot /Subtype /Link /Rect [${l.rect.join(' ')}] /Border [0 0 0] /A << /S /URI /URI ${pdfString(l.uri)} >> >>`).join(' ')}]`
      : '';
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}]${extra} /Resources << /Font << /F1 3 0 R >>${properties} >> /Contents ${id + 1} 0 R${annots} >>`;
    objects[id + 1] = `<< /Length ${Buffer.byteLength(page.content, 'latin1')} >>\nstream\n${page.content}\nendstream`;
  });

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, 'latin1');
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const text = (x, y, size, s) => `BT /F1 ${size} Tf ${x} ${y} Td ${pdfString(s)} Tj ET`;

function samplePdf() {
  const page1 = [
    text(72, 770, 24, 'Peekbean - sample PDF'),
    text(72, 740, 12, 'This document was generated by scripts/generate-samples.mjs.'),
    text(72, 700, 12, 'It tests text, accented letters (café, naïve, Zürich, Ø 25 ±0.1), vector graphics, links and rotated pages.'),
    text(72, 680, 12, 'Search term for testing the search: shipyard (appears on all three pages).'),
    text(72, 640, 12, 'Link: https://www.gnu.org/licenses/gpl-3.0.html'),
    '0.95 0.6 0.22 rg 72 520 451 80 re f',
    '0.11 0.12 0.14 rg',
    text(90, 552, 16, 'Filled area with text on top'),
  ].join('\n');

  const shapes = ['0.11 0.12 0.14 RG 1 w'];
  for (let i = 0; i <= 10; i++) shapes.push(`72 ${200 + i * 30} m 523 ${200 + i * 30} l S`);
  for (let i = 0; i <= 10; i++) shapes.push(`${72 + i * 45.1} 200 m ${72 + i * 45.1} 500 l S`);
  // Circle from four Bézier curves.
  const [cx, cy, r, k] = [297, 350, 110, 0.5523 * 110];
  shapes.push(
    '0.95 0.6 0.22 RG 4 w',
    `${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c`,
    `${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c S`,
  );
  const page2 = [text(72, 770, 20, 'Page 2: vector graphics'), text(72, 745, 12, 'Grid and circle, sharp at any zoom. Shipyard.'), ...shapes].join('\n');

  const page3 = [text(72, 520, 20, 'Page 3: landscape'), text(72, 490, 12, 'This page is laid out in landscape format. Shipyard.')].join('\n');

  return pdfDocument(
    [
      { content: page1, links: [{ rect: [72, 636, 340, 652], uri: 'https://www.gnu.org/licenses/gpl-3.0.html' }] },
      { content: page2 },
      { content: page3, size: [842, 595] },
    ],
    { title: 'Peekbean sample', author: 'Peekbean' },
  );
}

/** Marked content that belongs to layer i of the document. */
const onLayer = (i, ...ops) => [`/OC /L${i} BDC`, ...ops, 'EMC'].join('\n');

/** A small plate drawing whose parts lie on layers (PDF optional content), one of them switched off. */
function layersPdf() {
  const [x0, y0, w, h] = [221, 180, 400, 240];
  const circle = (cx, cy, r) => {
    const k = 0.5523 * r;
    return `${cx + r} ${cy} m ${cx + r} ${cy + k} ${cx + k} ${cy + r} ${cx} ${cy + r} c ${cx - k} ${cy + r} ${cx - r} ${cy + k} ${cx - r} ${cy} c ${cx - r} ${cy - k} ${cx - k} ${cy - r} ${cx} ${cy - r} c ${cx + k} ${cy - r} ${cx + r} ${cy - k} ${cx + r} ${cy} c S`;
  };
  const holes = [[x0 + 50, y0 + 50], [x0 + w - 50, y0 + 50], [x0 + w - 50, y0 + h - 50], [x0 + 50, y0 + h - 50]];
  const content = [
    text(72, 540, 20, 'Layer test (PDF optional content)'),
    text(72, 518, 11, 'Each part of the drawing lies on its own layer. "Revision B" is switched off by default.'),
    onLayer(0, '0.11 0.12 0.14 RG 2.5 w', `${x0} ${y0} ${w} ${h} re S`, circle(x0 + w / 2, y0 + h / 2, 45), ...holes.map(([cx, cy]) => circle(cx, cy, 12))),
    onLayer(1, '0.18 0.5 0.84 RG 0.8 w [12 4 2 4] 0 d', `${x0 - 20} ${y0 + h / 2} m ${x0 + w + 20} ${y0 + h / 2} l S`, `${x0 + w / 2} ${y0 - 20} m ${x0 + w / 2} ${y0 + h + 20} l S`, '[] 0 d'),
    onLayer(
      2,
      '0.24 0.6 0.28 RG 0.8 w 0.24 0.6 0.28 rg',
      `${x0} ${y0 - 40} m ${x0 + w} ${y0 - 40} l S ${x0} ${y0 - 48} m ${x0} ${y0 - 32} l S ${x0 + w} ${y0 - 48} m ${x0 + w} ${y0 - 32} l S`,
      text(x0 + w / 2 - 12, y0 - 36, 11, '400'),
      `${x0 + w + 40} ${y0} m ${x0 + w + 40} ${y0 + h} l S ${x0 + w + 32} ${y0} m ${x0 + w + 48} ${y0} l S ${x0 + w + 32} ${y0 + h} m ${x0 + w + 48} ${y0 + h} l S`,
      text(x0 + w + 46, y0 + h / 2 - 4, 11, '240'),
    ),
    onLayer(3, '0.11 0.12 0.14 rg', text(72, 120, 11, 'Material: S235JR, thickness 12 mm'), text(72, 104, 11, 'Holes: 4 x diameter 24, center bore diameter 90')),
    onLayer(4, '0.85 0.27 0.24 RG 1.5 w 0.85 0.27 0.24 rg', circle(x0 + w - 50, y0 + h - 50, 26), text(x0 + w - 20, y0 + h - 20, 11, 'Revision B: hole moved')),
  ].join('\n');
  return pdfDocument([{ content, size: [842, 595] }], {
    title: 'Layer test',
    author: 'Peekbean',
    layers: [{ name: 'Outline' }, { name: 'Center lines' }, { name: 'Dimensions' }, { name: 'Notes' }, { name: 'Revision B', off: true }],
    layerOrder: [0, 1, 2, ['Annotations', 3, 4]],
  });
}

// ---- 3D -----------------------------------------------------------------------------------------------------

/** Spur gear with a center bore, as an indexed triangle mesh (Z-up, millimeters). */
function gearMesh({ teeth = 18, outer = 30, root = 25.5, bore = 8, thickness = 8, samplesPerTooth = 12 } = {}) {
  const n = teeth * samplesPerTooth;
  const profile = (t) => {
    // t in [0, 1) within one tooth: root, flank up, tip, flank down.
    if (t < 0.25) return root;
    if (t < 0.4) return root + ((t - 0.25) / 0.15) * (outer - root);
    if (t < 0.6) return outer;
    if (t < 0.75) return outer - ((t - 0.6) / 0.15) * (outer - root);
    return root;
  };
  const vertices = [];
  const ring = (radiusFn, z) => {
    const start = vertices.length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const r = radiusFn(i);
      vertices.push([r * Math.cos(a), r * Math.sin(a), z]);
    }
    return start;
  };
  const outerBottom = ring((i) => profile((i % samplesPerTooth) / samplesPerTooth), 0);
  const outerTop = ring((i) => profile((i % samplesPerTooth) / samplesPerTooth), thickness);
  const boreBottom = ring(() => bore, 0);
  const boreTop = ring(() => bore, thickness);
  const triangles = [];
  const quad = (a, b, c, d) => triangles.push([a, b, c], [a, c, d]);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    quad(boreTop + i, outerTop + i, outerTop + j, boreTop + j); // top face, normal +Z
    quad(boreBottom + i, boreBottom + j, outerBottom + j, outerBottom + i); // bottom face, normal -Z
    quad(outerBottom + i, outerBottom + j, outerTop + j, outerTop + i); // outer wall
    quad(boreBottom + i, boreTop + i, boreTop + j, boreBottom + j); // bore wall, facing the axis
  }
  return { vertices, triangles };
}

function normalOf(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const len = Math.hypot(...n) || 1;
  return n.map((x) => x / len);
}

function binaryStl({ vertices, triangles }, header) {
  const out = Buffer.alloc(84 + triangles.length * 50);
  out.write(header.slice(0, 80), 0, 'latin1');
  out.writeUInt32LE(triangles.length, 80);
  triangles.forEach((t, i) => {
    let o = 84 + i * 50;
    const corners = t.map((index) => vertices[index]);
    for (const value of [...normalOf(...corners), ...corners.flat()]) {
      out.writeFloatLE(value, o);
      o += 4;
    }
  });
  return out;
}

function asciiStl({ vertices, triangles }, name) {
  const fmt = (v) => v.map((x) => x.toExponential(6)).join(' ');
  const facets = triangles.map((t) => {
    const corners = t.map((index) => vertices[index]);
    return `  facet normal ${fmt(normalOf(...corners))}\n    outer loop\n${corners.map((c) => `      vertex ${fmt(c)}\n`).join('')}    endloop\n  endfacet\n`;
  });
  return `solid ${name}\n${facets.join('')}endsolid ${name}\n`;
}

function pyramidMesh(size = 40, height = 30) {
  const s = size / 2;
  return {
    vertices: [[-s, -s, 0], [s, -s, 0], [s, s, 0], [-s, s, 0], [0, 0, height]],
    triangles: [[0, 2, 1], [0, 3, 2], [0, 1, 4], [1, 2, 4], [2, 3, 4], [3, 0, 4]],
  };
}

function torusObj(R = 30, r = 10, segments = 48, sides = 24) {
  const lines = ['# Torus, generated by scripts/generate-samples.mjs', 'o Torus'];
  for (let i = 0; i < segments; i++) {
    const u = (i / segments) * Math.PI * 2;
    for (let j = 0; j < sides; j++) {
      const v = (j / sides) * Math.PI * 2;
      lines.push(`v ${((R + r * Math.cos(v)) * Math.cos(u)).toFixed(4)} ${(r * Math.sin(v)).toFixed(4)} ${((R + r * Math.cos(v)) * Math.sin(u)).toFixed(4)}`);
    }
  }
  for (let i = 0; i < segments; i++) {
    const u = (i / segments) * Math.PI * 2;
    for (let j = 0; j < sides; j++) {
      const v = (j / sides) * Math.PI * 2;
      lines.push(`vn ${(Math.cos(v) * Math.cos(u)).toFixed(4)} ${Math.sin(v).toFixed(4)} ${(Math.cos(v) * Math.sin(u)).toFixed(4)}`);
    }
  }
  const at = (i, j) => (i % segments) * sides + (j % sides) + 1;
  for (let i = 0; i < segments; i++) {
    for (let j = 0; j < sides; j++) {
      const q = [at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)];
      lines.push(`f ${q.map((k) => `${k}//${k}`).join(' ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Point cloud on a sphere (Fibonacci lattice), colored by height. */
function spherePly(count = 8000, radius = 25) {
  const header = [
    'ply',
    'format binary_little_endian 1.0',
    'comment Point cloud, generated by scripts/generate-samples.mjs',
    `element vertex ${count}`,
    'property float x',
    'property float y',
    'property float z',
    'property uchar red',
    'property uchar green',
    'property uchar blue',
    'end_header',
    '',
  ].join('\n');
  const body = Buffer.alloc(count * 15);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const z = 1 - (2 * (i + 0.5)) / count;
    const rr = Math.sqrt(1 - z * z);
    const a = golden * i;
    const o = i * 15;
    body.writeFloatLE(radius * rr * Math.cos(a), o);
    body.writeFloatLE(radius * rr * Math.sin(a), o + 4);
    body.writeFloatLE(radius * z, o + 8);
    const t = (z + 1) / 2;
    body[o + 12] = Math.round(242 * t + 40 * (1 - t));
    body[o + 13] = Math.round(154 * t + 90 * (1 - t));
    body[o + 14] = Math.round(56 * t + 220 * (1 - t));
  }
  return Buffer.concat([Buffer.from(header, 'latin1'), body]);
}

/** Cube with one color per face, as glTF JSON plus binary buffer. */
function coloredCubeGltf() {
  const faces = [
    { n: [1, 0, 0], color: [0.95, 0.6, 0.22] },
    { n: [-1, 0, 0], color: [0.36, 0.79, 0.55] },
    { n: [0, 1, 0], color: [0.6, 0.65, 1.0] },
    { n: [0, -1, 0], color: [0.91, 0.77, 0.28] },
    { n: [0, 0, 1], color: [0.94, 0.45, 0.44] },
    { n: [0, 0, -1], color: [0.9, 0.91, 0.92] },
  ];
  const positions = [];
  const normals = [];
  const colors = [];
  const indices = [];
  for (const { n, color } of faces) {
    const axis = n.findIndex((v) => v !== 0);
    const [u, v] = [0, 1, 2].filter((i) => i !== axis);
    const base = positions.length / 3;
    for (const [su, sv] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const p = [0, 0, 0];
      p[axis] = n[axis] * 10;
      p[u] = su * 10;
      p[v] = sv * 10;
      positions.push(...p);
      normals.push(...n);
      colors.push(...color, 1);
    }
    // The corners run counter-clockwise around u×v, which points along +axis except for the y axis.
    const outward = (n[axis] > 0) === (axis !== 1);
    indices.push(...(outward ? [base, base + 1, base + 2, base, base + 2, base + 3] : [base, base + 2, base + 1, base, base + 3, base + 2]));
  }
  const pos = Buffer.from(new Float32Array(positions).buffer);
  const nor = Buffer.from(new Float32Array(normals).buffer);
  const col = Buffer.from(new Float32Array(colors).buffer);
  const idx = Buffer.from(new Uint16Array(indices).buffer);
  const bin = Buffer.concat([pos, nor, col, idx]);
  const views = [pos, nor, col, idx];
  let offset = 0;
  const bufferViews = views.map((view, i) => {
    const entry = { buffer: 0, byteOffset: offset, byteLength: view.length, target: i === 3 ? 34963 : 34962 };
    offset += view.length;
    return entry;
  });
  const json = {
    asset: { version: '2.0', generator: 'generate-samples.mjs' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: 'Farbwuerfel' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.6 } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews,
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [-10, -10, -10], max: [10, 10, 10] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5126, count: 24, type: 'VEC4' },
      { bufferView: 3, componentType: 5123, count: indices.length, type: 'SCALAR' },
    ],
  };
  return { json, bin };
}

function glb({ json, bin }) {
  const pad = (buf, fill) => Buffer.concat([buf, Buffer.alloc((4 - (buf.length % 4)) % 4, fill)]);
  const jsonChunk = pad(Buffer.from(JSON.stringify(json)), 0x20);
  const binChunk = pad(bin, 0);
  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'latin1');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);
  const chunkHeader = (length, type) => {
    const b = Buffer.alloc(8);
    b.writeUInt32LE(length, 0);
    b.write(type, 4, 'latin1');
    return b;
  };
  return Buffer.concat([header, chunkHeader(jsonChunk.length, 'JSON'), jsonChunk, chunkHeader(binChunk.length, 'BIN\0'), binChunk]);
}

function embeddedGltf({ json, bin }) {
  const copy = structuredClone(json);
  copy.buffers[0].uri = `data:application/octet-stream;base64,${bin.toString('base64')}`;
  return `${JSON.stringify(copy, null, 2)}\n`;
}

/** Traditional PKWARE ("ZipCrypto") encryption, enough to test password prompts. Not secure. */
function zipCrypto(data, crc, password) {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crcByte = (value, byte) => (table[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0;
  const keys = [0x12345678, 0x23456789, 0x34567890];
  const update = (byte) => {
    keys[0] = crcByte(keys[0], byte);
    keys[1] = (Math.imul((keys[1] + (keys[0] & 0xff)) >>> 0, 134775813) + 1) >>> 0;
    keys[2] = crcByte(keys[2], keys[1] >>> 24);
  };
  const streamByte = () => {
    const t = (keys[2] | 2) & 0xffff;
    return (Math.imul(t, t ^ 1) >>> 8) & 0xff;
  };
  for (const byte of Buffer.from(password, 'utf8')) update(byte);
  const random = prng(99);
  const header = Buffer.from(Array.from({ length: 12 }, (_, i) => (i === 11 ? crc >>> 24 : Math.floor(random() * 256))));
  const plain = Buffer.concat([header, data]);
  const out = Buffer.alloc(plain.length);
  for (let i = 0; i < plain.length; i++) {
    out[i] = plain[i] ^ streamByte();
    update(plain[i]);
  }
  return out;
}

/** ZIP archive without compression (enough for 3MF). Names are flagged as UTF-8. */
function storedZip(entries, password) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const plain = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(plain);
    const data = password ? zipCrypto(plain, crc, password) : plain;
    const flags = 0x0800 | (password ? 0x0001 : 0);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
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
    central.writeUInt16LE(flags, 8);
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

function threeMf({ vertices, triangles }) {
  const model = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<model unit="millimeter" xml:lang="de-DE" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">',
    '<metadata name="Title">Gear</metadata>',
    '<resources><object id="1" type="model"><mesh><vertices>',
    ...vertices.map(([x, y, z]) => `<vertex x="${x.toFixed(4)}" y="${y.toFixed(4)}" z="${z.toFixed(4)}"/>`),
    '</vertices><triangles>',
    ...triangles.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`),
    '</triangles></mesh></object></resources>',
    '<build><item objectid="1"/></build>',
    '</model>',
  ].join('\n');
  return storedZip([
    [
      '[Content_Types].xml',
      '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>',
    ],
    [
      '_rels/.rels',
      '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>',
    ],
    ['3D/3dmodel.model', model],
  ]);
}

// ---- CAD ----------------------------------------------------------------------------------------------------

/** Flange plate as AutoCAD R12 ASCII DXF: outline, bore, bolt circle, center lines, title. */
function flangeDxf() {
  const g = [];
  const add = (...pairs) => {
    for (let i = 0; i < pairs.length; i += 2) g.push(String(pairs[i]), String(pairs[i + 1]));
  };
  add(0, 'SECTION', 2, 'HEADER', 9, '$ACADVER', 1, 'AC1009', 9, '$INSBASE', 10, 0, 20, 0, 30, 0, 0, 'ENDSEC');
  add(0, 'SECTION', 2, 'TABLES');
  add(0, 'TABLE', 2, 'LTYPE', 70, 2);
  add(0, 'LTYPE', 2, 'CONTINUOUS', 70, 0, 3, 'Solid line', 72, 65, 73, 0, 40, 0);
  add(0, 'LTYPE', 2, 'CENTER', 70, 0, 3, 'Center ____ _ ____', 72, 65, 73, 4, 40, 20, 49, 12, 49, -3, 49, 2, 49, -3);
  add(0, 'ENDTAB');
  const layers = [['0', 7, 'CONTINUOUS'], ['OUTLINE', 7, 'CONTINUOUS'], ['HOLES', 1, 'CONTINUOUS'], ['CENTERLINES', 5, 'CENTER'], ['TEXT', 3, 'CONTINUOUS']];
  add(0, 'TABLE', 2, 'LAYER', 70, layers.length);
  for (const [name, color, ltype] of layers) add(0, 'LAYER', 2, name, 70, 0, 62, color, 6, ltype);
  add(0, 'ENDTAB', 0, 'ENDSEC');

  add(0, 'SECTION', 2, 'ENTITIES');
  const circle = (layer, x, y, r) => add(0, 'CIRCLE', 8, layer, 10, x, 20, y, 30, 0, 40, r);
  const line = (layer, x1, y1, x2, y2) => add(0, 'LINE', 8, layer, 10, x1, 20, y1, 30, 0, 11, x2, 21, y2, 31, 0);
  // Outline: square plate 160 × 160 with rounded corners (radius 15).
  const [s, rc] = [80, 15];
  line('OUTLINE', -s + rc, -s, s - rc, -s);
  line('OUTLINE', s, -s + rc, s, s - rc);
  line('OUTLINE', s - rc, s, -s + rc, s);
  line('OUTLINE', -s, s - rc, -s, -s + rc);
  for (const [x, y, start] of [[s - rc, -s + rc, 270], [s - rc, s - rc, 0], [-s + rc, s - rc, 90], [-s + rc, -s + rc, 180]]) {
    add(0, 'ARC', 8, 'OUTLINE', 10, x, 20, y, 30, 0, 40, rc, 50, start, 51, start + 90);
  }
  circle('HOLES', 0, 0, 30);
  circle('CENTERLINES', 0, 0, 55); // bolt circle
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    circle('HOLES', +(55 * Math.cos(a)).toFixed(4), +(55 * Math.sin(a)).toFixed(4), 6.5);
  }
  line('CENTERLINES', -95, 0, 95, 0);
  line('CENTERLINES', 0, -95, 0, 95);
  add(0, 'TEXT', 8, 'TEXT', 10, -80, 20, -115, 30, 0, 40, 7, 1, 'FLANGE PLATE 160x160x12  -  material S235JR');
  add(0, 'TEXT', 8, 'TEXT', 10, -80, 20, -127, 30, 0, 40, 4, 1, 'Sample drawing, generated by generate-samples.mjs');
  add(0, 'ENDSEC', 0, 'EOF');
  return `${g.join('\r\n')}\r\n`;
}

// ---- Text ---------------------------------------------------------------------------------------------------

const TS_SAMPLE = `// Example: gear dimensions
export interface Gear {
  module: number; // module in mm
  teeth: number;
}

export function pitchDiameter({ module, teeth }: Gear): number {
  return module * teeth;
}

export function tipDiameter(gear: Gear): number {
  return pitchDiameter(gear) + 2 * gear.module;
}

const gear: Gear = { module: 1.5, teeth: 18 };
console.log(\`Pitch diameter: \${pitchDiameter(gear)} mm, tip diameter: \${tipDiameter(gear)} mm\`);
`;

const PY_SAMPLE = `"""Example: count the parts of a parts list by size."""
import csv
from collections import Counter


def count_by_size(path: str) -> Counter:
    with open(path, encoding="utf-8") as f:
        rows = csv.DictReader(f)
        return Counter(row["Size"] for row in rows)


if __name__ == "__main__":
    for size, n in count_by_size("parts.csv").most_common():
        print(f"{size}: {n} pcs")
`;

const CSV_SAMPLE = `Item,Description,Size,Material,Quantity,Price (EUR)
1,Hex bolt,M8x30,8.8 zinc plated,24,0.18
2,Hex nut,M8,8 zinc plated,24,0.06
3,Washer,8.4,steel zinc plated,48,0.03
4,Socket head cap screw,M6x20,A2-70,12,0.22
5,Flange plate,160x160x12,S235JR,2,38.50
6,Gear,"m1.5, z18",C45,1,64.00
`;

const JSON_SAMPLE = `${JSON.stringify(
  {
    project: 'Peekbean',
    description: 'Sample data for the JSON viewer',
    version: 1,
    parts: [
      { id: 'gear', file: '3d/gear.stl', mass_g: 182.4, material: 'C45' },
      { id: 'flange', file: 'cad/flange.dxf', mass_g: 2410, material: 'S235JR' },
    ],
    options: { unit: 'mm', tolerance: 0.1, active: true, note: null },
  },
  null,
  2,
)}\n`;

const XML_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Sample configuration -->
<configuration version="1.0">
  <unit>mm</unit>
  <part id="gear" material="C45">
    <teeth>18</teeth>
    <module>1.5</module>
  </part>
  <part id="flange" material="S235JR">
    <holes count="6" diameter="13" bolt-circle="110"/>
  </part>
</configuration>
`;

const MD_SAMPLE = `# Sample document

This Markdown document tests the **formatting** in the Markdown viewer.

## List

- Gear (\`3d/gear.stl\`)
- Flange plate (\`cad/flange.dxf\`)

## Table

| Part | Material | Quantity |
|------|----------|---------:|
| Gear | C45 | 1 |
| Flange | S235JR | 2 |

> Quote: nothing leaves your computer.
`;

const GCODE_SAMPLE = `; Sample CNC program: flange plate, 6 holes on a 110 mm bolt circle
; generated by scripts/generate-samples.mjs, not meant for real machines
G21 ; millimeters
G90 ; absolute
G17 ; XY plane
T1 M6 ; 13 mm drill
S1200 M3
G0 Z5
${Array.from({ length: 6 }, (_, i) => {
  const a = (i / 6) * Math.PI * 2;
  return `G81 X${(55 * Math.cos(a)).toFixed(3)} Y${(55 * Math.sin(a)).toFixed(3)} Z-14 R2 F150`;
}).join('\n')}
G80
G0 Z50
M5
M30
`;

function logSample() {
  const random = prng(7);
  const levels = ['INFO', 'INFO', 'INFO', 'DEBUG', 'WARN', 'ERROR'];
  const messages = ['File opened', 'Viewer loaded', 'Page rendered', 'Cache cleared', 'Slow response', 'File damaged'];
  const start = Date.UTC(2026, 9, 26, 8, 0, 0);
  return `${Array.from({ length: 400 }, (_, i) => {
    const k = Math.floor(random() * levels.length);
    return `${new Date(start + i * 1370).toISOString()} ${levels[k].padEnd(5)} [viewer] ${messages[k]} (#${i})`;
  }).join('\n')}\n`;
}

/** Windows-1252 bytes: Latin-1 plus the euro sign at 0x80. */
function windows1252(s) {
  return Buffer.from(Array.from(s, (ch) => (ch === '€' ? 0x80 : ch.charCodeAt(0))));
}

// ---- Office -------------------------------------------------------------------------------------------------

const xml = (body) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const relationships = (rels) =>
  xml(`<Relationships xmlns="${PKG_REL}">${rels.map(([id, type, target]) => `<Relationship Id="${id}" Type="${type.startsWith('http') ? type : `${REL}/${type}`}" Target="${target}"/>`).join('')}</Relationships>`);

/** Document properties (docProps/core.xml and app.xml) as Office writes them, for the info panel. */
function docProps({ title, subject, keywords, extra = '' }) {
  const core = xml(
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${title}</dc:title><dc:subject>${subject}</dc:subject><dc:creator>Peekbean</dc:creator><cp:keywords>${keywords}</cp:keywords>` +
      '<cp:lastModifiedBy>generate-samples.mjs</cp:lastModifiedBy><cp:revision>3</cp:revision>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">2026-05-01T10:00:00Z</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">2026-05-02T08:15:00Z</dcterms:modified></cp:coreProperties>',
  );
  const app = xml(`<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>generate-samples.mjs</Application>${extra}<Company>Peekbean</Company></Properties>`);
  return {
    files: [['docProps/core.xml', core], ['docProps/app.xml', app]],
    overrides: [
      ['/docProps/core.xml', 'application/vnd.openxmlformats-package.core-properties+xml'],
      ['/docProps/app.xml', 'application/vnd.openxmlformats-officedocument.extended-properties+xml'],
    ],
    rels: [['rId90', `${PKG_REL}/metadata/core-properties`, 'docProps/core.xml'], ['rId91', 'extended-properties', 'docProps/app.xml']],
  };
}
const contentTypes = (defaults, overrides) =>
  xml(
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      defaults.map(([ext, type]) => `<Default Extension="${ext}" ContentType="${type}"/>`).join('') +
      overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join('') +
      '</Types>',
  );

function sampleDocx(imagePng) {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const run = (text, props = '') => `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  const para = (runs, style) => `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs}</w:p>`;
  const cell = (text, header) =>
    `<w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="F3F4F6"/>' : ''}</w:tcPr>${para(run(text, header ? '<w:b/>' : ''))}</w:tc>`;
  const rows = [['Part', 'Material', 'Quantity'], ['Gear z18', 'C45', '1'], ['Flange plate', 'S235JR', '2'], ['Hex bolt M8x30', '8.8', '24']];
  const border = '<w:top w:val="single" w:sz="4" w:color="D3D8DE"/><w:left w:val="single" w:sz="4" w:color="D3D8DE"/><w:bottom w:val="single" w:sz="4" w:color="D3D8DE"/><w:right w:val="single" w:sz="4" w:color="D3D8DE"/><w:insideH w:val="single" w:sz="4" w:color="D3D8DE"/><w:insideV w:val="single" w:sz="4" w:color="D3D8DE"/>';
  const table = `<w:tbl><w:tblPr><w:tblW w:w="9000" w:type="dxa"/><w:tblBorders>${border}</w:tblBorders></w:tblPr><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/><w:gridCol w:w="3000"/></w:tblGrid>${rows
    .map((r, i) => `<w:tr>${r.map((t) => cell(t, i === 0)).join('')}</w:tr>`)
    .join('')}</w:tbl>`;
  const [cx, cy] = [3048000, 1905000];
  const picture = `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="1" name="Motif"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="0" name="motif.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  const body = [
    para(run('Sample document'), 'Heading1'),
    para(run('This Word document was generated by scripts/generate-samples.mjs. It contains ') + run('bold', '<w:b/>') + run(', ') + run('italic', '<w:i/>') + run(', ') + run('underlined', '<w:u w:val="single"/>') + run(' and ') + run('colored', '<w:color w:val="D9822B"/>') + run(' text and accented letters: café, naïve, Zürich, Ø 25 ±0.1.')),
    para(run('Parts list'), 'Heading2'),
    table,
    para(run('Picture')),
    picture,
    `<w:p><w:r><w:br w:type="page"/></w:r></w:p>`,
    para(run('Second page'), 'Heading2'),
    para(run('Search term for tests: shipyard. This page starts after a manual page break.')),
  ].join('');
  const document = xml(
    `<w:document ${W} xmlns:r="${REL}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1417" w:right="1417" w:bottom="1134" w:left="1417" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`,
  );
  const heading = (id, name, size) =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:color w:val="1B1E23"/><w:sz w:val="${size}"/></w:rPr></w:style>`;
  const styles = xml(
    `<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>${heading('Heading1', 'heading 1', 36)}${heading('Heading2', 'heading 2', 28)}</w:styles>`,
  );
  const props = docProps({ title: 'Sample document', subject: 'Test file for the Word viewer', keywords: 'sample, Word', extra: '<Pages>2</Pages><Words>60</Words>' });
  return storedZip([
    ['[Content_Types].xml', contentTypes([['png', 'image/png']], [
      ['/word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
      ['/word/styles.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml'],
      ...props.overrides,
    ])],
    ['_rels/.rels', relationships([['rId1', 'officeDocument', 'word/document.xml'], ...props.rels])],
    ...props.files,
    ['word/_rels/document.xml.rels', relationships([['rId1', 'styles', 'styles.xml'], ['rId2', 'image', 'media/motif.png']])],
    ['word/document.xml', document],
    ['word/styles.xml', styles],
    ['word/media/motif.png', imagePng],
  ]);
}

/** Excel serial day number (days since 1899-12-30). */
const excelDate = (y, m, d) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000;

function sampleXlsx() {
  const S = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"';
  const col = (i) => String.fromCharCode(65 + i);
  // A cell is null, a number, a string, or { value | text, style, formula }.
  const cellXml = (ref, value) => {
    if (value === null) return '';
    if (typeof value === 'number') return `<c r="${ref}" s="5"><v>${value}</v></c>`;
    if (typeof value === 'string') return `<c r="${ref}" s="5" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
    const s = value.style ?? 0;
    if (value.text !== undefined) return `<c r="${ref}" s="${s}" t="inlineStr"><is><t>${escapeXml(value.text)}</t></is></c>`;
    if (value.formula) return `<c r="${ref}" s="${s}"><f>${value.formula}</f><v>${value.value}</v></c>`;
    if (value.value === undefined) return `<c r="${ref}" s="${s}"/>`;
    return `<c r="${ref}" s="${s}"><v>${value.value}</v></c>`;
  };
  const sheet = (rows, widths, { merges = [], heights = {} } = {}) =>
    xml(
      `<worksheet ${S}><sheetFormatPr defaultRowHeight="15"/><cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols><sheetData>${rows
        .map((r, ri) => `<row r="${ri + 1}"${heights[ri + 1] ? ` ht="${heights[ri + 1]}" customHeight="1"` : ''}>${r.map((v, ci) => cellXml(`${col(ci)}${ri + 1}`, v)).join('')}</row>`)
        .join('')}</sheetData>${merges.length ? `<mergeCells count="${merges.length}">${merges.map((m) => `<mergeCell ref="${m}"/>`).join('')}</mergeCells>` : ''}</worksheet>`,
    );
  const parts = [
    ['Gear z18', 'C45', 1, 64.0, excelDate(2026, 10, 1)],
    ['Flange plate', 'S235JR', 2, 38.5, excelDate(2026, 10, 5)],
    ['Hex bolt M8x30', '8.8 zinc plated', 24, 0.18, excelDate(2026, 10, 12)],
    ['Hex nut M8', '8 zinc plated', 24, 0.06, excelDate(2026, 10, 12)],
    ['Washer 8.4', 'steel zinc plated', 48, 0.03, excelDate(2026, 10, 12)],
  ];
  // Styles (cellXfs): 0 default, 1 money, 2 date, 3 title, 4 header, 5 body with border, 6 total label, 7 total money,
  // 8 red italic note, 9 wrapped text.
  const header = (text) => ({ text, style: 4 });
  const rows1 = [
    [{ text: 'Parts list gearbox A', style: 3 }, { style: 3 }, { style: 3 }, { style: 3 }, { style: 3 }, { style: 3 }],
    [header('Description'), header('Material'), header('Quantity'), header('Unit price (EUR)'), header('Ordered on'), header('Total (EUR)')],
    ...parts.map(([name, material, qty, price, date], i) => [
      name, material, qty, { style: 1, value: price }, { style: 2, value: date },
      { formula: `C${i + 3}*D${i + 3}`, style: 1, value: qty * price },
    ]),
    [null, null, null, null, { text: 'Total', style: 6 }, { formula: `SUM(F3:F${parts.length + 2})`, style: 7, value: parts.reduce((s, p) => s + p[2] * p[3], 0) }],
    [],
    [{ text: 'Note: prices without VAT, as of October 2026. Like in Excel, this text runs on into the empty cells next to it.', style: 8 }],
  ];
  const rows2 = [
    [{ text: 'Notes', style: 4 }],
    [{ text: 'Second worksheet, to test the sheet tabs. This cell wraps its text because “Wrap Text” is turned on.', style: 9 }],
    [{ text: 'Accented letters: café, naïve, Zürich, Ø 25 ±0.1', style: 5 }],
  ];
  const borderThin = '<left style="thin"><color theme="0" tint="-0.249977111117893"/></left><right style="thin"><color theme="0" tint="-0.249977111117893"/></right><top style="thin"><color theme="0" tint="-0.249977111117893"/></top><bottom style="thin"><color theme="0" tint="-0.249977111117893"/></bottom><diagonal/>';
  const styles = xml(
    `<styleSheet ${S}>` +
      `<fonts count="5"><font><sz val="11"/><name val="Arial"/></font><font><b/><sz val="16"/><color theme="4"/><name val="Arial"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Arial"/></font><font><b/><sz val="11"/><name val="Arial"/></font><font><i/><sz val="10"/><color rgb="FFC00000"/><name val="Arial"/></font></fonts>` +
      `<fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor theme="4"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor theme="4" tint="0.79998168889431442"/><bgColor indexed="64"/></patternFill></fill></fills>` +
      `<borders count="3"><border><left/><right/><top/><bottom/><diagonal/></border><border>${borderThin}</border><border><left/><right/><top style="thin"/><bottom style="double"/><diagonal/></border></borders>` +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="10">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="4" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>' +
      '<xf numFmtId="14" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"><alignment horizontal="center"/></xf>' +
      '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1"/>' +
      '<xf numFmtId="0" fontId="3" fillId="3" borderId="2" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right"/></xf>' +
      '<xf numFmtId="4" fontId="3" fillId="3" borderId="2" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1"/>' +
      '<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyBorder="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>' +
      '</cellXfs></styleSheet>',
  );
  const sheetType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';
  const props = docProps({ title: 'Parts list', subject: 'Test file for the Excel viewer', keywords: 'sample, Excel' });
  return storedZip([
    ['[Content_Types].xml', contentTypes([], [
      ['/xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
      ['/xl/worksheets/sheet1.xml', sheetType],
      ['/xl/worksheets/sheet2.xml', sheetType],
      ['/xl/styles.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml'],
      ...props.overrides,
    ])],
    ['_rels/.rels', relationships([['rId1', 'officeDocument', 'xl/workbook.xml'], ...props.rels])],
    ...props.files,
    ['xl/workbook.xml', xml(`<workbook ${S} xmlns:r="${REL}"><sheets><sheet name="Parts" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>`)],
    ['xl/_rels/workbook.xml.rels', relationships([['rId1', 'worksheet', 'worksheets/sheet1.xml'], ['rId2', 'worksheet', 'worksheets/sheet2.xml'], ['rId3', 'styles', 'styles.xml']])],
    ['xl/worksheets/sheet1.xml', sheet(rows1, [28, 16, 9, 16, 13, 13], { merges: ['A1:F1'], heights: { 1: 30, 2: 22 } })],
    ['xl/worksheets/sheet2.xml', sheet(rows2, [40], { heights: { 2: 60 } })],
    ['xl/styles.xml', styles],
  ]);
}

function samplePptx(imagePng) {
  const NS = `xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${REL}" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"`;
  const emptyTree = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/>';
  const textBox = (id, name, [x, y, w, h], text, size, color, bold = false) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr wrap="square"/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${size}"${bold ? ' b="1"' : ''}><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:latin typeface="Arial"/></a:rPr><a:t>${escapeXml(text)}</a:t></a:r></a:p></p:txBody></p:sp>`;
  const shape = (id, [x, y, w, h], fill, geometry = 'roundRect') =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="${geometry}"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${fill}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr></p:sp>`;
  const picture = (id, [x, y, w, h]) =>
    `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Motif"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="rId2"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  const slide = (background, content) =>
    xml(`<p:sld ${NS}><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="${background}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree>${emptyTree}${content}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
  const slide1 = slide('FFF4E8', [
    shape(2, [0, 6400800, 12192000, 457200], 'F29A38', 'rect'),
    textBox(3, 'Title', [914400, 2133600, 10363200, 1143000], 'Peekbean', 5400, '1B1E23', true),
    textBox(4, 'Subtitle', [914400, 3352800, 10363200, 685800], 'Sample presentation, generated by generate-samples.mjs', 2400, '525B66'),
  ].join(''));
  const slide2 = slide('FFFFFF', [
    textBox(2, 'Title', [609600, 457200, 10972800, 914400], 'Second slide: shapes and picture', 3600, '1B1E23', true),
    shape(3, [609600, 1676400, 3200400, 1600200], 'F29A38'),
    textBox(4, 'Text 1', [762000, 2209800, 2895600, 609600], 'Orange area', 2000, '1B1E23'),
    shape(5, [609600, 3505200, 3200400, 1600200], '5CC98B', 'ellipse'),
    picture(6, [4419600, 1676400, 6705600, 4191000]),
  ].join(''));
  // Placeholders without own position or text style inherit both from layout and master, as in most real decks.
  const placeholder = (id, name, ph, xfrm, paragraphs) =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm ?? ''}</p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${paragraphs
      .map((t) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${escapeXml(t)}</a:t></a:r></a:p>`)
      .join('')}</p:txBody></p:sp>`;
  const at = ([x, y, w, h]) => `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${w}" cy="${h}"/></a:xfrm>`;
  const TITLE_BOX = [609600, 365125, 10972800, 1325563];
  const BODY_BOX = [609600, 1825625, 6400800, 4351338];
  // A group scales its children from child coordinates (chOff/chExt) into its own box.
  const group = `<p:grpSp><p:nvGrpSpPr><p:cNvPr id="10" name="Group 1"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="7315200" y="2286000"/><a:ext cx="3657600" cy="1828800"/><a:chOff x="0" y="0"/><a:chExt cx="1828800" cy="914400"/></a:xfrm></p:grpSpPr>${shape(11, [0, 0, 880000, 914400], 'F29A38', 'rect')}${shape(12, [948800, 0, 880000, 914400], '5CC98B', 'ellipse')}</p:grpSp>`;
  const slide3 = slide('FFFFFF', [
    placeholder(2, 'Title 1', '<p:ph type="title"/>', null, ['Third slide: placeholders and a group']),
    placeholder(3, 'Content 2', '<p:ph idx="1"/>', null, ['Position comes from the layout', 'Font and bullets come from the master', 'Right: two shapes in a group']),
    group,
  ].join(''));
  const masterTree = `${emptyTree}${placeholder(2, 'Title placeholder', '<p:ph type="title"/>', at(TITLE_BOX), ['Title'])}${placeholder(3, 'Text placeholder', '<p:ph type="body" idx="1"/>', at([609600, 1825625, 10972800, 4351338]), ['Text'])}`;
  const txStyles =
    '<p:txStyles><p:titleStyle><a:lvl1pPr algn="l"><a:defRPr sz="4000" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>' +
    '<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="•"/><a:defRPr sz="2400"><a:solidFill><a:schemeClr val="accent1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:bodyStyle>' +
    '<p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles>';
  const layout2Tree = `${emptyTree}${placeholder(2, 'Title', '<p:ph type="title"/>', at(TITLE_BOX), ['Title'])}${placeholder(3, 'Content', '<p:ph idx="1"/>', at(BODY_BOX), ['Text'])}`;
  const scheme =[['dk1', '1B1E23'], ['lt1', 'FFFFFF'], ['dk2', '2D323A'], ['lt2', 'F3F4F6'], ['accent1', 'F29A38'], ['accent2', '5CC98B'], ['accent3', '9AA6FF'], ['accent4', 'E8C547'], ['accent5', 'F07470'], ['accent6', '7F8994'], ['hlink', 'AD5A0C'], ['folHlink', '7F8994']];
  const three = (x) => x + x + x;
  const theme = xml(
    `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Everything"><a:themeElements><a:clrScheme name="Everything">${scheme
      .map(([k, v]) => `<a:${k}><a:srgbClr val="${v}"/></a:${k}>`)
      .join('')}</a:clrScheme><a:fontScheme name="Everything"><a:majorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Everything"><a:fillStyleLst>${three('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>')}</a:fillStyleLst><a:lnStyleLst>${three('<a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>')}</a:lnStyleLst><a:effectStyleLst>${three('<a:effectStyle><a:effectLst/></a:effectStyle>')}</a:effectStyleLst><a:bgFillStyleLst>${three('<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>')}</a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`,
  );
  const P = 'application/vnd.openxmlformats-officedocument.presentationml';
  return storedZip([
    ['[Content_Types].xml', contentTypes([['png', 'image/png']], [
      ['/ppt/presentation.xml', `${P}.presentation.main+xml`],
      ['/ppt/slides/slide1.xml', `${P}.slide+xml`],
      ['/ppt/slides/slide2.xml', `${P}.slide+xml`],
      ['/ppt/slides/slide3.xml', `${P}.slide+xml`],
      ['/ppt/slideLayouts/slideLayout1.xml', `${P}.slideLayout+xml`],
      ['/ppt/slideLayouts/slideLayout2.xml', `${P}.slideLayout+xml`],
      ['/ppt/slideMasters/slideMaster1.xml', `${P}.slideMaster+xml`],
      ['/ppt/theme/theme1.xml', 'application/vnd.openxmlformats-officedocument.theme+xml'],
    ])],
    ['_rels/.rels', relationships([['rId1', 'officeDocument', 'ppt/presentation.xml']])],
    ['ppt/presentation.xml', xml(`<p:presentation ${NS}><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/><p:sldId id="257" r:id="rId3"/><p:sldId id="258" r:id="rId5"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`)],
    ['ppt/_rels/presentation.xml.rels', relationships([['rId1', 'slideMaster', 'slideMasters/slideMaster1.xml'], ['rId2', 'slide', 'slides/slide1.xml'], ['rId3', 'slide', 'slides/slide2.xml'], ['rId4', 'theme', 'theme/theme1.xml'], ['rId5', 'slide', 'slides/slide3.xml']])],
    ['ppt/slideMasters/slideMaster1.xml', xml(`<p:sldMaster ${NS}><p:cSld><p:spTree>${masterTree}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId3"/></p:sldLayoutIdLst>${txStyles}</p:sldMaster>`)],
    ['ppt/slideMasters/_rels/slideMaster1.xml.rels', relationships([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'theme', '../theme/theme1.xml'], ['rId3', 'slideLayout', '../slideLayouts/slideLayout2.xml']])],
    ['ppt/slideLayouts/slideLayout1.xml', xml(`<p:sldLayout ${NS} type="blank"><p:cSld name="Blank"><p:spTree>${emptyTree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)],
    ['ppt/slideLayouts/_rels/slideLayout1.xml.rels', relationships([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])],
    ['ppt/slideLayouts/slideLayout2.xml', xml(`<p:sldLayout ${NS} type="obj"><p:cSld name="Title and Content"><p:spTree>${layout2Tree}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`)],
    ['ppt/slideLayouts/_rels/slideLayout2.xml.rels', relationships([['rId1', 'slideMaster', '../slideMasters/slideMaster1.xml']])],
    ['ppt/slides/slide3.xml', slide3],
    ['ppt/slides/_rels/slide3.xml.rels', relationships([['rId1', 'slideLayout', '../slideLayouts/slideLayout2.xml']])],
    ['ppt/slides/slide1.xml', slide1],
    ['ppt/slides/_rels/slide1.xml.rels', relationships([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml']])],
    ['ppt/slides/slide2.xml', slide2],
    ['ppt/slides/_rels/slide2.xml.rels', relationships([['rId1', 'slideLayout', '../slideLayouts/slideLayout1.xml'], ['rId2', 'image', '../media/motif.png']])],
    ['ppt/theme/theme1.xml', theme],
    ['ppt/media/motif.png', imagePng],
  ]);
}

// ---- STEP ---------------------------------------------------------------------------------------------------

/**
 * AP214 STEP file with axis-aligned boxes as separate colored solids, written entity by entity.
 * Faces run counter-clockwise seen from outside; corner index = x + 2y + 4z.
 */
function boxesStep(name, boxes) {
  const lines = [];
  let id = 0;
  const add = (entity) => {
    lines.push(`#${++id}=${entity};`);
    return `#${id}`;
  };
  const num = (v) => (Number.isInteger(v) ? `${v}.` : String(v));
  const point = (p) => add(`CARTESIAN_POINT('',(${p.map(num).join(',')}))`);
  const direction = (d) => add(`DIRECTION('',(${d.map(num).join(',')}))`);

  const appContext = add("APPLICATION_CONTEXT('automotive design')");
  add(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,${appContext})`);
  const productContext = add(`PRODUCT_CONTEXT('',${appContext},'mechanical')`);
  const product = add(`PRODUCT('${name}','${name}','',(${productContext}))`);
  add(`PRODUCT_RELATED_PRODUCT_CATEGORY('part',$,(${product}))`);
  const formation = add(`PRODUCT_DEFINITION_FORMATION('','',${product})`);
  const definitionContext = add(`PRODUCT_DEFINITION_CONTEXT('part definition',${appContext},'design')`);
  const definition = add(`PRODUCT_DEFINITION('design','',${formation},${definitionContext})`);
  const shape = add(`PRODUCT_DEFINITION_SHAPE('','',${definition})`);
  const length = add('(LENGTH_UNIT()NAMED_UNIT(*)SI_UNIT(.MILLI.,.METRE.))');
  const angle = add('(NAMED_UNIT(*)PLANE_ANGLE_UNIT()SI_UNIT($,.RADIAN.))');
  const solidAngle = add('(NAMED_UNIT(*)SI_UNIT($,.STERADIAN.)SOLID_ANGLE_UNIT())');
  const uncertainty = add(`UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-07),${length},'distance_accuracy_value','confusion accuracy')`);
  const context = add(`(GEOMETRIC_REPRESENTATION_CONTEXT(3)GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((${uncertainty}))GLOBAL_UNIT_ASSIGNED_CONTEXT((${length},${angle},${solidAngle}))REPRESENTATION_CONTEXT('Context3D','3D Context with UNIT and UNCERTAINTY'))`);
  const origin = add(`AXIS2_PLACEMENT_3D('',${point([0, 0, 0])},${direction([0, 0, 1])},${direction([1, 0, 0])})`);

  const FACES = [
    [[0, 2, 3, 1], [0, 0, -1]],
    [[4, 5, 7, 6], [0, 0, 1]],
    [[0, 1, 5, 4], [0, -1, 0]],
    [[3, 2, 6, 7], [0, 1, 0]],
    [[2, 0, 4, 6], [-1, 0, 0]],
    [[1, 3, 7, 5], [1, 0, 0]],
  ];
  const solids = [];
  const styled = [];
  for (const { name: solidName, min, max, color } of boxes) {
    const corners = Array.from({ length: 8 }, (_, i) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]]);
    const vertices = corners.map((c) => add(`VERTEX_POINT('',${point(c)})`));
    const edges = new Map();
    const edgeFor = (a, b) => {
      const [s, e] = a < b ? [a, b] : [b, a];
      const key = `${s}-${e}`;
      if (!edges.has(key)) {
        const delta = corners[e].map((v, i) => v - corners[s][i]);
        const len = Math.hypot(...delta);
        const line = add(`LINE('',${point(corners[s])},${add(`VECTOR('',${direction(delta.map((v) => v / len))},${num(len)})`)})`);
        edges.set(key, add(`EDGE_CURVE('',${vertices[s]},${vertices[e]},${line},.T.)`));
      }
      return { edge: edges.get(key), forward: a < b };
    };
    const faces = FACES.map(([loop, normal]) => {
      const oriented = loop.map((a, i) => {
        const { edge, forward } = edgeFor(a, loop[(i + 1) % 4]);
        return add(`ORIENTED_EDGE('',*,*,${edge},${forward ? '.T.' : '.F.'})`);
      });
      const first = corners[loop[0]];
      const along = corners[loop[1]].map((v, i) => v - first[i]);
      const plane = add(`PLANE('',${add(`AXIS2_PLACEMENT_3D('',${point(first)},${direction(normal)},${direction(along.map((v) => v / Math.hypot(...along)))})`)})`);
      const bound = add(`FACE_OUTER_BOUND('',${add(`EDGE_LOOP('',(${oriented.join(',')}))`)},.T.)`);
      return add(`ADVANCED_FACE('',(${bound}),${plane},.T.)`);
    });
    const solid = add(`MANIFOLD_SOLID_BREP('${solidName}',${add(`CLOSED_SHELL('',(${faces.join(',')}))`)})`);
    solids.push(solid);
    const rgb = add(`COLOUR_RGB('',${color.map(num).join(',')})`);
    const fill = add(`FILL_AREA_STYLE('',(${add(`FILL_AREA_STYLE_COLOUR('',${rgb})`)}))`);
    const side = add(`SURFACE_SIDE_STYLE('',(${add(`SURFACE_STYLE_FILL_AREA(${fill})`)}))`);
    const assignment = add(`PRESENTATION_STYLE_ASSIGNMENT((${add(`SURFACE_STYLE_USAGE(.BOTH.,${side})`)}))`);
    styled.push(add(`STYLED_ITEM('color',(${assignment}),${solid})`));
  }
  const representation = add(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${origin},${solids.join(',')}),${context})`);
  add(`SHAPE_DEFINITION_REPRESENTATION(${shape},${representation})`);
  add(`MECHANICAL_DESIGN_GEOMETRIC_PRESENTATION_REPRESENTATION('',(${styled.join(',')}),${context})`);

  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('Peekbean sample'),'2;1');",
    `FILE_NAME('${name}.step','2026-10-26T00:00:00',('Peekbean'),(''),'generate-samples.mjs','','');`,
    "FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));",
    'ENDSEC;',
    'DATA;',
    ...lines,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

// ---- Archives, e-mail, audio --------------------------------------------------------------------------------

function tar(entries) {
  const blocks = [];
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 'latin1');
    header.write('0000000\0', 108, 'latin1');
    header.write('0000000\0', 116, 'latin1');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
    header.write(`${Math.floor(Date.UTC(2026, 9, 26) / 1000).toString(8).padStart(11, '0')}\0`, 136, 'latin1');
    header.write('        ', 148, 'latin1');
    header.write('0', 156, 'latin1');
    header.write('ustar\0', 257, 'latin1');
    header.write('00', 263, 'latin1');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

const base64Lines = (data) => data.toString('base64').replace(/.{76}/g, '$&\r\n');

function sampleEml(imagePng, csv, pdf) {
  const html = `<!doctype html>
<html><head><style>body{font-family:Arial,sans-serif;color:#1b1e23;max-width:640px;margin:24px} .box{background:#fff4e8;border-left:4px solid #f29a38;padding:12px 16px}</style></head>
<body>
<h1>Hello Jane,</h1>
<p>this sample e-mail tests the e-mail viewer: HTML content, an embedded picture, attachments and blocked content.</p>
<div class="box">The picture below is part of the e-mail (cid:) and is shown.</div>
<p><img src="cid:motif@example.org" width="320" alt="Motif"></p>
<p>The following tracking pixel lives on another server and must be blocked:
<img src="https://tracker.example.com/pixel.gif?id=12345" width="1" height="1" alt=""></p>
<p id="script-check">Script ran: no</p>
<script>document.getElementById('script-check').textContent = 'Script ran: YES (error!)';</script>
<p><a href="https://www.gnu.org/licenses/gpl-3.0.html">A link that opens in a new tab</a></p>
<p>Best regards<br>Peekbean</p>
</body></html>`;
  const text = 'Hello Jane,\r\n\r\nthis sample e-mail tests the e-mail viewer.\r\n\r\nBest regards\r\nPeekbean\r\n';
  return [
    'From: Peekbean <viewer@example.org>',
    'To: Jane Doe <jane@example.org>',
    'Cc: John Doe <john@example.org>',
    'Subject: =?UTF-8?Q?Sample_e-mail_with_attachments_=E2=80=93_caf=C3=A9_menu?=',
    'Date: Mon, 26 Oct 2026 09:30:00 +0100',
    'Message-ID: <sample-1@example.org>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="mixed-boundary"',
    '',
    '--mixed-boundary',
    'Content-Type: multipart/related; boundary="related-boundary"',
    '',
    '--related-boundary',
    'Content-Type: multipart/alternative; boundary="alt-boundary"',
    '',
    '--alt-boundary',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(text, 'utf8')),
    '--alt-boundary',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(Buffer.from(html, 'utf8')),
    '--alt-boundary--',
    '--related-boundary',
    'Content-Type: image/png; name="motif.png"',
    'Content-Transfer-Encoding: base64',
    'Content-ID: <motif@example.org>',
    'Content-Disposition: inline; filename="motif.png"',
    '',
    base64Lines(imagePng),
    '--related-boundary--',
    '--mixed-boundary',
    'Content-Type: text/csv; charset=utf-8; name="parts.csv"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="parts.csv"',
    '',
    base64Lines(Buffer.from(csv, 'utf8')),
    '--mixed-boundary',
    'Content-Type: application/pdf; name="document.pdf"',
    'Content-Transfer-Encoding: base64',
    'Content-Disposition: attachment; filename="document.pdf"',
    '',
    base64Lines(pdf),
    '--mixed-boundary--',
    '',
  ].join('\r\n');
}

/** 1.5 s, 22.05 kHz, 16-bit mono: a 440 Hz tone with a short fade in and out. */
function toneWav() {
  const rate = 22050;
  const samples = Math.round(rate * 1.5);
  const out = Buffer.alloc(44 + samples * 2);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + samples * 2, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) {
    const fade = Math.min(1, i / (rate * 0.05), (samples - i) / (rate * 0.05));
    out.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 12000 * fade), 44 + i * 2);
  }
  return out;
}

async function sampleSqlite(thumbnail) {
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run(`
    CREATE TABLE parts (item INTEGER PRIMARY KEY, description TEXT NOT NULL, material TEXT, quantity INTEGER, price REAL, picture BLOB);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT, customer TEXT, start TEXT);
    CREATE VIEW expensive_parts AS SELECT description, quantity * price AS total FROM parts WHERE price > 1 ORDER BY total DESC;
  `);
  const insert = db.prepare('INSERT INTO parts (description, material, quantity, price, picture) VALUES (?, ?, ?, ?, ?)');
  for (const [name, material, qty, price, image] of [
    ['Gear z18', 'C45', 1, 64.0, thumbnail],
    ['Flange plate', 'S235JR', 2, 38.5, null],
    ['Hex bolt M8x30', '8.8 zinc plated', 24, 0.18, null],
    ['Hex nut M8', '8 zinc plated', 24, 0.06, null],
    ['Shaft seal 30x47x7', 'NBR', 2, 3.9, null],
  ]) insert.run([name, material, qty, price, image]);
  insert.free();
  db.run("INSERT INTO projects (name, customer, start) VALUES ('Gearbox A', 'Example Shipyard Ltd.', '2026-09-01'), ('Bracket B', 'Sample Inc.', '2026-10-15')");
  const bytes = Buffer.from(db.export());
  db.close();
  return bytes;
}

const HTML_SAMPLE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Sample page</title>
<style>
  body { font-family: Arial, sans-serif; color: #1b1e23; margin: 32px; max-width: 760px; }
  h1 { border-bottom: 3px solid #f29a38; padding-bottom: 6px; }
  table { border-collapse: collapse; } td, th { border: 1px solid #d3d8de; padding: 4px 10px; }
  .warn { background: #fff4e8; padding: 10px 14px; border-radius: 8px; }
</style>
<link rel="stylesheet" href="https://cdn.example.com/external-stylesheet.css">
</head>
<body>
<h1>Sample page</h1>
<p>This HTML file is shown isolated: without scripts and without access to other servers.</p>
<p class="warn" id="script-check">Script ran: no</p>
<table><tr><th>Part</th><th>Quantity</th></tr><tr><td>Gear</td><td>1</td></tr><tr><td>Flange plate</td><td>2</td></tr></table>
<p>External image (blocked): <img src="https://images.example.com/photo.jpg" alt="blocked" width="80" height="40"></p>
<form action="https://example.com/send"><input name="q" value="Forms are not sent"><button>Send</button></form>
<script>document.getElementById('script-check').textContent = 'Script ran: YES (error!)'; fetch('https://example.com/leak');</script>
</body>
</html>
`;

// ---- Photo metadata -----------------------------------------------------------------------------------------

/** One TIFF directory (big-endian) at the given offset: entries [tag, type, values], larger values after it. */
function tiffIfd(entries, offset) {
  const [BYTE, ASCII, SHORT, LONG, RATIONAL] = [1, 2, 3, 4, 5];
  const sorted = [...entries].sort((a, b) => a[0] - b[0]);
  const size = 2 + sorted.length * 12 + 4;
  const head = Buffer.alloc(size);
  const data = [];
  let dataOffset = offset + size;
  head.writeUInt16BE(sorted.length, 0);
  sorted.forEach(([tag, type, value], i) => {
    let bytes;
    if (type === ASCII) bytes = Buffer.from(`${value}\0`, 'latin1');
    else if (type === BYTE) bytes = Buffer.from(value);
    else {
      const width = type === SHORT ? 2 : type === LONG ? 4 : 8;
      bytes = Buffer.alloc(value.length * width);
      value.forEach((v, j) => {
        if (type === SHORT) bytes.writeUInt16BE(v, j * 2);
        else if (type === LONG) bytes.writeUInt32BE(v, j * 4);
        else if (type === RATIONAL) {
          bytes.writeUInt32BE(v[0], j * 8);
          bytes.writeUInt32BE(v[1], j * 8 + 4);
        }
      });
    }
    const at = 2 + i * 12;
    head.writeUInt16BE(tag, at);
    head.writeUInt16BE(type, at + 2);
    head.writeUInt32BE(type === ASCII || type === BYTE ? bytes.length : value.length, at + 4);
    if (bytes.length <= 4) bytes.copy(head, at + 8);
    else {
      head.writeUInt32BE(dataOffset, at + 8);
      const padded = bytes.length & 1 ? Buffer.concat([bytes, Buffer.alloc(1)]) : bytes;
      data.push(padded);
      dataOffset += padded.length;
    }
  });
  return Buffer.concat([head, ...data]);
}

/**
 * JPEG APP1 segment with an EXIF block: camera, exposure, time and a GPS position at the Brandenburg Gate in Berlin
 * (a public place, 52.516275 N, 13.377704 E), for the info panel.
 */
function exifSegment() {
  const [BYTE, ASCII, SHORT, LONG, RATIONAL] = [1, 2, 3, 4, 5];
  const ifd0 = (exifAt, gpsAt) => [
    [0x010f, ASCII, 'Peekbean'],
    [0x0110, ASCII, 'Sample camera EV-1'],
    [0x0112, SHORT, [1]],
    [0x0131, ASCII, 'generate-samples.mjs'],
    [0x0132, ASCII, '2026:05:01 14:30:00'],
    [0x8298, ASCII, 'CC0-1.0'],
    [0x8769, LONG, [exifAt]],
    [0x8825, LONG, [gpsAt]],
  ];
  const exif = [
    [0x829a, RATIONAL, [[1, 250]]],
    [0x829d, RATIONAL, [[28, 10]]],
    [0x8827, SHORT, [100]],
    [0x9003, ASCII, '2026:05:01 14:30:00'],
    [0x9011, ASCII, '+02:00'],
    [0x9209, SHORT, [16]],
    [0x920a, RATIONAL, [[42, 10]]],
    [0xa002, LONG, [320]],
    [0xa003, LONG, [200]],
    [0xa405, SHORT, [26]],
    [0xa434, ASCII, 'Sample lens 4.2 mm'],
  ];
  const gps = [
    [0x0000, BYTE, [2, 3, 0, 0]],
    [0x0001, ASCII, 'N'],
    [0x0002, RATIONAL, [[52, 1], [30, 1], [5859, 100]]],
    [0x0003, ASCII, 'E'],
    [0x0004, RATIONAL, [[13, 1], [22, 1], [3973, 100]]],
    [0x0005, BYTE, [0]],
    [0x0006, RATIONAL, [[34, 1]]],
    [0x0010, ASCII, 'T'],
    [0x0011, RATIONAL, [[90, 1]]],
  ];
  // Offsets depend on the sizes before them; the first directory has the same size with any pointer values.
  const ifd0Size = tiffIfd(ifd0(0, 0), 8).length;
  const exifBytes = tiffIfd(exif, 8 + ifd0Size);
  const gpsBytes = tiffIfd(gps, 8 + ifd0Size + exifBytes.length);
  const header = Buffer.from([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08]);
  const tiff = Buffer.concat([header, tiffIfd(ifd0(8 + ifd0Size, 8 + ifd0Size + exifBytes.length), 8), exifBytes, gpsBytes]);
  const length = Buffer.alloc(2);
  length.writeUInt16BE(2 + 6 + tiff.length);
  return Buffer.concat([Buffer.from([0xff, 0xe1]), length, Buffer.from('Exif\0\0', 'latin1'), tiff]);
}

/** The motif photo with EXIF data inserted right after the start-of-image marker. */
function photoWithExif() {
  const jpeg = readFileSync(path.join(ROOT, 'images', 'motif.jpg'));
  return Buffer.concat([jpeg.subarray(0, 2), exifSegment(), jpeg.subarray(2)]);
}

// ---- Generate -----------------------------------------------------------------------------------------------

const motifRgba = pixels(640, 400);
const motifPng = png(640, 400, motifRgba);
write('images/motif.png', motifPng);
write('images/motif.bmp', bmp(320, 200, pixels(320, 200)));
write('images/icon.ico', ico(32, png(32, 32, pixels(32, 32))));
write('images/photo-exif.jpg', photoWithExif());
write(
  'images/animation.gif',
  animatedGif(120, 80, 10, (x, y, f) => {
    const cx = 15 + f * 10;
    const inside = (x - cx) ** 2 + (y - 40) ** 2 < 12 ** 2;
    return inside ? [255, 153, 51] : [235, 238, 241];
  }),
);
write(
  'images/vector.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#fff4e8"/>
      <stop offset="1" stop-color="#f29a38"/>
    </linearGradient>
  </defs>
  <rect width="640" height="400" rx="24" fill="url(#bg)"/>
  <path d="M120 200s70-110 200-110 200 110 200 110-70 110-200 110-200-110-200-110Z" fill="none" stroke="#1b1e23" stroke-width="14" stroke-linejoin="round"/>
  <circle cx="320" cy="200" r="48" fill="#1b1e23"/>
  <text x="320" y="370" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#1b1e23">Vector graphic, scales to any size</text>
</svg>
`,
);
// Scripts inside an SVG must not run when it is shown as an image.
write(
  'images/svg-with-script.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">
  <rect width="320" height="120" fill="#e9fbe9"/>
  <text x="160" y="66" font-family="sans-serif" font-size="16" text-anchor="middle">Safe: the script did not run</text>
  <script>document.querySelector('rect').setAttribute('fill', 'red'); alert('Script ran');</script>
</svg>
`,
);

write('pdf/document.pdf', samplePdf());
write('pdf/layers.pdf', layersPdf());

const gear = gearMesh();
write('3d/gear.stl', binaryStl(gear, 'Gear z18, generated by generate-samples.mjs'));
write('3d/gear.3mf', threeMf(gear));
write('3d/pyramid-ascii.stl', asciiStl(pyramidMesh(), 'pyramid'));
write('3d/torus.obj', torusObj());
write('3d/sphere-points.ply', spherePly());
const cube = coloredCubeGltf();
write('3d/colored-cube.glb', glb(cube));
write('3d/colored-cube.gltf', embeddedGltf(cube));

write('cad/flange.dxf', flangeDxf());

write('text/example.ts', TS_SAMPLE);
write('text/example.py', PY_SAMPLE);
write('text/parts.csv', CSV_SAMPLE);
write('text/data.json', JSON_SAMPLE);
write('text/config.xml', XML_SAMPLE);
write('text/notes.md', MD_SAMPLE);
write('cnc/flange-drilling.nc', GCODE_SAMPLE);
write('text/viewer.log', logSample());
write('text/Makefile', 'all:\n\tnpm run build\n\nsamples:\n\tnode scripts/generate-samples.mjs\n');
write('text/windows-1252.txt', windows1252('Text in Windows-1252: café in Zürich, size 12 × 30 mm, ±0.1, price 12.50 €.\r\n'));
write('text/utf-16le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Text in UTF-16 LE with BOM: café, ½ inch, → arrow, Ω\r\n', 'utf16le')]));

const random = prng(42);
const bin = Buffer.alloc(64 * 1024);
for (let i = 0; i < bin.length; i++) bin[i] = Math.floor(random() * 256);
bin.write('PEEKBEAN-SAMPLE', 0x400, 'latin1');
write('binary/random.bin', bin);

write('edge-cases/broken.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog', 'latin1'));
write('edge-cases/truncated.png', motifPng.subarray(0, 300));
write('edge-cases/empty.txt', '');
write('edge-cases/png-named-as.txt', motifPng);
write('edge-cases/pdf-without-extension', samplePdf());
write('edge-cases/unknown-extension.qqq', 'Unknown extension, but text content: recognized as text.\n');

const smallPng = png(320, 200, pixels(320, 200));
write('office/document.docx', sampleDocx(smallPng));
write('office/parts.xlsx', sampleXlsx());
write('office/presentation.pptx', samplePptx(smallPng));

write(
  'cad/bracket.step',
  boxesStep('Bracket', [
    { name: 'Base plate', min: [0, 0, 0], max: [80, 40, 6], color: [0.6, 0.64, 0.7] },
    { name: 'Web', min: [0, 34, 6], max: [80, 40, 46], color: [0.95, 0.6, 0.22] },
    { name: 'Rib', min: [37, 10, 6], max: [43, 34, 20], color: [0.36, 0.79, 0.55] },
  ]),
);

const archiveFiles = [
  ['readme.txt', 'Sample archive, generated by scripts/generate-samples.mjs.\n'],
  ['docs/notes.md', MD_SAMPLE],
  ['docs/Overview – café.csv', CSV_SAMPLE],
  ['images/motif.png', smallPng],
  ['cad/flange.dxf', flangeDxf()],
];
write('archives/example.zip', storedZip(archiveFiles));
write('archives/encrypted.zip', storedZip([['secret.txt', 'The password was right: everything\n'], ['motif.png', smallPng]], 'everything'));
const tarball = tar(archiveFiles);
write('archives/example.tar', tarball);
write('archives/example.tar.gz', gzipSync(tarball));
write('archives/notes.md.gz', gzipSync(Buffer.from(MD_SAMPLE, 'utf8')));

write('mail/newsletter.eml', sampleEml(smallPng, CSV_SAMPLE, samplePdf()));
write('media/tone.wav', toneWav());
write('database/parts.sqlite', await sampleSqlite(png(32, 32, pixels(32, 32))));
write('web/page.html', HTML_SAMPLE);

const plex = path.resolve(import.meta.dirname, '..', 'node_modules', '@fontsource', 'ibm-plex-sans');
for (const ext of ['woff', 'woff2']) {
  write(`fonts/ibm-plex-sans-latin-400-normal.${ext}`, readFileSync(path.join(plex, 'files', `ibm-plex-sans-latin-400-normal.${ext}`)));
}
write('fonts/OFL-IBM-Plex.txt', readFileSync(path.join(plex, 'LICENSE')));

for (const [rel, size] of written) console.log(`${String(size).padStart(8)}  samples/${rel}`);
