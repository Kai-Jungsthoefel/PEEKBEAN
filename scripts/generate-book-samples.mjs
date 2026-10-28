// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the samples of the RTF and e-book viewers: office/formatting.rtf, books/sample-book.epub and
// books/sample-book.fb2. Everything is written from scratch here without libraries (pictures included), so the output
// can be published as CC0-1.0 like the other samples. The book text is our own.
// Usage: node scripts/generate-book-samples.mjs [file ...] (file names relative to samples/; without, all are written).
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

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- Pictures -------------------------------------------------------------------------------------------------------

function png(w, h, pixel) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(pixel(x, y), y * (w * 3 + 1) + 1 + x * 3);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** A sunset over the sea: sky gradient, sun, water with stripes. */
function seascape(w, h) {
  return png(w, h, (x, y) => {
    const horizon = h * 0.62;
    const sun = Math.hypot(x - w * 0.68, y - h * 0.5) < h * 0.16;
    if (y < horizon) {
      if (sun) return [255, 214, 102];
      const t = y / horizon;
      return [Math.round(70 + 180 * t), Math.round(90 + 60 * t), Math.round(160 - 40 * t)];
    }
    const stripe = Math.floor((y - horizon) / 5) % 2 === 0;
    const glint = Math.abs(x - w * 0.68) < w * 0.08 * (1 - (y - horizon) / (h - horizon)) && stripe;
    return glint ? [250, 200, 110] : stripe ? [32, 82, 128] : [26, 66, 110];
  });
}

/** Cover: dark blue field, orange band, a stylized open book; title text comes from the HTML around it. */
function coverImage(w, h) {
  return png(w, h, (x, y) => {
    const band = y > h * 0.62 && y < h * 0.7;
    if (band) return [242, 154, 56];
    const cx = w / 2;
    const top = h * 0.25;
    const bottom = h * 0.5;
    const inBook = y > top && y < bottom && Math.abs(x - cx) < w * 0.3 && Math.abs(x - cx) > 3;
    if (inBook) {
      const page = (y - top) % 14 < 2 && Math.abs(x - cx) > 14 && Math.abs(x - cx) < w * 0.27;
      return page ? [190, 196, 205] : [246, 244, 238];
    }
    const t = y / h;
    return [Math.round(20 + 15 * t), Math.round(32 + 20 * t), Math.round(66 + 40 * t)];
  });
}

/** Windows metafile without the placeable header, as RTF stores it in \wmetafile8: a gear-like flange drawing. */
function wmfRecords() {
  const records = [];
  const rec = (fn, ...params) => {
    const body = Buffer.concat(params);
    records.push(Buffer.concat([u32(3 + body.length / 2), u16(fn), body]));
  };
  const rgb = (r, g, b) => u32(r | (g << 8) | (b << 16));
  rec(0x0103, u16(8)); // SetMapMode MM_ANISOTROPIC
  rec(0x020b, i16(0), i16(0)); // SetWindowOrg
  rec(0x020c, i16(600), i16(900)); // SetWindowExt (y, x)
  rec(0x02fa, u16(0), i16(4), i16(0), rgb(27, 30, 35)); // CreatePenIndirect → 0
  rec(0x02fc, u16(0), rgb(47, 127, 214), u16(0)); // CreateBrushIndirect → 1 (blue)
  rec(0x012d, u16(0));
  rec(0x012d, u16(1));
  rec(0x041b, i16(560), i16(860), i16(40), i16(40)); // Rectangle (bottom, right, top, left)
  rec(0x01f0, u16(1));
  rec(0x02fc, u16(0), rgb(242, 154, 56), u16(0)); // orange brush → 1
  rec(0x012d, u16(1));
  rec(0x0418, i16(500), i16(560), i16(100), i16(160)); // Ellipse
  rec(0x01f0, u16(1));
  rec(0x02fc, u16(0), rgb(255, 255, 255), u16(0)); // white brush → 1
  rec(0x012d, u16(1));
  rec(0x0418, i16(360), i16(420), i16(240), i16(300));
  rec(0x0325, u16(2), i16(600), i16(300), i16(820), i16(300)); // Polyline
  rec(0x0325, u16(2), i16(600), i16(380), i16(820), i16(380));
  const face = Buffer.alloc(32);
  face.write('Arial', 'latin1');
  rec(0x02fb, i16(-56), i16(0), i16(0), i16(0), i16(700), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), face); // CreateFontIndirect → 2
  rec(0x012d, u16(2));
  rec(0x0102, u16(1)); // SetBkMode transparent
  rec(0x0209, rgb(255, 255, 255)); // SetTextColor
  const text = Buffer.from('WMF', 'latin1');
  rec(0x0521, u16(text.length), Buffer.concat([text, Buffer.alloc(text.length % 2)]), i16(460), i16(640)); // TextOut (y, x)
  rec(0x0000);
  const body = Buffer.concat(records);
  const maxRecord = Math.max(...records.map((r) => r.readUInt32LE(0)));
  return Buffer.concat([u16(1), u16(9), u16(0x0300), u32(9 + body.length / 2), u16(3), u32(maxRecord), u16(0), body]);
}

