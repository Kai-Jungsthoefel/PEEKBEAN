// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the samples of the open design formats the image and preview viewers read:
// - images/layers.ora: OpenRaster (stack.xml, two layer PNGs, mergedimage.png, thumbnail), valid per spec 0.0.6;
// - images/layers.kra: a minimal Krita document with the flattened picture and preview the viewer shows (maindoc.xml
//   lists one paint layer; its tile data is left out, so Krita itself would open an empty layer);
// - images/layers.psd: Photoshop with the same two layers and the composite (ag-psd, MIT);
// - images/drawing.eps: Encapsulated PostScript with a DOS binary header and a TIFF preview.
// Everything is drawn from scratch, so the output can be published as CC0-1.0.
// Usage: node scripts/generate-design-samples.mjs [file ...]. With file names (relative to samples/), only those are written.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

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

/** The motif of the other image samples: warm gradient, a white disk with a dark ring, a translucent stripe left. */
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

/** A second layer: a dark blue diagonal band, transparent elsewhere. */
function band(x, y, w, h) {
  const d = Math.abs(x / w - y / h - 0.1);
  return d < 0.06 ? [30, 60, 140, 220] : [0, 0, 0, 0];
}

function pixels(w, h, draw) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(draw(x, y, w, h), (y * w + x) * 4);
  return rgba;
}

/** Layers composited with "source-over", as both applications flatten them. */
function over(bottom, top) {
  const out = Buffer.alloc(bottom.length);
  for (let i = 0; i < bottom.length; i += 4) {
    const a = top[i + 3] / 255;
    const b = bottom[i + 3] / 255;
    const alpha = a + b * (1 - a);
    for (let c = 0; c < 3; c++) out[i + c] = alpha ? Math.round((top[i + c] * a + bottom[i + c] * b * (1 - a)) / alpha) : 0;
    out[i + 3] = Math.round(alpha * 255);
  }
  return out;
}

function png(w, h, rgba) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Scaled copy (nearest pixel) for thumbnails. */
function scale(rgba, w, h, tw, th) {
  const out = Buffer.alloc(tw * th * 4);
  for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) rgba.copy(out, (y * tw + x) * 4, (Math.floor((y * h) / th) * w + Math.floor((x * w) / tw)) * 4, (Math.floor((y * h) / th) * w + Math.floor((x * w) / tw)) * 4 + 4);
  return out;
}

/** A ZIP with fixed dates; the first entry ("mimetype") stored uncompressed, as both formats require. */
function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  // 2026-01-01 00:00 in MS-DOS format.
  const time = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  entries.forEach(([name, data], i) => {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const stored = i === 0;
    const body = stored ? bytes : deflateRawSync(bytes);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  });
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W = 480;
const H = 300;
const background = pixels(W, H, motif);
const stripe = pixels(W, H, band);
const merged = over(background, stripe);

// ---- OpenRaster ----------------------------------------------------------------------------------------------

