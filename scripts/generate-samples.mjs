// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the sample files in samples/. Everything is drawn from scratch here, so the output can be published as CC0-1.0.
// Usage: node scripts/generate-samples.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..', 'samples');
const written = [];

function write(rel, data) {
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
  // Object 1: catalog, 2: pages, 3: font, 4: info, then page/content pairs.
  const objects = [];
  const pageIds = pages.map((_, i) => 5 + i * 2);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
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
    objects[id] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}]${extra} /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R${annots} >>`;
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
    text(72, 770, 24, 'Everything Viewer - Beispiel-PDF'),
    text(72, 740, 12, 'Dieses Dokument wurde von scripts/generate-samples.mjs erzeugt.'),
    text(72, 700, 12, 'Es testet Text, Umlaute (äöü ÄÖÜ ß), Vektorgrafik, Links und gedrehte Seiten.'),
    text(72, 680, 12, 'Suchbegriff zum Testen der Suche: Werft (kommt auf drei Seiten vor).'),
    text(72, 640, 12, 'Link: https://www.gnu.org/licenses/gpl-3.0.html'),
    '0.95 0.6 0.22 rg 72 520 451 80 re f',
    '0.11 0.12 0.14 rg',
    text(90, 552, 16, 'Gefüllte Fläche mit Text darüber'),
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
  const page2 = [text(72, 770, 20, 'Seite 2: Vektorgrafik'), text(72, 745, 12, 'Raster und Kreis, beim Zoomen gestochen scharf. Werft.'), ...shapes].join('\n');

  const page3 = [text(72, 520, 20, 'Seite 3: Querformat'), text(72, 490, 12, 'Diese Seite ist im Querformat angelegt. Werft.')].join('\n');

  return pdfDocument(
    [
      { content: page1, links: [{ rect: [72, 636, 340, 652], uri: 'https://www.gnu.org/licenses/gpl-3.0.html' }] },
      { content: page2 },
      { content: page3, size: [842, 595] },
    ],
    { title: 'Everything Viewer Beispiel', author: 'Everything Viewer' },
  );
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
  const lines = ['# Torus, erzeugt von scripts/generate-samples.mjs', 'o Torus'];
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
    'comment Punktwolke, erzeugt von scripts/generate-samples.mjs',
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

/** ZIP archive without compression (enough for 3MF). */
function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, content] of entries) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x21, 12); // DOS date 1980-01-01
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
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
    '<metadata name="Title">Zahnrad</metadata>',
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
  const layers = [['0', 7, 'CONTINUOUS'], ['KONTUR', 7, 'CONTINUOUS'], ['BOHRUNGEN', 1, 'CONTINUOUS'], ['MITTELLINIEN', 5, 'CENTER'], ['TEXT', 3, 'CONTINUOUS']];
  add(0, 'TABLE', 2, 'LAYER', 70, layers.length);
  for (const [name, color, ltype] of layers) add(0, 'LAYER', 2, name, 70, 0, 62, color, 6, ltype);
  add(0, 'ENDTAB', 0, 'ENDSEC');

  add(0, 'SECTION', 2, 'ENTITIES');
  const circle = (layer, x, y, r) => add(0, 'CIRCLE', 8, layer, 10, x, 20, y, 30, 0, 40, r);
  const line = (layer, x1, y1, x2, y2) => add(0, 'LINE', 8, layer, 10, x1, 20, y1, 30, 0, 11, x2, 21, y2, 31, 0);
  // Outline: square plate 160 × 160 with rounded corners (radius 15).
  const [s, rc] = [80, 15];
  line('KONTUR', -s + rc, -s, s - rc, -s);
  line('KONTUR', s, -s + rc, s, s - rc);
  line('KONTUR', s - rc, s, -s + rc, s);
  line('KONTUR', -s, s - rc, -s, -s + rc);
  for (const [x, y, start] of [[s - rc, -s + rc, 270], [s - rc, s - rc, 0], [-s + rc, s - rc, 90], [-s + rc, -s + rc, 180]]) {
    add(0, 'ARC', 8, 'KONTUR', 10, x, 20, y, 30, 0, 40, rc, 50, start, 51, start + 90);
  }
  circle('BOHRUNGEN', 0, 0, 30);
  circle('MITTELLINIEN', 0, 0, 55); // bolt circle
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    circle('BOHRUNGEN', +(55 * Math.cos(a)).toFixed(4), +(55 * Math.sin(a)).toFixed(4), 6.5);
  }
  line('MITTELLINIEN', -95, 0, 95, 0);
  line('MITTELLINIEN', 0, -95, 0, 95);
  add(0, 'TEXT', 8, 'TEXT', 10, -80, 20, -115, 30, 0, 40, 7, 1, 'FLANSCHPLATTE 160x160x12  -  Werkstoff S235JR');
  add(0, 'TEXT', 8, 'TEXT', 10, -80, 20, -127, 30, 0, 40, 4, 1, 'Beispielzeichnung, erzeugt von generate-samples.mjs');
  add(0, 'ENDSEC', 0, 'EOF');
  return `${g.join('\r\n')}\r\n`;
}

// ---- Text ---------------------------------------------------------------------------------------------------

const TS_SAMPLE = `// Beispiel: Zahnradabmessungen berechnen
export interface Gear {
  module: number; // Modul in mm
  teeth: number;
}