// ---- RTF --------------------------------------------------------------------------------------------------------------

/** Text for RTF: ASCII as is, Windows-1252 letters as \'hh, everything else as \uN with a "?" fallback. */
function rtfText(s) {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (ch === '\\' || ch === '{' || ch === '}') out += `\\${ch}`;
    else if (code < 0x80) out += ch;
    else if (code <= 0xff) out += `\\'${code.toString(16).padStart(2, '0')}`;
    else if (code <= 0xffff) out += `\\u${code > 32767 ? code - 65536 : code}?`;
    else {
      const hi = 0xd800 + ((code - 0x10000) >> 10);
      const lo = 0xdc00 + ((code - 0x10000) & 0x3ff);
      out += `\\u${hi - 65536}?\\u${lo - 65536}?`;
    }
  }
  return out;
}

const hexLines = (bytes) => bytes.toString('hex').match(/.{1,128}/g).join('\n');

function rtfDocument() {
  const picture = seascape(240, 150);
  const wmf = wmfRecords();
  const P = '\\pard\\plain\\ql\\sa120\\f0\\fs22 ';
  const lines = [];
  const add = (...l) => lines.push(...l);

  add(
    '{\\rtf1\\ansi\\ansicpg1252\\deff0\\deftab720\\uc1',
    '{\\fonttbl{\\f0\\froman\\fcharset0 Times New Roman;}{\\f1\\fswiss\\fcharset0 Arial;}{\\f2\\fmodern\\fcharset0 Courier New;}' +
      '{\\f3\\ftech\\fcharset2 Symbol;}{\\f4\\fnil\\fcharset128 MS Mincho;}{\\f5\\fswiss\\fcharset161 Arial Greek;}}',
    '{\\colortbl;\\red0\\green0\\blue0;\\red192\\green32\\blue32;\\red32\\green96\\blue192;\\red32\\green128\\blue64;\\red255\\green255\\blue0;' +
      '\\red220\\green226\\blue234;\\red242\\green154\\blue56;\\red120\\green120\\blue120;}',
    '{\\stylesheet{\\ql\\f0\\fs22 Normal;}{\\s1\\ql\\sb240\\sa120\\outlinelevel0\\b\\f1\\fs36 heading 1;}{\\s2\\ql\\sb200\\sa80\\outlinelevel1\\b\\f1\\fs28 heading 2;}}',
    '{\\*\\listtable' +
      '{\\list\\listtemplateid1{\\listlevel\\levelnfc23\\levelstartat1\\levelfollow0{\\leveltext\\\'01\\u-3913 ?;}{\\levelnumbers;}\\f3\\fi-360\\li720}' +
      '{\\listlevel\\levelnfc23\\levelstartat1\\levelfollow0{\\leveltext\\\'01o;}{\\levelnumbers;}\\f2\\fi-360\\li1440}\\listid100}' +
      '{\\list\\listtemplateid2{\\listlevel\\levelnfc0\\levelstartat1\\levelfollow0{\\leveltext\\\'02\\\'00.;}{\\levelnumbers\\\'01;}\\fi-360\\li720}' +
      '{\\listlevel\\levelnfc4\\levelstartat1\\levelfollow0{\\leveltext\\\'02\\\'01);}{\\levelnumbers\\\'01;}\\fi-360\\li1440}\\listid200}}',
    '{\\*\\listoverridetable{\\listoverride\\listid100\\listoverridecount0\\ls1}{\\listoverride\\listid200\\listoverridecount0\\ls2}}',
    '{\\info{\\title RTF formatting sample}{\\subject Test document for the RTF viewer}{\\author Peekbean sample generator}' +
      '{\\company Example}{\\keywords RTF, sample, formatting}{\\doccomm Generated by scripts/generate-book-samples.mjs, CC0-1.0.}' +
      '{\\creatim\\yr2026\\mo10\\dy27\\hr10\\min0}{\\revtim\\yr2026\\mo10\\dy27\\hr11\\min30}{\\nofpages2}{\\nofwords400}}',
    '\\paperw11906\\paperh16838\\margl1418\\margr1418\\margt1418\\margb1134',
    '{\\header\\pard\\plain\\qr\\f1\\fs16\\cf8 Peekbean sample \\endash  RTF formatting\\par}',
    '{\\footer\\pard\\plain\\qc\\f1\\fs16\\cf8 Generated sample, released as CC0-1.0 \\endash  page {\\field{\\*\\fldinst PAGE }{\\fldrslt 1}}\\par}',
  );

  // Headings and character formatting
  add(
    `\\pard\\plain\\s1\\ql\\sb240\\sa120\\outlinelevel0\\b\\f1\\fs36 ${rtfText('RTF formatting sample')}\\par`,
    `${P}This document tests the RTF reader: {\\b bold}, {\\i italic}, {\\ul underline}, {\\uldb double underline}, ` +
      '{\\ulwave wavy underline}, {\\strike strike-through}, {\\scaps Small Caps}, {\\caps all caps}, ' +
      'H{\\sub 2}O and E = mc{\\super 2}. ' +
      '{\\cf2 Red text}, {\\cf3 blue text}, {\\cf4\\b green bold}, {\\highlight5 highlighted} and {\\cb6 shaded}. ' +
      'Fonts: {\\f1 Arial}, {\\f2 Courier New}, sizes {\\fs16 8 pt}, {\\fs28 14 pt} and {\\fs40 20 pt}.\\par',
    `${P}${rtfText('Non-ASCII text: äöü ÄÖÜ ß, café, naïve, € 12.50 – “quotes” and ‘single quotes’.')}\\par`,
    `${P}${rtfText('Greek: Καλημέρα κόσμε — αβγδε ΑΒΓΔΕ.')}\\par`,
    `${P}${rtfText('CJK via \\u: 日本語のテキスト, 中文文本, 한국어 텍스트.')}\\par`,
    `${P}Shift-JIS bytes in a Japanese font: {\\f4 \\'93\\'fa\\'96\\'7b\\'8c\\'ea\\'82\\'cc\\'95\\'b6\\'8e\\'9a}.\\par`,
  );

  // Paragraph formatting
  add(
    `\\pard\\plain\\s2\\ql\\sb200\\sa80\\outlinelevel1\\b\\f1\\fs28 Paragraph formatting\\par`,
    '\\pard\\plain\\qc\\sa120\\f0\\fs22 This paragraph is centered.\\par',
    '\\pard\\plain\\qr\\sa120\\f0\\fs22 This paragraph is aligned right.\\par',
    '\\pard\\plain\\qj\\sa120\\sl360\\slmult1\\f0\\fs22 This paragraph is justified and has one and a half line spacing. ' +
      'It is long enough to wrap over a few lines, so the spacing between the lines and the straight right edge can be seen. ' +
      'Rich Text Format was published in 1987 and is still read by almost every word processor.\\par',
    '\\pard\\plain\\ql\\li720\\ri720\\sa120\\f0\\fs22 This paragraph is indented by half an inch on both sides.\\par',
    '\\pard\\plain\\ql\\fi-720\\li720\\sa120\\f0\\fs22 Hanging indent:\\tab the first line starts at the margin, ' +
      'the following lines start half an inch further in, as in a glossary.\\par',
    '\\pard\\plain\\ql\\sa120\\brdrb\\brdrs\\brdrw10\\brdrcf7\\cbpat6\\f0\\fs22 A paragraph with shading and an orange bottom border.\\par',
    `${P}A line break follows here\\line and the paragraph goes on in the next line.\\par`,
    '\\pard\\plain\\ql\\sa60\\tqr\\tldot\\tx9000\\f0\\fs22 Chapter 1: Introduction\\tab 3\\par',
    '\\pard\\plain\\ql\\sa120\\tqr\\tldot\\tx9000\\f0\\fs22 Chapter 2: Tables and pictures\\tab 12\\par',
    '\\pard\\plain\\ql\\sa120\\tx2000\\tqc\\tx5000\\tqr\\tx8000\\f2\\fs20 left\\tab at 2000\\tab centered\\tab right\\par',
  );

  // Lists: bullets with \listtext as Word writes them, numbers only through the list table.
  add(`\\pard\\plain\\s2\\ql\\sb200\\sa80\\outlinelevel1\\b\\f1\\fs28 Lists\\par`);
  for (const [level, text] of [[0, 'First bullet point'], [0, 'Second bullet point'], [1, 'A nested point with a hollow bullet'], [0, 'Third bullet point']]) {
    const indent = level ? '\\fi-360\\li1440' : '\\fi-360\\li720';
    const mark = level ? '{\\listtext\\pard\\plain\\f2\\fs22 o\\tab}' : "{\\listtext\\pard\\plain\\f3\\fs22 \\'b7\\tab}";
    add(`${mark}\\pard\\plain\\ql${indent}\\sa60\\ls1\\ilvl${level}\\f0\\fs22 ${text}\\par`);
  }
  for (const [level, text] of [[0, 'Numbered item one'], [0, 'Numbered item two'], [1, 'Sub-item a'], [1, 'Sub-item b'], [0, 'Numbered item three']]) {
    const indent = level ? '\\fi-360\\li1440' : '\\fi-360\\li720';
    add(`\\pard\\plain\\ql${indent}\\sa60\\ls2\\ilvl${level}\\f0\\fs22 ${text}\\par`);
  }

  // Table: shaded header row, a cell spanning two columns, a cell spanning two rows.
  add(`\\pard\\plain\\s2\\ql\\sb200\\sa80\\outlinelevel1\\b\\f1\\fs28 Table\\par`);
  const border = '\\clbrdrt\\brdrs\\brdrw10\\clbrdrl\\brdrs\\brdrw10\\clbrdrb\\brdrs\\brdrw10\\clbrdrr\\brdrs\\brdrw10';
  const row = (cells, defs, opts = '') => {
    add(`\\trowd\\trgaph108\\trleft0${opts}${defs}`);
    add(cells.map((c) => `\\pard\\plain\\intbl\\ql\\f0\\fs20 ${c}\\cell`).join(''));
    add('\\row');
  };
  row(['{\\b Part}', '{\\b Material}', '{\\b Weight}'], `${border}\\clcbpat6\\cellx3000${border}\\clcbpat6\\cellx6000${border}\\clcbpat6\\cellx9000`, '\\trhdr');
  row(['Flange DN 100', 'Steel S235', '4.2 kg'], `${border}\\cellx3000${border}\\cellx6000${border}\\cellx9000`);
  row(['Gasket (spans two rows)', 'EPDM', '0.1 kg'], `${border}\\clvmgf\\clvertalc\\cellx3000${border}\\cellx6000${border}\\cellx9000`);
  row(['', 'NBR (alternative)', '0.1 kg'], `${border}\\clvmrg\\cellx3000${border}\\cellx6000${border}\\cellx9000`);
  row(['{\\i A note that spans the first two columns}', '{\\b 4.4 kg}'], `${border}\\cellx6000${border}\\clcbpat5\\cellx9000`);
  add(`${P}\\par`);

  // Links, a bookmark, a footnote
  add(
    `\\pard\\plain\\s2\\ql\\sb200\\sa80\\outlinelevel1\\b\\f1\\fs28 Links and notes\\par`,
    `${P}A web link: {\\field{\\*\\fldinst HYPERLINK "https://example.com/" }{\\fldrslt {\\ul\\cf3 example.com}}}. ` +
      'A link to {\\field{\\*\\fldinst HYPERLINK \\\\l "pictures" }{\\fldrslt {\\ul\\cf3 the pictures below}}} inside the document. ' +
      'This sentence has a footnote.{\\super\\chftn}{\\footnote\\pard\\plain\\ql\\f0\\fs18 {\\super\\chftn} ' +
      'Footnotes are collected at the end of the document, with a link back to the text.}\\par',
  );

  // Pictures
  add(
    `\\pard\\plain\\s2\\ql\\sb200\\sa80\\outlinelevel1\\b\\f1\\fs28 {\\*\\bkmkstart pictures}Pictures{\\*\\bkmkend pictures}\\par`,
    `${P}A PNG picture (\\\\pngblip) and a Windows metafile (\\\\wmetafile8) drawn by the viewer:\\par`,
    `\\pard\\plain\\qc\\sa120\\f0\\fs22 {\\*\\shppict{\\pict\\pngblip\\picw240\\pich150\\picwgoal3600\\pichgoal2250\n${hexLines(picture)}\n}}` +
      `{\\nonshppict{\\pict\\wmetafile8\\picw100\\pich100 00}}\\tab ` +
      `{\\pict\\wmetafile8\\picw15875\\pich10583\\picwgoal3000\\pichgoal2000\n${hexLines(wmf)}\n}\\par`,
  );

  // Second page
  add(
    '\\pard\\plain\\ql\\f0\\fs22\\page',
    `\\pard\\plain\\s1\\ql\\sb240\\sa120\\outlinelevel0\\b\\f1\\fs36 Second page\\par`,
    `${P}A page break (\\\\page) starts a new sheet. The page is A4 with 2.5 cm margins, read from \\\\paperw and \\\\margl.\\par`,
    `${P}{\\b Symbol font:} {\\f3 a b g d p S W} ({\\f3 \\'b7} as bullet), and a mark in Wingdings-free Unicode: \\u10003? done.\\par`,
    '}',
  );
  return Buffer.from(lines.join('\n'), 'latin1');
}