write(
  'images/layers.ora',
  zip([
    ['mimetype', 'image/openraster'],
    [
      'stack.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<image version="0.0.6" w="${W}" h="${H}" xres="72" yres="72">
  <stack>
    <layer name="Band" src="data/band.png" x="0" y="0" opacity="1.0" visibility="visible" composite-op="svg:src-over"/>
    <layer name="Background" src="data/background.png" x="0" y="0" opacity="1.0" visibility="visible" composite-op="svg:src-over"/>
  </stack>
</image>
`,
    ],
    ['data/background.png', png(W, H, background)],
    ['data/band.png', png(W, H, stripe)],
    ['mergedimage.png', png(W, H, merged)],
    ['Thumbnails/thumbnail.png', png(256, 160, scale(merged, W, H, 256, 160))],
  ]),
);

// ---- Krita ---------------------------------------------------------------------------------------------------

write(
  'images/layers.kra',
  zip([
    ['mimetype', 'application/x-krita'],
    [
      'maindoc.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE DOC PUBLIC '-//KDE//DTD krita 2.0//EN' 'http://www.calligra.org/DTD/krita-2.0.dtd'>
<DOC xmlns="http://www.calligra.org/DTD/krita" syntaxVersion="2.0" editor="Krita" kritaVersion="5.2.0">
 <IMAGE width="${W}" height="${H}" mime="application/x-kra" name="layers" colorspacename="RGBA" profile="sRGB-elle-V2-srgbtrc.icc" x-res="72" y-res="72">
  <layers>
   <layer nodetype="paintlayer" name="Background" filename="layer1" x="0" y="0" opacity="255" visible="1" compositeop="normal" colorspacename="RGBA"/>
  </layers>
 </IMAGE>
</DOC>
`,
    ],
    [
      'documentinfo.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
<document-info xmlns="http://www.calligra.org/DTD/document-info">
 <about><title>Layers</title><creation-date>2026-01-01T00:00:00</creation-date></about>
 <author><full-name>Example</full-name></author>
</document-info>
`,
    ],
    ['mergedimage.png', png(W, H, merged)],
    ['preview.png', png(256, 160, scale(merged, W, H, 256, 160))],
  ]),
);

// ---- Photoshop -----------------------------------------------------------------------------------------------

{
  const { writePsdBuffer } = await import('ag-psd');
  const imageData = (rgba) => ({ width: W, height: H, data: new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length) });
  write(
    'images/layers.psd',
    writePsdBuffer(
      {
        width: W,
        height: H,
        imageData: imageData(merged),
        children: [
          { name: 'Background', left: 0, top: 0, imageData: imageData(background) },
          { name: 'Band', left: 0, top: 0, opacity: 1, imageData: imageData(stripe) },
        ],
      },
      { generateThumbnail: false },
    ),
  );
}

// ---- EPS with TIFF preview -----------------------------------------------------------------------------------

/** Uncompressed little-endian RGB TIFF. */
function tiff(w, h, rgba) {
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
    // White behind the translucent parts.
    const a = rgba[i + 3] / 255;
    for (let c = 0; c < 3; c++) rgb[j + c] = Math.round(rgba[i + c] * a + 255 * (1 - a));
  }
  const entries = [
    [256, 3, w],
    [257, 3, h],
    [258, 3, 8, 3],
    [259, 3, 1],
    [262, 3, 2],
    [273, 4, 0],
    [277, 3, 3],
    [278, 3, h],
    [279, 4, rgb.length],
  ];
  const ifdSize = 2 + entries.length * 12 + 4;
  const bitsAt = 8 + ifdSize;
  const dataAt = bitsAt + 6;
  const head = Buffer.alloc(dataAt);
  head.write('II', 0, 'latin1');
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(8, 4);
  head.writeUInt16LE(entries.length, 8);
  entries.forEach(([tag, type, value, count = 1], i) => {
    const p = 10 + i * 12;
    head.writeUInt16LE(tag, p);
    head.writeUInt16LE(type, p + 2);
    head.writeUInt32LE(count, p + 4);
    if (tag === 258) head.writeUInt32LE(bitsAt, p + 8);
    else if (tag === 273) head.writeUInt32LE(dataAt, p + 8);
    else if (type === 3) head.writeUInt16LE(value, p + 8);
    else head.writeUInt32LE(value, p + 8);
  });
  head.writeUInt16LE(8, bitsAt);
  head.writeUInt16LE(8, bitsAt + 2);
  head.writeUInt16LE(8, bitsAt + 4);
  return Buffer.concat([head, rgb]);
}

const postscript = `%!PS-Adobe-3.0 EPSF-3.0
%%Title: Drawing
%%Creator: Peekbean sample generator
%%CreationDate: 2026-01-01
%%BoundingBox: 0 0 240 150
%%LanguageLevel: 2
%%Pages: 1
%%EndComments
% Background gradient approximated by bands, a disk with a ring, a diagonal band.
0 1 29 { /i exch def 0.95 0.35 i 0.015 mul add 0.16 setrgbcolor 0 i 5 mul 240 5 rectfill } for
1 setgray 149 75 45 0 360 arc fill
0.11 0.12 0.14 setrgbcolor 3 setlinewidth 149 75 45 0 360 arc stroke
0.12 0.24 0.55 setrgbcolor newpath 0 150 moveto 24 150 lineto 240 15 lineto 240 -9 lineto closepath fill
showpage
%%EOF
`;
{
  const preview = tiff(240, 150, scale(merged, W, H, 240, 150));
  const ps = Buffer.from(postscript, 'latin1');
  const header = Buffer.alloc(30);
  header.set([0xc5, 0xd0, 0xd3, 0xc6]);
  header.writeUInt32LE(30, 4);
  header.writeUInt32LE(ps.length, 8);
  header.writeUInt32LE(30 + ps.length, 20);
  header.writeUInt32LE(preview.length, 24);
  // No header checksum: 0xFFFF.
  header.writeUInt16LE(0xffff, 28);
  write('images/drawing.eps', Buffer.concat([header, ps, preview]));
}

for (const [rel, size] of written) console.log(`${rel.padEnd(28)} ${size.toLocaleString('en-US')} bytes`);