export function pitchDiameter({ module, teeth }: Gear): number {
  return module * teeth;
}

export function tipDiameter(gear: Gear): number {
  return pitchDiameter(gear) + 2 * gear.module;
}

const gear: Gear = { module: 1.5, teeth: 18 };
console.log(\`Teilkreis: \${pitchDiameter(gear)} mm, Kopfkreis: \${tipDiameter(gear)} mm\`);
`;

const PY_SAMPLE = `"""Beispiel: Schraubenliste auswerten."""
import csv
from collections import Counter


def count_by_size(path: str) -> Counter:
    with open(path, encoding="utf-8") as f:
        rows = csv.DictReader(f, delimiter=";")
        return Counter(row["Groesse"] for row in rows)


if __name__ == "__main__":
    for size, n in count_by_size("teile.csv").most_common():
        print(f"{size}: {n} Stück")
`;

const CSV_SAMPLE = `Pos;Benennung;Groesse;Werkstoff;Menge;Preis (EUR)
1;Sechskantschraube;M8x30;8.8 verzinkt;24;0,18
2;Sechskantmutter;M8;8 verzinkt;24;0,06
3;Unterlegscheibe;8,4;St verzinkt;48;0,03
4;Zylinderschraube;M6x20;A2-70;12;0,22
5;Flanschplatte;160x160x12;S235JR;2;38,50
6;Zahnrad;m1,5 z18;C45;1;64,00
`;

const JSON_SAMPLE = `${JSON.stringify(
  {
    projekt: 'Everything Viewer',
    beschreibung: 'Beispieldaten für den JSON-Viewer',
    version: 1,
    bauteile: [
      { id: 'zahnrad', datei: '3d/gear.stl', masse_g: 182.4, werkstoff: 'C45' },
      { id: 'flansch', datei: 'cad/flange.dxf', masse_g: 2410, werkstoff: 'S235JR' },
    ],
    optionen: { einheit: 'mm', toleranz: 0.1, aktiv: true, notiz: null },
  },
  null,
  2,
)}\n`;

const XML_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<!-- Beispielkonfiguration -->
<konfiguration version="1.0">
  <einheit>mm</einheit>
  <bauteil id="zahnrad" werkstoff="C45">
    <zaehne>18</zaehne>
    <modul>1.5</modul>
  </bauteil>
  <bauteil id="flansch" werkstoff="S235JR">
    <bohrungen anzahl="6" durchmesser="13" lochkreis="110"/>
  </bauteil>
</konfiguration>
`;

const MD_SAMPLE = `# Beispieldokument

Dieses Markdown-Dokument testet die **Syntaxhervorhebung** im Text-Viewer.

## Liste

- Zahnrad (\`3d/gear.stl\`)
- Flanschplatte (\`cad/flange.dxf\`)

## Tabelle

| Teil | Werkstoff | Menge |
|------|-----------|------:|
| Zahnrad | C45 | 1 |
| Flansch | S235JR | 2 |

> Zitat: Nichts verlässt den Rechner.
`;

const GCODE_SAMPLE = `; Beispiel-CNC-Programm: Flanschplatte, 6 Bohrungen auf Lochkreis 110
; erzeugt von scripts/generate-samples.mjs, nicht für echte Maschinen gedacht
G21 ; Millimeter
G90 ; absolut
G17 ; XY-Ebene
T1 M6 ; Bohrer 13 mm
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
  const messages = ['Datei geöffnet', 'Viewer geladen', 'Seite gerendert', 'Cache geleert', 'Langsame Antwort', 'Datei beschädigt'];
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

// ---- Generate -----------------------------------------------------------------------------------------------

const motifRgba = pixels(640, 400);
const motifPng = png(640, 400, motifRgba);
write('images/motif.png', motifPng);
write('images/motif.bmp', bmp(320, 200, pixels(320, 200)));
write('images/icon.ico', ico(32, png(32, 32, pixels(32, 32))));
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
  <text x="320" y="370" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#1b1e23">Vektorgrafik, beliebig skalierbar</text>
</svg>
`,
);
// Scripts inside an SVG must not run when it is shown as an image.
write(
  'images/svg-with-script.svg',
  `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="120" viewBox="0 0 320 120">
  <rect width="320" height="120" fill="#e9fbe9"/>
  <text x="160" y="66" font-family="sans-serif" font-size="16" text-anchor="middle">Sicher: das Skript lief nicht</text>
  <script>document.querySelector('rect').setAttribute('fill', 'red'); alert('Skript ausgeführt');</script>
</svg>
`,
);

write('pdf/document.pdf', samplePdf());

const gear = gearMesh();
write('3d/gear.stl', binaryStl(gear, 'Zahnrad z18, erzeugt von generate-samples.mjs'));
write('3d/gear.3mf', threeMf(gear));
write('3d/pyramid-ascii.stl', asciiStl(pyramidMesh(), 'pyramide'));
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
write('text/flange-drilling.nc', GCODE_SAMPLE);
write('text/viewer.log', logSample());
write('text/Makefile', 'all:\n\tnpm run build\n\nsamples:\n\tnode scripts/generate-samples.mjs\n');
write('text/windows-1252.txt', windows1252('Text in Windows-1252: Grüße aus Köln, Maße 12 × 30 mm, Preis 12,50 €.\r\n'));
write('text/utf-16le.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('Text in UTF-16 LE mit BOM: Grüße, ½ Zoll, → Pfeil\r\n', 'utf16le')]));

const random = prng(42);
const bin = Buffer.alloc(64 * 1024);
for (let i = 0; i < bin.length; i++) bin[i] = Math.floor(random() * 256);
bin.write('EVERYTHING-VIEWER-SAMPLE', 0x400, 'latin1');
write('binary/random.bin', bin);

write('edge-cases/broken.pdf', Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog', 'latin1'));
write('edge-cases/truncated.png', motifPng.subarray(0, 300));
write('edge-cases/empty.txt', '');
write('edge-cases/png-named-as.txt', motifPng);
write('edge-cases/pdf-without-extension', samplePdf());
write('edge-cases/unknown-extension.xyz', 'Unbekannte Endung, aber Textinhalt: wird als Text erkannt.\n');

for (const [rel, size] of written) console.log(`${String(size).padStart(8)}  samples/${rel}`);