write('office/formatting.rtf', rtfDocument());

// ---- E-book text (our own, CC0) ---------------------------------------------------------------------------------------

const BOOK = {
  title: 'The Lighthouse Keeper’s Notebook',
  author: 'Peekbean sample generator',
  publisher: 'Example',
  uuid: '6f1c2a54-3d8e-4b7a-9c21-5e0d4f8a7b13',
  date: '2026-10-27',
  description: 'Three short chapters about an island light, written as a sample for the Peekbean e-book reader.',
};

const LOG = [
  ['Monday', 'Fog until noon, then clear', 'SW 3', '2'],
  ['Tuesday', 'Rain', 'W 5', '0'],
  ['Wednesday', 'Clear and cold', 'NW 4', '5'],
  ['Thursday', 'Squalls, supply boat turned back', 'NW 7', '1'],
  ['Friday', 'Overcast', 'N 4', '3'],
  ['Saturday', 'Clear, a halo round the moon', 'NE 2', '4'],
  ['Sunday', 'Calm; the sea like oil', 'variable', '6'],
];

/** XHTML bodies of the three chapters; links between them use the EPUB file names. */
const CHAPTERS = [
  {
    file: 'chapter-1.xhtml',
    title: 'Chapter 1. The Island',
    body: `<section epub:type="chapter" id="island">
<h1>Chapter 1. The Island</h1>
<p>The island is a long back of granite, three hundred paces from end to end, with the lighthouse at its northern tip. Nothing grows taller than a sea pink, and the wind never quite stops; on calm days it merely lowers its voice.</p>
<p>My predecessor left me a notebook, a kettle and one piece of advice: <em>count the ships, not the days</em>. I have tried to follow it, with <strong>mixed</strong> success.</p>
<h2 id="arrival">Arrival</h2>
<p>The supply boat comes every second Thursday when the sea allows, which is to say less often than that. It brings oil, flour, letters and news that is already old.<a epub:type="noteref" class="noteref" href="#fn1" id="fnref1">1</a></p>
<p>A record of the first week is kept in <a href="chapter-3.xhtml#log">the log at the end of this book</a>; the duties of an evening are listed in <a href="chapter-2.xhtml#duties">chapter 2</a>.</p>
<aside epub:type="footnote" id="fn1"><p><a href="#fnref1" title="Back to the text">1.</a> The oldest newspaper on the island describes a winter storm that the keeper of the time, by his own account, slept through.</p></aside>
</section>`,
  },
  {
    file: 'chapter-2.xhtml',
    title: 'Chapter 2. The Light',
    body: `<section epub:type="chapter" id="light">
<h1>Chapter 2. The Light</h1>
<p>The lamp burns from sunset to sunrise. Its lens is made of rings of glass that bend the light into one flat beam, and the beam turns once every twenty seconds. Sailors know the light by that rhythm: two flashes, a long pause, two flashes.</p>
<figure id="figure-1"><img src="../images/seascape.png" alt="The sun setting over the sea, its reflection on the water"/><figcaption>Figure 1. Evening, seen from the lantern room.</figcaption></figure>
<blockquote><p>A light that is not looked after is worse than no light at all, because ships trust it.</p></blockquote>
<h2 id="duties">Evening duties</h2>
<ol>
<li>Trim the wick and fill the oil.</li>
<li>Polish the lens until no breath shows on it.</li>
<li>Wind the clockwork that turns the lens.</li>
<li>Write the weather into the log.</li>
</ol>
<p><strong>Never</strong> let the clockwork run down: a light that stands still is a different light, and a ship that expects two flashes may read it as a warning.</p>
</section>`,
  },
  {
    file: 'chapter-3.xhtml',
    title: 'Chapter 3. The Log',
    body: `<section epub:type="chapter" id="logbook">
<h1>Chapter 3. The Log</h1>
<p>These are the first entries of my log, copied out fair. The count of ships is what my predecessor would have asked about first.</p>
<table id="log">
<caption>Table 1. The first week on the island</caption>
<thead><tr><th>Day</th><th>Weather</th><th>Wind</th><th>Ships seen</th></tr></thead>
<tbody>
${LOG.map((r) => `<tr>${r.map((c) => `<td>${escapeXml(c)}</td>`).join('')}</tr>`).join('\n')}
</tbody>
</table>
<p>Back to <a href="chapter-1.xhtml">the beginning</a>, or to <a href="chapter-2.xhtml#figure-1">the picture of the evening</a>. A link that leaves the book: <a href="https://example.com/">example.com</a>.</p>
<p lang="de">Ein Satz auf Deutsch: Der Leuchtturm steht auf der Nordspitze.</p>
</section>`,
  },
];

const BOOK_CSS = `/* Sample style sheet: plain black on white restates the defaults, so the reader may still show it dark. */
body { margin: 0 4%; color: black; background-color: white; }
h1 { font-size: 1.6em; font-weight: normal; text-align: center; letter-spacing: .04em; margin: 1.2em 0 1em; padding-bottom: .4em; border-bottom: 1px solid #b0a080; }
h2 { font-size: 1.15em; font-variant: small-caps; margin: 1.6em 0 .6em; }
p { text-indent: 1.5em; margin: 0 0 .3em; text-align: justify; }
h1 + p, h2 + p, figure + p, blockquote + p { text-indent: 0; }
figure { margin: 1.5em 0; text-align: center; }
figure img { width: 80%; }
figcaption { font-size: .85em; font-style: italic; margin-top: .4em; }
blockquote { margin: 1em 2em; font-style: italic; }
table { width: 100%; border-collapse: collapse; margin: 1em 0; font-size: .9em; }
caption { font-style: italic; margin-bottom: .4em; }
th, td { text-align: left; padding: .3em .5em; border-bottom: 1px solid #b0a080; }
th { border-bottom-width: 2px; }
.noteref { vertical-align: super; font-size: .7em; line-height: 0; text-decoration: none; }
aside { margin-top: 2em; padding-top: .5em; border-top: 1px solid #b0a080; font-size: .85em; }
aside p { text-indent: 0; }
`;

const xhtml = (title, body, extra = '') => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head>
<meta charset="UTF-8"/>
<title>${escapeXml(title)}</title>
<link rel="stylesheet" type="text/css" href="../styles/book.css"/>${extra}
</head>
<body>
${body}
</body>
</html>
`;

// ---- ZIP and EPUB -----------------------------------------------------------------------------------------------------

/** ZIP with fixed time stamps (2026-10-27), deflated unless `store` is set; names in UTF-8. */
function zip(entries) {
  const time = 0;
  const date = ((2026 - 1980) << 9) | (10 << 5) | 27;
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data, store } of entries) {
    const raw = Buffer.from(data);
    const packed = store ? raw : deflateRawSync(raw, { level: 9 });
    const method = store ? 0 : 8;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(raw);
    const local = Buffer.concat([u32(0x04034b50), u16(20), u16(0x0800), u16(method), u16(time), u16(date), u32(crc), u32(packed.length), u32(raw.length), u16(nameBytes.length), u16(0), nameBytes, packed]);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(method), u16(time), u16(date), u32(crc), u32(packed.length), u32(raw.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
}

function epub() {
  const cover = coverImage(600, 900);
  const seascapePng = seascape(480, 300);
  const toc = [
    { file: 'chapter-1.xhtml', label: 'Chapter 1. The Island', children: [{ file: 'chapter-1.xhtml#arrival', label: 'Arrival' }] },
    { file: 'chapter-2.xhtml', label: 'Chapter 2. The Light', children: [{ file: 'chapter-2.xhtml#duties', label: 'Evening duties' }] },
    { file: 'chapter-3.xhtml', label: 'Chapter 3. The Log', children: [{ file: 'chapter-3.xhtml#log', label: 'The first week' }] },
  ];
  const navList = (items) => `<ol>\n${items.map((i) => `<li><a href="text/${i.file}">${escapeXml(i.label)}</a>${i.children ? navList(i.children) : ''}</li>`).join('\n')}\n</ol>`;
  let order = 0;
  const navPoints = (items) =>
    items.map((i) => `<navPoint id="nav-${++order}" playOrder="${order}"><navLabel><text>${escapeXml(i.label)}</text></navLabel><content src="text/${i.file}"/>${i.children ? navPoints(i.children) : ''}</navPoint>`).join('\n');

  const nav = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en" xml:lang="en">
<head><meta charset="UTF-8"/><title>Contents</title></head>
<body>
<nav epub:type="toc" id="toc"><h1>Contents</h1>
${navList(toc)}
</nav>
<nav epub:type="landmarks" hidden="hidden"><ol>
<li><a epub:type="cover" href="text/cover.xhtml">Cover</a></li>
<li><a epub:type="bodymatter" href="text/chapter-1.xhtml">Begin reading</a></li>
</ol></nav>
</body>
</html>
`;
  const ncx = `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1" xml:lang="en">
<head><meta name="dtb:uid" content="urn:uuid:${BOOK.uuid}"/><meta name="dtb:depth" content="2"/><meta name="dtb:totalPageCount" content="0"/><meta name="dtb:maxPageNumber" content="0"/></head>
<docTitle><text>${escapeXml(BOOK.title)}</text></docTitle>
<navMap>
${navPoints(toc)}
</navMap>
</ncx>
`;
  const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="en">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="book-id">urn:uuid:${BOOK.uuid}</dc:identifier>
<dc:title>${escapeXml(BOOK.title)}</dc:title>
<dc:creator id="creator">${escapeXml(BOOK.author)}</dc:creator>
<dc:language>en</dc:language>
<dc:publisher>${escapeXml(BOOK.publisher)}</dc:publisher>
<dc:date>${BOOK.date}</dc:date>
<dc:subject>Sample</dc:subject>
<dc:description>${escapeXml(BOOK.description)}</dc:description>
<dc:rights>CC0-1.0 (public domain)</dc:rights>
<meta property="dcterms:modified">${BOOK.date}T00:00:00Z</meta>
<meta name="cover" content="cover-image"/>
</metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="css" href="styles/book.css" media-type="text/css"/>
<item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
<item id="seascape" href="images/seascape.png" media-type="image/png"/>
<item id="cover" href="text/cover.xhtml" media-type="application/xhtml+xml" properties="svg"/>
${CHAPTERS.map((c, i) => `<item id="chapter-${i + 1}" href="text/${c.file}" media-type="application/xhtml+xml"/>`).join('\n')}
</manifest>
<spine toc="ncx">
<itemref idref="cover" linear="no"/>
${CHAPTERS.map((_, i) => `<itemref idref="chapter-${i + 1}"/>`).join('\n')}
</spine>
</package>
`;
  const coverPage = xhtml(
    'Cover',
    `<div class="cover"><svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" version="1.1" width="100%" height="100%" viewBox="0 0 600 900" preserveAspectRatio="xMidYMid meet">
<image width="600" height="900" xlink:href="../images/cover.png"/>
<text x="300" y="150" text-anchor="middle" font-family="Georgia, serif" font-size="44" fill="#f6f4ee">The Lighthouse</text>
<text x="300" y="205" text-anchor="middle" font-family="Georgia, serif" font-size="44" fill="#f6f4ee">Keeper’s Notebook</text>
<text x="300" y="840" text-anchor="middle" font-family="Georgia, serif" font-size="24" fill="#f6f4ee">Peekbean sample</text>
</svg></div>`,
  );
  return zip([
    { name: 'mimetype', data: 'application/epub+zip', store: true },
    { name: 'META-INF/container.xml', data: '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">\n<rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>\n</container>\n' },
    { name: 'OEBPS/content.opf', data: opf },
    { name: 'OEBPS/nav.xhtml', data: nav },
    { name: 'OEBPS/toc.ncx', data: ncx },
    { name: 'OEBPS/styles/book.css', data: BOOK_CSS },
    { name: 'OEBPS/images/cover.png', data: cover, store: true },
    { name: 'OEBPS/images/seascape.png', data: seascapePng, store: true },
    { name: 'OEBPS/text/cover.xhtml', data: coverPage },
    ...CHAPTERS.map((c) => ({ name: `OEBPS/text/${c.file}`, data: xhtml(c.title, c.body) })),
  ]);
}

write('books/sample-book.epub', epub());

// ---- FictionBook 2 ----------------------------------------------------------------------------------------------------

function fb2() {
  const p = (text) => `<p>${text}</p>`;
  const sections = `
<section id="island">
<title><p>Chapter 1</p><p>The Island</p></title>
<epigraph><p>Count the ships, not the days.</p><text-author>The previous keeper</text-author></epigraph>
${p('The island is a long back of granite, three hundred paces from end to end, with the lighthouse at its northern tip. Nothing grows taller than a sea pink, and the wind never quite stops; on calm days it merely lowers its voice.')}
${p('My predecessor left me a notebook, a kettle and one piece of advice: <emphasis>count the ships, not the days</emphasis>. I have tried to follow it, with <strong>mixed</strong> success.')}
<section id="arrival"><title><p>Arrival</p></title>
${p('The supply boat comes every second Thursday when the sea allows, which is to say less often than that. It brings oil, flour, letters and news that is already old.<a l:href="#note1" type="note">[1]</a>')}
${p('The log of the first week is in <a l:href="#log">chapter 3</a>.')}
</section>
</section>
<section id="light">
<title><p>Chapter 2</p><p>The Light</p></title>
${p('The lamp burns from sunset to sunrise. The beam turns once every twenty seconds: two flashes, a long pause, two flashes.')}
<image l:href="#seascape.png"/>
<subtitle>A rhyme from the notebook</subtitle>
<poem><stanza><v>Two flashes, then the dark between,</v><v>a count that every pilot knows;</v><v>the lamp is trimmed, the glass is clean,</v><v>and round and round the bright beam goes.</v></stanza></poem>
<empty-line/>
${p('<strong>Never</strong> let the clockwork run down. H<sub>2</sub>O freezes in the cistern at 0 °C; the lens turns at 3 <sup>rpm</sup>.')}
</section>
<section id="logbook">
<title><p>Chapter 3</p><p>The Log</p></title>
${p('These are the first entries of my log, copied out fair.')}
<table id="log">
<tr><th>Day</th><th>Weather</th><th>Wind</th><th>Ships seen</th></tr>
${LOG.map((r) => `<tr>${r.map((c) => `<td>${escapeXml(c)}</td>`).join('')}</tr>`).join('\n')}
</table>
${p('Back to <a l:href="#island">the beginning</a>. Non-ASCII text: Grüße, Καλημέρα, 灯台.')}
</section>`;
  const base64 = (buf) => buf.toString('base64').match(/.{1,76}/g).join('\n');
  return Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<FictionBook xmlns="http://www.gribuser.ru/xml/fictionbook/2.0" xmlns:l="http://www.w3.org/1999/xlink">
<description>
<title-info>
<genre>adventure</genre>
<author><nickname>${escapeXml(BOOK.author)}</nickname></author>
<book-title>${escapeXml(BOOK.title)}</book-title>
<annotation><p>${escapeXml(BOOK.description)}</p></annotation>
<keywords>sample, lighthouse</keywords>
<date value="${BOOK.date}">2026</date>
<coverpage><image l:href="#cover.png"/></coverpage>
<lang>en</lang>
<sequence name="Peekbean samples" number="1"/>
</title-info>
<document-info>
<author><nickname>${escapeXml(BOOK.author)}</nickname></author>
<program-used>scripts/generate-book-samples.mjs</program-used>
<date value="${BOOK.date}">2026-10-27</date>
<id>${BOOK.uuid}</id>
<version>1.0</version>
</document-info>
<publish-info><publisher>${escapeXml(BOOK.publisher)}</publisher><year>2026</year></publish-info>
</description>
<body>
<title><p>${escapeXml(BOOK.title)}</p></title>
${sections}
</body>
<body name="notes">
<title><p>Notes</p></title>
<section id="note1"><title><p>1</p></title><p>The oldest newspaper on the island describes a winter storm that the keeper of the time, by his own account, slept through.</p></section>
</body>
<binary id="cover.png" content-type="image/png">${base64(coverImage(300, 450))}</binary>
<binary id="seascape.png" content-type="image/png">${base64(seascape(480, 300))}</binary>
</FictionBook>
`, 'utf8');
}

write('books/sample-book.fb2', fb2());

// ---- Report ----------------------------------------------------------------------------------------------------------

for (const [rel, size] of written) console.log(`${rel.padEnd(32)} ${size.toLocaleString('en-US').padStart(9)} bytes`);
