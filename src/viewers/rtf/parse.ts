// SPDX-License-Identifier: GPL-3.0-or-later
// RTF reader written for this project: a tokenizer and a small formatting model that turn the file into HTML
// paragraphs, tables, lists, links, footnotes and pictures. Code pages (also Shift-JIS, GBK, Big5) are decoded by the
// browser's TextDecoder. Unknown \* destinations are skipped, as the specification asks.
import { h } from '../../core/dom';

/** CSS pixels per twip (1/1440 inch) at 96 dpi. */
const PX = 1 / 15;

export interface RtfInfo {
  title?: string;
  subject?: string;
  author?: string;
  operator?: string;
  manager?: string;
  company?: string;
  category?: string;
  keywords?: string;
  comment?: string;
  generator?: string;
  created?: Date;
  revised?: Date;
  printed?: Date;
  pages?: number;
  words?: number;
  characters?: number;
  version?: number;
  codepage?: number;
}

export interface RtfDocument {
  /** Sheets of paper; a new one starts at every explicit page or section break. */
  sheets: HTMLElement[];
  /** Paper width in CSS pixels. */
  width: number;
  info: RtfInfo;
  words: number;
  /** Puts tab stops into place; call once the sheets are in the page, at 100 % zoom. */
  layoutTabs(): void;
  /** Draws Windows metafile pictures (EMF, WMF) into PNGs. */
  drawPictures(): Promise<void>;
  destroy(): void;
}

// ---- Code pages and symbol fonts ------------------------------------------------------------------------------------

const CHARSET_CP: Record<number, number> = {
  0: 1252, 2: 42, 77: 10000, 128: 932, 129: 949, 130: 1361, 134: 936, 136: 950, 161: 1253, 162: 1254, 163: 1258,
  177: 1255, 178: 1256, 186: 1257, 204: 1251, 222: 874, 238: 1250, 254: 437, 255: 850,
};
const SYMBOL_CP = 42;
const DBCS = new Set([932, 936, 949, 950, 1361, 54936]);

function decoderLabel(cp: number): string {
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  if (cp >= 28591 && cp <= 28606) return `iso-8859-${cp - 28590}`;
  const named: Record<number, string> = {
    874: 'windows-874', 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 1361: 'euc-kr', 10000: 'macintosh',
    866: 'ibm866', 20866: 'koi8-r', 21866: 'koi8-u', 20932: 'euc-jp', 51932: 'euc-jp', 54936: 'gb18030', 65001: 'utf-8',
  };
  // DOS code pages 437 and 850 have no decoder in browsers; their letters mostly match Windows-1252.
  return named[cp] ?? 'windows-1252';
}

const decoders = new Map<number, TextDecoder>();
function decoder(cp: number): TextDecoder {
  let d = decoders.get(cp);
  if (!d) decoders.set(cp, (d = new TextDecoder(decoderLabel(cp))));
  return d;
}

// The Symbol font maps its own glyphs onto byte values; these are the Unicode characters it shows.
const SYMBOL_LOW = ' !∀#∃%&∋()∗+,−./0123456789:;<=>?≅ΑΒΧΔΕΦΓΗΙϑΚΛΜΝΟΠΘΡΣΤΥςΩΞΨΖ[∴]⊥_‾αβχδεφγηιϕκλμνοπθρστυϖωξψζ{|}∼';
const SYMBOL_HIGH = '€ϒ′≤⁄∞ƒ♣♦♥♠↔←↑→↓°±″≥×∝∂•÷≠≡≈…⏐⎯↵ℵℑℜ℘⊗⊕∅∩∪⊃⊇⊄⊂⊆∈∉∠∇®©™∏√⋅¬∧∨⇔⇐⇑⇒⇓◊〈®©™∑⎛⎜⎝⎡⎢⎣⎧⎨⎩⎪ 〉∫⌠⎮⌡⎞⎟⎠⎤⎥⎦⎫⎬⎭';
// Wingdings: the characters lists and check boxes use; anything else becomes a bullet.
const WINGDINGS: Record<number, string> = {
  0x28: '☎', 0x2a: '✉', 0x46: '☞', 0x4a: '☺', 0x4c: '☹', 0x6c: '●', 0x6e: '■', 0x6f: '□', 0x71: '❑', 0x72: '❒',
  0x73: '⬧', 0x74: '⧫', 0x75: '◆', 0x76: '❖', 0x77: '⬥', 0x9f: '•', 0xa1: '○', 0xa7: '▪', 0xa8: '◻', 0xd8: '➢',
  0xe8: '➔', 0xf0: '⇨', 0xfb: '✗', 0xfc: '✓', 0xfd: '☒', 0xfe: '☑',
};

type SymbolFont = '' | 'symbol' | 'wingdings';

function symbolChar(code: number, font: SymbolFont): string {
  if (font === 'wingdings') return WINGDINGS[code] ?? '•';
  if (code >= 0x20 && code <= 0x7e) return SYMBOL_LOW[code - 0x20];
  if (code >= 0xa0 && code <= 0xfe) return SYMBOL_HIGH[code - 0xa0];
  return String.fromCharCode(code);
}

/** Private-use characters U+F020–U+F0FF are symbol-font glyphs addressed through Unicode. */
function mapSymbols(text: string, font: SymbolFont): string {
  return text.replace(/[\uf020-\uf0ff]/g, (c) => symbolChar(c.charCodeAt(0) - 0xf000, font || 'symbol'));
}

// ---- Model -----------------------------------------------------------------------------------------------------------

type Dest =
  | 'body' | 'skip' | 'fonttbl' | 'colortbl' | 'stylesheet' | 'info' | 'infotext' | 'infodate' | 'pict' | 'fldinst'
  | 'listtable' | 'leveltext' | 'override' | 'shape' | 'sn' | 'sv' | 'pn' | 'pntxt' | 'upr';

interface Font {
  name: string;
  generic: string;
  cp: number;
  symbol: SymbolFont;
}

interface Char {
  font: number;
  /** Associated font for double-byte text (\dbch\af). */
  afont: number;
  dbch: boolean;
  /** Half points. */
  size: number;
  bold: boolean;
  italic: boolean;
  underline: string;
  ulColor: number;
  strike: number;
  vert: string;
  /** Raised or lowered by half points. */
  up: number;
  color: number;
  bg: number;
  highlight: number;
  caps: boolean;
  scaps: boolean;
  hidden: boolean;
  spacing: number;
}

interface Border {
  style: string;
  width: number;
  color: number;
}
type Side = 'top' | 'right' | 'bottom' | 'left';
type Borders = Partial<Record<Side, Border>>;

interface TabStop {
  pos: number;
  kind: string;
  leader: string;
}

/** Old-style (Word 6) paragraph numbering, {\*\pn …}. */
interface Pn {
  kind: string;
  nfc: number;
  start: number;
  before: string;
  after: string;
  font: number;
}

interface Para {
  align: string;
  li: number;
  ri: number;
  fi: number;
  sb: number;
  sa: number;
  sl: number;
  slmult: boolean;
  intbl: boolean;
  itap: number;
  style: number;
  outline: number;
  rtl: boolean;
  tabs: TabStop[];
  tabKind: string;
  tabLeader: string;
  borders: Borders | null;
  bg: number;
  ls: number;
  ilvl: number;
  pagebb: boolean;
  pn: Pn | null;
}

interface Link {
  href: string;
  title: string;
}

interface Field {
  inst: string;
  link: Link | null;
  result: boolean;
}

interface Pict {
  kind: string;
  w: number;
  h: number;
  goalW: number;
  goalH: number;
  scaleX: number;
  scaleY: number;
  data: Bytes;
  nibble: number;
}

interface State {
  dest: Dest;
  char: Char;
  para: Para;
  uc: number;
  flow: Flow;
  link: Link | null;
  field: Field | null;
  pict: Pict | null;
  /** Shape property being read ({\sp{\sn name}{\sv value}}). */
  sp: { name: string } | null;
  shape: { picture: boolean } | null;
  /** Destination a {\*\ud} group inside {\upr} returns to. */
  resume: Dest;
  infoKey: keyof RtfInfo;
  date: number[] | null;
  pn: Pn | null;
  pnSide: 'before' | 'after';
  nestProps: boolean;
  /** Inside the result of a PAGE field: the number is filled in per sheet. */
  pageNum: boolean;
}

/** Paragraph content collected until \par, when the paragraph properties are final. */
interface Run {
  frag: DocumentFragment;
  text: Text | null;
  key: string;
  link: Link | null;
  linkEl: HTMLElement | null;
  tabs: HTMLElement[];
  listText: boolean;
}

interface Table {
  slot: HTMLElement;
  rows: { cells: HTMLElement[]; def: RowDef }[];
  cells: HTMLElement[];
  cell: HTMLElement;
}

interface Flow {
  kind: 'main' | 'header' | 'footer' | 'note';
  root: HTMLElement;
  run: Run | null;
  tables: Table[];
}

interface CellDef {
  right: number;
  merge: string;
  vmerge: string;
  borders: Borders;
  bg: number;
  pattern: number;
  shading: number;
  valign: string;
}

interface RowDef {
  left: number;
  gap: number;
  height: number;
  align: string;
  pad: Partial<Record<Side, number>>;
  borders: Partial<Record<Side | 'h' | 'v', Border>>;
  cells: CellDef[];
  rtl: boolean;
}

interface ListLevel {
  nfc: number;
  start: number;
  text: string;
  follow: number;
  font: number;
}

class Bytes {
  buf = new Uint8Array(256);
  length = 0;

  push(b: number): void {
    if (this.length === this.buf.length) this.grow(1);
    this.buf[this.length++] = b;
  }

  append(src: Uint8Array): void {
    if (this.length + src.length > this.buf.length) this.grow(src.length);
    this.buf.set(src, this.length);
    this.length += src.length;
  }

  private grow(extra: number): void {
    const next = new Uint8Array(Math.max(this.buf.length * 2, this.length + extra));
    next.set(this.buf.subarray(0, this.length));
    this.buf = next;
  }

  take(): Uint8Array {
    const out = this.buf.slice(0, this.length);
    this.length = 0;
    return out;
  }
}

const HEX = new Int8Array(256).fill(-1);
for (let i = 0; i < 10; i++) HEX[48 + i] = i;
for (let i = 0; i < 6; i++) HEX[65 + i] = HEX[97 + i] = 10 + i;

const defaultChar = (font: number): Char => ({
  font, afont: font, dbch: false, size: 24, bold: false, italic: false, underline: '', ulColor: 0, strike: 0, vert: '', up: 0,
  color: 0, bg: 0, highlight: 0, caps: false, scaps: false, hidden: false, spacing: 0,
});

const defaultPara = (): Para => ({
  align: '', li: 0, ri: 0, fi: 0, sb: 0, sa: 0, sl: 0, slmult: false, intbl: false, itap: 1, style: 0, outline: -1, rtl: false,
  tabs: [], tabKind: '', tabLeader: '', borders: null, bg: 0, ls: 0, ilvl: 0, pagebb: false, pn: null,
});

const newCellDef = (): CellDef => ({ right: 0, merge: '', vmerge: '', borders: {}, bg: 0, pattern: 0, shading: 0, valign: '' });
const newRowDef = (): RowDef => ({ left: 0, gap: -1, height: 0, align: '', pad: {}, borders: {}, cells: [], rtl: false });

const BORDER_STYLES: Record<string, string> = {
  brdrs: 'solid', brdrth: 'solid', brdrsh: 'solid', brdrhair: 'solid', brdrdb: 'double', brdrtriple: 'double', brdrdot: 'dotted',
  brdrdash: 'dashed', brdrdashsm: 'dashed', brdrdashd: 'dashed', brdrdashdd: 'dashed', brdrinset: 'inset', brdroutset: 'outset',
  brdrengrave: 'groove', brdremboss: 'ridge', brdrwavy: 'solid', brdrnone: 'none', brdrnil: 'none', brdrtbl: 'none',
};

const UNDERLINES: Record<string, string> = {
  ul: 'solid', ulw: 'solid', uld: 'dotted', uldash: 'dashed', uldashd: 'dashed', uldashdd: 'dashed', uldb: 'double',
  ulwave: 'wavy', ululdbwave: 'wavy', ulth: 'thick', ulthd: 'dotted', ulthdash: 'dashed', ulhwave: 'wavy', ulldash: 'dashed',
};

const SPECIAL_CHARS: Record<string, string> = {
  emdash: '—', endash: '–', emspace: '\u2003', enspace: '\u2002', qmspace: '\u2005', bullet: '•', lquote: '‘', rquote: '’',
  ldblquote: '“', rdblquote: '”', zwj: '\u200d', zwnj: '\u200c', zwbo: '\u200b', ltrmark: '\u200e', rtlmark: '\u200f',
};

// Destinations that hold no text for the reader. Unknown \* destinations are skipped as well.
const SKIPPED = new Set([
  'filetbl', 'revtbl', 'rsidtbl', 'xe', 'tc', 'tcn', 'nonshppict', 'nonesttables', 'objdata', 'datafield', 'template',
  'pgdsctbl', 'themedata', 'colorschememapping', 'datastore', 'latentstyles', 'xmlnstbl', 'mmathPr', 'atnid', 'atnauthor',
  'annotation', 'headerl', 'footerl', 'headerf', 'footerf', 'listname', 'levelnumbers', 'fchars', 'lchars', 'ftnsep', 'ftnsepc',
  'ftncn', 'aftnsep', 'aftnsepc', 'aftncn', 'private', 'do', 'falt', 'panose', 'fname', 'macpict', 'pmmetafile',
]);

const INFO_TEXT: Record<string, keyof RtfInfo> = {
  title: 'title', subject: 'subject', author: 'author', operator: 'operator', manager: 'manager', company: 'company',
  category: 'category', keywords: 'keywords', comment: 'comment', doccomm: 'comment',
};
const INFO_DATES: Record<string, keyof RtfInfo> = { creatim: 'created', revtim: 'revised', printim: 'printed' };

const ROMAN: [number, string][] = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];

function numberText(n: number, nfc: number): string {
  if (nfc === 1 || nfc === 2) {
    let out = '';
    for (const [value, digits] of ROMAN) for (; n >= value; n -= value) out += digits;
    return nfc === 1 ? out.toUpperCase() : out;
  }
  if (nfc === 3 || nfc === 4) {
    const letter = String.fromCharCode(96 + (((n - 1) % 26) + 1));
    const text = letter.repeat(Math.floor((n - 1) / 26) + 1);
    return nfc === 3 ? text.toUpperCase() : text;
  }
  if (nfc === 22) return String(n).padStart(2, '0');
  return String(n);
}

/** Safe link target from a HYPERLINK field: web, mail and phone links, or a bookmark in the document. */
function parseHyperlink(inst: string): Link | null {
  const match = /^\s*HYPERLINK\b(.*)$/is.exec(inst);
  if (!match) return null;
  const tokens = (match[1].match(/"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^"|"$/g, ''));
  let url = '';
  let anchor = '';
  let title = '';
  for (let k = 0; k < tokens.length; k++) {
    const flag = /^\\([a-z])$/i.exec(tokens[k])?.[1].toLowerCase();
    // \l (bookmark), \o (tooltip) and \t (target frame) take a value; \h, \m and \n do not.
    if (flag === 'l') anchor = tokens[++k] ?? '';
    else if (flag === 'o') title = tokens[++k] ?? '';
    else if (flag === 't') k++;
    else if (!flag && !url) url = tokens[k].replace(/\\\\/g, '\\');
  }
  if (anchor && !url) return { href: `#rtf-bm-${anchor}`, title };
  if (/^(https?:|mailto:|tel:)/i.test(url)) return { href: url, title: title || url };
  if (/^www\./i.test(url)) return { href: `https://${url}`, title: title || url };
  return url ? { href: '', title: url } : null;
}

function fontCss(font: Font): string {
  const name = font.name.replace(/["\\;{}<>]/g, '').trim().slice(0, 64);
  return name ? `"${name}", ${font.generic}` : font.generic;
}

function mix(fg: string, bg: string, amount: number): string {
  const parse = (c: string) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const a = parse(fg);
  const b = parse(bg);
  return `#${a.map((v, i) => Math.round(v * amount + b[i] * (1 - amount)).toString(16).padStart(2, '0')).join('')}`;
}

/** A DIB (BITMAPINFO followed by the pixels) becomes a BMP file by putting the 14-byte file header in front. */
function dibToBmp(dib: Uint8Array): Uint8Array | null {
  if (dib.length < 40) return null;
  const view = new DataView(dib.buffer, dib.byteOffset, dib.byteLength);
  const headerSize = view.getUint32(0, true);
  const bits = view.getUint16(14, true);
  const compression = headerSize >= 40 ? view.getUint32(16, true) : 0;
  const used = headerSize >= 40 ? view.getUint32(32, true) : 0;
  const palette = (used || (bits <= 8 ? 1 << bits : 0)) * 4 + (headerSize === 40 && compression === 3 ? 12 : 0);
  const out = new Uint8Array(14 + dib.length);
  const o = new DataView(out.buffer);
  out[0] = 0x42;
  out[1] = 0x4d;
  o.setUint32(2, out.length, true);
  o.setUint32(10, 14 + headerSize + palette, true);
  out.set(dib, 14);
  return out;
}

// ---- Parser ----------------------------------------------------------------------------------------------------------

class RtfParser {
  private state: State;
  private readonly stack: State[] = [];
  private readonly text = new Bytes();
  private skipCount = 0;
  private star = false;

  private readonly fonts = new Map<number, Font>();
  private readonly colors: (string | null)[] = [];
  private color = [-1, -1, -1];
  private readonly styles = new Map<number, { name: string; outline: number }>();
  private style: { id: number; name: string; outline: number } | null = null;
  private font: { id: number; name: string; generic: string; charset: number; cp: number } | null = null;
  private ansiCp = 1252;
  private deff = 0;
  private deftab = 720;

  private readonly lists = new Map<number, ListLevel[]>();
  private list: { id: number; levels: ListLevel[] } | null = null;
  private level: ListLevel | null = null;
  private readonly overrides = new Map<number, number>();
  private override: { list: number; ls: number } | null = null;
  private readonly counters = new Map<number, number[]>();
  private pnCount = 0;
  private pnActive = false;

  private rowDef: RowDef = newRowDef();
  private cellDef: CellDef = newCellDef();
  private readonly rowDefs = new Map<number, RowDef>();
  private border: Border | null = null;

  readonly info: RtfInfo = {};
  private readonly page = { width: 12240, height: 15840, left: 1800, right: 1800, top: 1440, bottom: 1440, header: 720, footer: 720 };
  private sectionSeen = false;
  private pendingBreak = false;

  readonly sheets: HTMLElement[] = [];
  private readonly main: Flow;
  private header: Flow | null = null;
  private footer: Flow | null = null;
  private readonly notes: HTMLElement[] = [];
  private noteCount = 0;
  private bodyStarted = false;

  readonly urls: string[] = [];
  readonly metafiles: { img: HTMLImageElement; data: Uint8Array; label: string }[] = [];
  readonly tabStops = new WeakMap<HTMLElement, { stops: TabStop[]; li: number; fi: number }>();
  readonly tabbed: HTMLElement[] = [];

  constructor(private readonly infoOnly = false) {
    this.main = { kind: 'main', root: this.newSheetBody(), run: null, tables: [] };
    this.state = {
      dest: 'body', char: defaultChar(0), para: defaultPara(), uc: 1, flow: this.main, link: null, field: null, pict: null,
      sp: null, shape: null, resume: 'body', infoKey: 'title', date: null, pn: null, pnSide: 'before', nestProps: false, pageNum: false,
    };
  }

  parse(data: Uint8Array): void {
    const n = data.length;
    let i = 0;
    while (i < n) {
      if (this.infoOnly && this.bodyStarted) return;
      const c = data[i];
      if (c === 0x7b) {
        this.flush();
        this.skipCount = 0;
        this.push();
        i++;
      } else if (c === 0x7d) {
        this.flush();
        this.skipCount = 0;
        this.pop();
        i++;
      } else if (c === 0x5c) {
        const d = data[i + 1];
        if ((d >= 0x61 && d <= 0x7a) || (d >= 0x41 && d <= 0x5a)) {
          let j = i + 1;
          while (j < n && j - i <= 32 && ((data[j] >= 0x61 && data[j] <= 0x7a) || (data[j] >= 0x41 && data[j] <= 0x5a))) j++;
          const word = String.fromCharCode(...data.subarray(i + 1, j));
          let param = 0;
          let hasParam = false;
          let k = j;
          if (data[k] === 0x2d && data[k + 1] >= 0x30 && data[k + 1] <= 0x39) k++;
          while (k < n && k - j < 11 && data[k] >= 0x30 && data[k] <= 0x39) k++;
          if (k > j && data[k - 1] >= 0x30 && data[k - 1] <= 0x39) {
            param = Number(String.fromCharCode(...data.subarray(j, k)));
            hasParam = true;
          }
          if (data[k] === 0x20) k++;
          i = k;
          if (word === 'bin') {
            this.flush();
            const end = Math.min(n, i + Math.max(0, param));
            if (this.skipCount > 0) this.skipCount--;
            else if (this.state.dest === 'pict' && this.state.pict) this.state.pict.data.append(data.subarray(i, end));
            i = end;
            continue;
          }
          if (this.skipCount > 0) {
            this.skipCount--;
            continue;
          }
          this.flush();
          this.word(word, param, hasParam);
        } else if (d === 0x27) {
          const hi = HEX[data[i + 2]];
          const lo = HEX[data[i + 3]];
          i += hi >= 0 && lo >= 0 ? 4 : 2;
          if (this.skipCount > 0) {
            this.skipCount--;
            continue;
          }
          if (hi < 0 || lo < 0) continue;
          if (this.state.dest === 'pict') this.state.pict?.data.push(hi * 16 + lo);
          else this.text.push(hi * 16 + lo);
        } else {
          i += 2;
          if (d === 0x0d || d === 0x0a) {
            this.flush();
            this.word('par', 0, false);
            continue;
          }
          if (this.skipCount > 0) {
            this.skipCount--;
            continue;
          }
          this.symbol(d);
        }
      } else {
        // Plain text up to the next control character.
        let j = i;
        while (j < n && data[j] !== 0x5c && data[j] !== 0x7b && data[j] !== 0x7d) j++;
        if (this.state.dest === 'pict' && this.state.pict) {
          const pict = this.state.pict;
          for (let k = i; k < j; k++) {
            const v = HEX[data[k]];
            if (v < 0) continue;
            if (pict.nibble < 0) pict.nibble = v;
            else {
              pict.data.push(pict.nibble * 16 + v);
              pict.nibble = -1;
            }
          }
        } else {
          for (let k = i; k < j; k++) {
            const b = data[k];
            if (b === 0x0d || b === 0x0a) continue;
            if (this.skipCount > 0) {
              this.skipCount--;
              continue;
            }
            if (b === 0x09) {
              this.flush();
              this.word('tab', 0, false);
            } else if (b !== 0) {
              this.text.push(b);
            }
          }
        }
        i = j;
      }
    }
    this.flush();
    while (this.stack.length) this.pop();
  }

  // ---- Groups ----

  private push(): void {
    const s = this.state;
    this.stack.push(s);
    this.state = { ...s, char: { ...s.char }, para: { ...s.para } };
    if (s.dest === 'upr') this.state.dest = 'skip';
  }

  private pop(): void {
    const done = this.state;
    const parent = this.stack.pop();
    if (!parent) return;
    if (done.pict && done.pict !== parent.pict) this.finishPicture(done);
    if (done.field && done.field !== parent.field) this.finishField(done);
    if (done.flow !== parent.flow) this.finishFlow(done.flow);
    if (done.dest === 'stylesheet' && parent.dest === 'stylesheet' && this.style) this.commitStyle();
    if (done.dest === 'fonttbl' && this.font && parent.dest === 'fonttbl') this.commitFont();
    if (done.date && done.date !== parent.date) {
      const [y, mo, d, hr, mi, se] = done.date;
      if (y > 0) this.info[done.infoKey as 'created'] = new Date(y, Math.max(0, mo - 1), d || 1, hr, mi, se);
    }
    this.state = parent;
  }

  // ---- Text ----

  private currentCp(): number {
    const c = this.state.char;
    const font = this.fonts.get(c.font);
    let cp = font?.cp ?? this.ansiCp;
    if (!DBCS.has(cp) && c.dbch) {
      const alt = this.fonts.get(c.afont)?.cp;
      if (alt && DBCS.has(alt)) cp = alt;
    }
    return cp;
  }

  private flush(): void {
    if (this.text.length === 0) return;
    const bytes = this.text.take();
    const dest = this.state.dest;
    if (dest === 'skip' || dest === 'pict') return;
    const content = dest === 'body' || dest === 'leveltext' || dest === 'pntxt';
    const cp = dest === 'fonttbl' ? (this.font?.cp ?? this.ansiCp) : content ? this.currentCp() : this.ansiCp;
    let text: string;
    if (cp === SYMBOL_CP && content) {
      const font = this.fonts.get(this.state.char.font)?.symbol || 'symbol';
      text = Array.from(bytes, (b) => symbolChar(b, font)).join('');
    } else {
      text = decoder(cp === SYMBOL_CP ? 1252 : cp).decode(bytes);
    }
    this.emit(text);
  }

  private emit(text: string): void {
    const s = this.state;
    switch (s.dest) {
      case 'body':
        if (s.char.hidden) return;
        this.addText(s.flow, mapSymbols(text, this.fonts.get(s.char.font)?.symbol ?? ''));
        return;
      case 'fonttbl':
        if (!this.font) return;
        for (const ch of text) {
          if (ch === ';') this.commitFont();
          else if (this.font) this.font.name += ch;
        }
        return;
      case 'colortbl':
        for (const ch of text) if (ch === ';') this.commitColor();
        return;
      case 'stylesheet':
        if (!this.style) return;
        for (const ch of text) {
          if (ch === ';') this.commitStyle();
          else if (this.style) this.style.name += ch;
        }
        return;
      case 'infotext': {
        const key = s.infoKey as 'title';
        this.info[key] = (this.info[key] ?? '') + text;
        return;
      }
      case 'fldinst':
        if (s.field) s.field.inst += text;
        return;
      case 'leveltext':
        if (this.level) this.level.text += text;
        return;
      case 'sn':
        if (s.sp) s.sp.name += text;
        return;
      case 'pntxt':
        if (s.pn) s.pn[s.pnSide] += text;
        return;
      default:
    }
  }

  private symbol(d: number): void {
    switch (d) {
      case 0x2a: // \*
        this.star = true;
        return;
      case 0x7e:
        this.flushText('\u00a0');
        return;
      case 0x2d:
        this.flushText('\u00ad');
        return;
      case 0x5f:
        this.flushText('\u2011');
        return;
      case 0x5c:
      case 0x7b:
      case 0x7d:
        this.text.push(d);
        return;
      case 0x09:
        this.word('tab', 0, false);
        return;
      default:
      // \| (formula) and \: (index subentry) have no visible text.
    }
  }

  private flushText(text: string): void {
    this.flush();
    this.emit(text);
  }

  // ---- Control words ----

  private word(word: string, param: number, hasParam: boolean): void {
    const s = this.state;
    const star = this.star;
    this.star = false;

    if (s.dest === 'skip') {
      // {\upr{ANSI text}{\*\ud{Unicode text}}}: only the Unicode version is read.
      const outer = this.stack[this.stack.length - 1];
      if (word === 'ud' && outer?.dest === 'upr') s.dest = outer.resume;
      return;
    }
    if (this.destination(word, star)) return;
    if (star) {
      s.dest = 'skip';
      return;
    }

    const c = s.char;
    const p = s.para;
    const on = !hasParam || param !== 0;
    switch (word) {
      // Document
      case 'ansi': this.ansiCp = 1252; return;
      case 'mac': this.ansiCp = 10000; return;
      case 'pc': this.ansiCp = 437; return;
      case 'pca': this.ansiCp = 850; return;
      case 'ansicpg': if (param > 0) this.ansiCp = param; this.info.codepage = param; return;
      case 'deff': this.deff = param; c.font = c.afont = param; return;
      case 'deftab': if (param > 0) this.deftab = param; return;
      case 'paperw': if (param > 0) this.page.width = param; return;
      case 'paperh': if (param > 0) this.page.height = param; return;
      case 'margl': this.page.left = param; return;
      case 'margr': this.page.right = param; return;
      case 'margt': this.page.top = param; return;
      case 'margb': this.page.bottom = param; return;
      case 'pgwsxn': if (!this.sectionSeen && param > 0) this.page.width = param; return;
      case 'pghsxn': if (!this.sectionSeen && param > 0) this.page.height = param; return;
      case 'marglsxn': if (!this.sectionSeen) this.page.left = param; return;
      case 'margrsxn': if (!this.sectionSeen) this.page.right = param; return;
      case 'margtsxn': if (!this.sectionSeen) this.page.top = param; return;
      case 'margbsxn': if (!this.sectionSeen) this.page.bottom = param; return;
      case 'headery': if (!this.sectionSeen) this.page.header = param; return;
      case 'footery': if (!this.sectionSeen) this.page.footer = param; return;
      case 'uc': s.uc = Math.max(0, param); return;
      case 'u': {
        const code = param < 0 ? param + 65536 : param;
        this.emit(String.fromCharCode(code));
        this.skipCount = s.uc;
        return;
      }

      // Info
      case 'yr': if (s.date) s.date[0] = param; return;
      case 'mo': if (s.date) s.date[1] = param; return;
      case 'dy': if (s.date) s.date[2] = param; return;
      case 'hr': if (s.date) s.date[3] = param; return;
      case 'min': if (s.date) s.date[4] = param; return;
      case 'sec': if (s.date) s.date[5] = param; return;
      case 'nofpages': this.info.pages = param; return;
      case 'nofwords': this.info.words = param; return;
      case 'nofchars': this.info.characters = param; return;
      case 'version': if (s.dest === 'info') this.info.version = param; return;

      // Font table, color table, style sheet
      case 'f':
        if (s.dest === 'fonttbl') {
          this.commitFont();
          this.font = { id: param, name: '', generic: 'serif', charset: -1, cp: this.ansiCp };
        }
        else if (s.dest === 'listtable' && this.level) this.level.font = param;
        c.font = param;
        if (!c.dbch) c.afont = param;
        return;
      case 'af': c.afont = param; return;
      case 'dbch': c.dbch = true; return;
      case 'loch': case 'hich': c.dbch = false; return;
      case 'froman': if (this.font) this.font.generic = 'serif'; return;
      case 'fswiss': if (this.font) this.font.generic = 'sans-serif'; return;
      case 'fmodern': if (this.font) this.font.generic = 'monospace'; return;
      case 'fscript': if (this.font) this.font.generic = 'cursive'; return;
      case 'fdecor': if (this.font) this.font.generic = 'fantasy'; return;
      case 'fnil': case 'ftech': case 'fbidi': if (this.font) this.font.generic = 'sans-serif'; return;
      case 'fcharset':
        if (this.font) {
          this.font.charset = param;
          this.font.cp = param === 1 ? this.ansiCp : (CHARSET_CP[param] ?? this.ansiCp);
        }
        return;
      case 'cpg': if (this.font && param > 0) this.font.cp = param; return;
      case 'red': this.color[0] = param; return;
      case 'green': this.color[1] = param; return;
      case 'blue': this.color[2] = param; return;
      case 's':
        if (s.dest === 'stylesheet') {
          this.commitStyle();
          this.style = { id: param, name: '', outline: -1 };
        }
        else p.style = param;
        return;
      case 'outlinelevel':
        if (s.dest === 'stylesheet' && this.style) this.style.outline = param;
        else p.outline = param;
        return;

      // Lists
      case 'list': if (s.dest === 'listtable') this.list = { id: 0, levels: [] }; return;
      case 'listlevel':
        if (this.list) {
          this.level = { nfc: 0, start: 1, text: '', follow: 0, font: -1 };
          this.list.levels.push(this.level);
        }
        return;
      case 'levelnfc': if (this.level) this.level.nfc = param; return;
      case 'levelstartat': if (this.level) this.level.start = param; return;
      case 'levelfollow': if (this.level) this.level.follow = param; return;
      case 'listid':
        if (s.dest === 'listtable' && this.list) {
          this.list.id = param;
          this.lists.set(param, this.list.levels);
        } else if (s.dest === 'override' && this.override) this.override.list = param;
        return;
      case 'listoverride': if (s.dest === 'override') this.override = { list: 0, ls: 0 }; return;
      case 'ls':
        if (s.dest === 'override' && this.override) {
          this.override.ls = param;
          this.overrides.set(param, this.override.list);
        } else p.ls = param;
        return;
      case 'ilvl': p.ilvl = param; return;
      case 'pnlvlblt': if (s.pn) s.pn.kind = 'bullet'; return;
      case 'pnlvlbody': if (s.pn) s.pn.kind = 'body'; return;
      case 'pnlvlcont': if (s.pn) s.pn.kind = 'cont'; return;
      case 'pndec': if (s.pn) s.pn.nfc = 0; return;
      case 'pnucrm': if (s.pn) s.pn.nfc = 1; return;
      case 'pnlcrm': if (s.pn) s.pn.nfc = 2; return;
      case 'pnucltr': if (s.pn) s.pn.nfc = 3; return;
      case 'pnlcltr': if (s.pn) s.pn.nfc = 4; return;
      case 'pnstart': if (s.pn) s.pn.start = param; return;
      case 'pnf': if (s.pn) s.pn.font = param; return;

      // Character formatting
      case 'plain': s.char = defaultChar(this.deff); return;
      case 'b': c.bold = on; return;
      case 'i': c.italic = on; return;
      case 'strike': c.strike = on ? 1 : 0; return;
      case 'striked': c.strike = on ? 2 : 0; return;
      case 'ulnone': c.underline = ''; return;
      case 'ulc': c.ulColor = param; return;
      case 'super': c.vert = 'super'; return;
      case 'sub': c.vert = 'sub'; return;
      case 'nosupersub': c.vert = ''; c.up = 0; return;
      case 'up': c.up = hasParam ? param : 6; return;
      case 'dn': c.up = -(hasParam ? param : 6); return;
      case 'fs': if (param > 0) c.size = param; return;
      case 'cf': c.color = param; return;
      case 'cb': case 'chcbpat': c.bg = param; return;
      case 'highlight': c.highlight = param; return;
      case 'caps': c.caps = on; return;
      case 'scaps': c.scaps = on; return;
      case 'v': case 'webhidden': case 'deleted': c.hidden = on; return;
      case 'expndtw': c.spacing = param; return;
      case 'expnd': c.spacing = param * 5; return;

      // Paragraph formatting
      case 'pard': s.para = defaultPara(); return;
      case 'ql': p.align = ''; return;
      case 'qr': p.align = 'right'; return;
      case 'qc': p.align = 'center'; return;
      case 'qj': case 'qd': p.align = 'justify'; return;
      case 'li': case 'lin': p.li = param; return;
      case 'ri': case 'rin': p.ri = param; return;
      case 'fi': p.fi = param; return;
      case 'sb': p.sb = param; return;
      case 'sa': p.sa = param; return;
      case 'sbauto': if (on && param) p.sb = 280; return;
      case 'saauto': if (on && param) p.sa = 280; return;
      case 'sl': p.sl = param; return;
      case 'slmult': p.slmult = param === 1; return;
      case 'intbl': p.intbl = true; return;
      case 'itap': p.itap = param; if (param > 0) p.intbl = true; else p.intbl = false; return;
      case 'rtlpar': p.rtl = true; return;
      case 'ltrpar': p.rtl = false; return;
      case 'pagebb': p.pagebb = on; return;
      case 'cbpat': p.bg = param; return;
      case 'tqr': p.tabKind = 'right'; return;
      case 'tqc': p.tabKind = 'center'; return;
      case 'tqdec': p.tabKind = 'decimal'; return;
      case 'tldot': p.tabLeader = 'dot'; return;
      case 'tlmdot': p.tabLeader = 'dot'; return;
      case 'tlhyph': p.tabLeader = 'hyphen'; return;
      case 'tlul': case 'tlth': p.tabLeader = 'line'; return;
      case 'tleq': p.tabLeader = 'equals'; return;
      case 'tx': case 'tb':
        p.tabs = [...p.tabs, { pos: param, kind: p.tabKind || 'left', leader: p.tabLeader }].sort((a, b) => a.pos - b.pos);
        p.tabKind = p.tabLeader = '';
        return;

      // Borders
      case 'brdrt': case 'brdrb': case 'brdrl': case 'brdrr': case 'box': {
        const border: Border = { style: 'solid', width: 10, color: 0 };
        const sides: Side[] = word === 'box' ? ['top', 'right', 'bottom', 'left'] : [({ brdrt: 'top', brdrb: 'bottom', brdrl: 'left', brdrr: 'right' } as const)[word]];
        p.borders = { ...p.borders };
        for (const side of sides) p.borders[side] = border;
        this.border = border;
        return;
      }
      case 'brdrw': if (this.border) this.border.width = param; return;
      case 'brdrcf': if (this.border) this.border.color = param; return;

      // Tables
      case 'trowd': {
        this.rowDef = newRowDef();
        this.cellDef = newCellDef();
        this.rowDefs.set(s.nestProps ? Math.max(2, p.itap) : 1, this.rowDef);
        return;
      }
      case 'trgaph': this.rowDef.gap = param; return;
      case 'trleft': this.rowDef.left = param; return;
      case 'trrh': this.rowDef.height = param; return;
      case 'trqc': this.rowDef.align = 'center'; return;
      case 'trqr': this.rowDef.align = 'right'; return;
      case 'rtlrow': this.rowDef.rtl = true; return;
      case 'trpaddl': this.rowDef.pad.left = param; return;
      case 'trpaddr': this.rowDef.pad.right = param; return;
      case 'trpaddt': this.rowDef.pad.top = param; return;
      case 'trpaddb': this.rowDef.pad.bottom = param; return;
      case 'trbrdrt': case 'trbrdrb': case 'trbrdrl': case 'trbrdrr': case 'trbrdrh': case 'trbrdrv': {
        const side = ({ trbrdrt: 'top', trbrdrb: 'bottom', trbrdrl: 'left', trbrdrr: 'right', trbrdrh: 'h', trbrdrv: 'v' } as const)[word];
        this.border = this.rowDef.borders[side] = { style: 'solid', width: 10, color: 0 };
        return;
      }
      case 'clbrdrt': case 'clbrdrb': case 'clbrdrl': case 'clbrdrr': {
        const side = ({ clbrdrt: 'top', clbrdrb: 'bottom', clbrdrl: 'left', clbrdrr: 'right' } as const)[word];
        this.border = this.cellDef.borders[side] = { style: 'solid', width: 10, color: 0 };
        return;
      }
      case 'clmgf': this.cellDef.merge = 'first'; return;
      case 'clmrg': this.cellDef.merge = 'merged'; return;
      case 'clvmgf': this.cellDef.vmerge = 'first'; return;
      case 'clvmrg': this.cellDef.vmerge = 'merged'; return;
      case 'clvertalt': this.cellDef.valign = 'top'; return;
      case 'clvertalc': this.cellDef.valign = 'middle'; return;
      case 'clvertalb': this.cellDef.valign = 'bottom'; return;
      case 'clcbpat': this.cellDef.bg = param; return;
      case 'clcfpat': this.cellDef.pattern = param; return;
      case 'clshdng': this.cellDef.shading = param; return;
      case 'cellx':
        this.cellDef.right = param;
        this.rowDef.cells.push(this.cellDef);
        this.cellDef = newCellDef();
        return;
      case 'cell': this.endCell(s.flow, 1); return;
      case 'nestcell': this.endCell(s.flow, Math.max(2, p.itap)); return;
      case 'row': this.endRow(s.flow, 1); return;
      case 'nestrow': this.endRow(s.flow, Math.max(2, p.itap)); return;

      // Sections
      case 'sect':
        if (s.flow.run) this.endParagraph(s.flow);
        if (s.flow === this.main) this.pendingBreak = true;
        this.sectionSeen = true;
        return;
      case 'sbknone': case 'sbkcol': this.pendingBreak = false; return;

      // Pictures
      case 'pngblip': if (s.pict) s.pict.kind = 'png'; return;
      case 'jpegblip': if (s.pict) s.pict.kind = 'jpeg'; return;
      case 'emfblip': if (s.pict) s.pict.kind = 'emf'; return;
      case 'wmetafile': if (s.pict) s.pict.kind = 'wmf'; return;
      case 'dibitmap': if (s.pict) s.pict.kind = 'dib'; return;
      case 'wbitmap': case 'macpict': case 'pmmetafile': if (s.pict) s.pict.kind = word; return;
      case 'picw': if (s.pict) s.pict.w = param; return;
      case 'pich': if (s.pict) s.pict.h = param; return;
      case 'picwgoal': if (s.pict) s.pict.goalW = param; return;
      case 'pichgoal': if (s.pict) s.pict.goalH = param; return;
      case 'picscalex': if (s.pict && param > 0) s.pict.scaleX = param; return;
      case 'picscaley': if (s.pict && param > 0) s.pict.scaleY = param; return;

      // Text
      case 'par': if (s.dest === 'body') this.endParagraph(s.flow); return;
      case 'line': case 'lbr': if (s.dest === 'body') this.addNode(s.flow, h('br')); return;
      case 'column': if (s.dest === 'body') this.addNode(s.flow, h('br')); return;
      case 'tab': if (s.dest === 'body' && !s.char.hidden) this.addTab(s.flow); return;
      case 'page': if (s.dest === 'body' && s.flow === this.main) this.pageBreak(); return;
      case 'chftn': if (s.dest === 'body') this.noteMark(); return;
      case 'chpgn':
        if (s.dest === 'body') {
          s.pageNum = true;
          this.addText(s.flow, '1');
          s.pageNum = false;
        }
        return;
      default:
    }
    if (word in BORDER_STYLES) {
      if (this.border) {
        this.border.style = BORDER_STYLES[word];
        if (word === 'brdrth') this.border.width = Math.max(this.border.width, 30);
      }
    } else if (word in UNDERLINES) {
      c.underline = on ? UNDERLINES[word] : '';
    } else if (word in SPECIAL_CHARS && s.dest === 'body') {
      this.emit(SPECIAL_CHARS[word]);
    }
  }

  /** Control words that start a destination; true when handled. */
  private destination(word: string, star: boolean): boolean {
    const s = this.state;
    switch (word) {
      case 'fonttbl': s.dest = 'fonttbl'; return true;
      case 'colortbl': s.dest = 'colortbl'; this.color = [-1, -1, -1]; return true;
      case 'stylesheet': s.dest = 'stylesheet'; return true;
      case 'info': s.dest = 'info'; return true;
      case 'generator': s.dest = 'infotext'; s.infoKey = 'generator'; return true;
      case 'listtable': s.dest = 'listtable'; return true;
      case 'listoverridetable': s.dest = 'override'; return true;
      case 'leveltext': s.dest = s.dest === 'listtable' ? 'leveltext' : 'skip'; return true;
      case 'upr': s.resume = s.dest; s.dest = 'upr'; return true;
      case 'pict':
        if (s.dest === 'body' || s.dest === 'sv') {
          s.dest = 'pict';
          s.pict = { kind: '', w: 0, h: 0, goalW: 0, goalH: 0, scaleX: 100, scaleY: 100, data: new Bytes(), nibble: -1 };
        } else {
          s.dest = 'skip';
        }
        return true;
      case 'field': s.field = { inst: '', link: null, result: false }; return true;
      case 'fldinst': s.dest = s.field ? 'fldinst' : 'skip'; return true;
      case 'fldrslt':
        if (s.field) {
          s.field.result = true;
          s.field.link = parseHyperlink(s.field.inst);
          if (s.field.link?.href) s.link = s.field.link;
          s.pageNum = /^\s*PAGE\b/i.test(s.field.inst);
        }
        return true;
      case 'bkmkstart':
        // The bookmark name is the group's text; the anchor goes in when the name is complete.
        s.dest = 'fldinst';
        s.field = { inst: '\u0001bookmark', link: null, result: false };
        return true;
      case 'shppict': case 'shp': case 'result': case 'object':
        if (word === 'shp') s.shape = { picture: false };
        return true;
      case 'shpinst': s.dest = 'shape'; return true;
      case 'shprslt': if (s.shape?.picture) s.dest = 'skip'; return true;
      case 'sp': if (s.dest === 'shape') s.sp = { name: '' }; return s.dest === 'shape';
      case 'sn': s.dest = s.dest === 'shape' && s.sp ? 'sn' : 'skip'; return true;
      case 'sv': s.dest = s.dest === 'shape' && s.sp?.name.trim() === 'pib' ? 'sv' : 'skip'; return true;
      case 'nesttableprops': s.nestProps = true; return true;
      case 'pn': {
        if (s.dest !== 'body') return false;
        // The numbering belongs to the paragraph around the {\*\pn} group.
        const pn: Pn = { kind: 'body', nfc: 0, start: 1, before: '', after: '', font: -1 };
        s.pn = pn;
        s.dest = 'pn';
        const outer = this.stack[this.stack.length - 1];
        if (outer) outer.para.pn = pn;
        return true;
      }
      case 'pntxtb': case 'pntxta':
        if (!s.pn) return false;
        s.dest = 'pntxt';
        s.pnSide = word === 'pntxtb' ? 'before' : 'after';
        return true;
      case 'listtext': case 'pntext':
        if (s.dest !== 'body') return false;
        this.run(s.flow).listText = true;
        return true;
      case 'header': case 'headerr': case 'footer': case 'footerr': {
        const isHeader = word.startsWith('header');
        if (this.infoOnly || (isHeader ? this.header : this.footer)) {
          s.dest = 'skip';
          return true;
        }
        const flow: Flow = { kind: isHeader ? 'header' : 'footer', root: h('div', { class: isHeader ? 'rtf-header' : 'rtf-footer' }), run: null, tables: [] };
        if (isHeader) this.header = flow;
        else this.footer = flow;
        s.flow = flow;
        s.dest = 'body';
        s.para = defaultPara();
        return true;
      }
      case 'footnote': {
        this.noteCount++;
        const root = h('div', { class: 'rtf-note', id: `rtf-fn-${this.noteCount}` });
        root.dataset.note = String(this.noteCount);
        this.notes.push(root);
        s.flow = { kind: 'note', root, run: null, tables: [] };
        s.dest = 'body';
        s.para = defaultPara();
        s.link = null;
        return true;
      }
      default:
    }
    if (word in INFO_TEXT && (s.dest === 'info' || star)) {
      s.dest = 'infotext';
      s.infoKey = INFO_TEXT[word];
      return true;
    }
    if (word in INFO_DATES && s.dest === 'info') {
      s.infoKey = INFO_DATES[word];
      s.date = [0, 0, 0, 0, 0, 0];
      return true;
    }
    if (SKIPPED.has(word)) {
      s.dest = 'skip';
      return true;
    }
    return false;
  }

  // ---- Tables of the header ----

  private commitFont(): void {
    const f = this.font;
    if (!f) return;
    this.font = null;
    const name = f.name.trim();
    const symbol: SymbolFont = f.charset === 2 || /^symbol$/i.test(name) ? 'symbol' : /^(wingdings|webdings)/i.test(name) ? 'wingdings' : '';
    this.fonts.set(f.id, { name, generic: f.generic, cp: symbol ? SYMBOL_CP : f.cp, symbol });
  }

  private commitColor(): void {
    const [r, g, b] = this.color;
    this.colors.push(r < 0 && g < 0 && b < 0 ? null : `#${[r, g, b].map((v) => Math.min(255, Math.max(0, v)).toString(16).padStart(2, '0')).join('')}`);
    this.color = [-1, -1, -1];
  }

  private commitStyle(): void {
    const st = this.style;
    if (!st) return;
    this.style = null;
    this.styles.set(st.id, { name: st.name.trim(), outline: st.outline });
  }

  // ---- Body ----

  private newSheetBody(): HTMLElement {
    const sheet = h('div', { class: 'rtf-sheet' });
    this.sheets.push(sheet);
    return sheet;
  }

  private run(flow: Flow): Run {
    if (flow === this.main) this.bodyStarted = true;
    if (!flow.run) flow.run = { frag: document.createDocumentFragment(), text: null, key: '', link: null, linkEl: null, tabs: [], listText: false };
    return flow.run;
  }

  private colorOf(index: number): string | null {
    return index > 0 || (index === 0 && this.colors[0]) ? (this.colors[index] ?? null) : null;
  }

  private charCss(c: Char): string {
    const css: string[] = [];
    const font = this.fonts.get(c.font);
    if (font && c.font !== this.deff && !font.symbol) css.push(`font-family:${fontCss(font)}`);
    const size = c.vert ? (c.size * 2) / 3 : c.size;
    if (size !== 24) css.push(`font-size:${size / 2}pt`);
    if (c.bold) css.push('font-weight:bold');
    if (c.italic) css.push('font-style:italic');
    const lines = [c.underline && 'underline', c.strike && 'line-through'].filter(Boolean);
    if (lines.length) {
      css.push(`text-decoration-line:${lines.join(' ')}`);
      if (c.underline === 'thick') css.push('text-decoration-thickness:2px');
      else if (c.underline && c.underline !== 'solid') css.push(`text-decoration-style:${c.underline}`);
      else if (c.strike === 2) css.push('text-decoration-style:double');
      const ul = this.colorOf(c.ulColor);
      if (ul && c.ulColor > 0) css.push(`text-decoration-color:${ul}`);
    }
    if (c.vert) css.push(`vertical-align:${c.vert}`);
    else if (c.up) css.push(`vertical-align:${c.up / 2}pt`);
    const color = c.color > 0 ? this.colorOf(c.color) : null;
    if (color) css.push(`color:${color}`);
    const bg = (c.highlight > 0 && this.colorOf(c.highlight)) || (c.bg > 0 && this.colorOf(c.bg));
    if (bg) css.push(`background-color:${bg}`);
    if (c.caps) css.push('text-transform:uppercase');
    if (c.scaps) css.push('font-variant:small-caps');
    if (c.spacing) css.push(`letter-spacing:${(c.spacing * PX).toFixed(2)}px`);
    return css.join(';');
  }

  /** Where inline content goes: the paragraph, or the link open in it. */
  private target(run: Run): ParentNode {
    const link = this.state.link;
    if (!link) {
      run.linkEl = null;
      return run.frag;
    }
    if (run.link !== link || !run.linkEl) {
      run.link = link;
      run.linkEl = h('a', { href: link.href, title: link.title || undefined });
      run.frag.append(run.linkEl);
    }
    return run.linkEl;
  }

  private addText(flow: Flow, text: string): void {
    if (!text) return;
    const run = this.run(flow);
    const key = this.charCss(this.state.char);
    const link = this.state.link;
    if (this.state.pageNum) {
      const span = h('span', { class: 'rtf-pagenum' }, text);
      if (key) span.style.cssText = key;
      this.addNode(flow, span);
      return;
    }
    if (run.text && run.key === key && (link ? run.linkEl !== null && run.link === link : run.linkEl === null)) {
      run.text.data += text;
      return;
    }
    const parent = this.target(run);
    const node = document.createTextNode(text);
    if (key) {
      const span = document.createElement('span');
      span.style.cssText = key;
      span.append(node);
      parent.append(span);
    } else {
      parent.append(node);
    }
    run.text = node;
    run.key = key;
  }

  private addNode(flow: Flow, node: Node): void {
    const run = this.run(flow);
    this.target(run).append(node);
    run.text = null;
  }

  private addTab(flow: Flow): void {
    const tab = h('span', { class: 'rtf-tab' }, '\t');
    const key = this.charCss(this.state.char);
    if (key) tab.style.cssText = key;
    this.addNode(flow, tab);
    this.run(flow).tabs.push(tab);
  }

  private noteMark(): void {
    const s = this.state;
    const n = s.flow.kind === 'note' ? Number(s.flow.root.dataset.note) : this.noteCount + 1;
    const a = h('a', s.flow.kind === 'note' ? { href: `#rtf-fnref-${n}`, title: 'Back to the text' } : { href: `#rtf-fn-${n}`, id: `rtf-fnref-${n}`, class: 'rtf-noteref' }, String(n));
    const key = this.charCss(s.char);
    if (key) a.style.cssText = key;
    this.addNode(s.flow, a);
  }

  private finishField(s: State): void {
    const field = s.field!;
    if (field.inst.startsWith('\u0001bookmark')) {
      const name = field.inst.slice(9).trim();
      if (name) this.addNode(this.stack[this.stack.length - 1]?.flow ?? s.flow, h('a', { id: `rtf-bm-${name}`, class: 'rtf-bookmark' }));
      return;
    }
    // A SYMBOL field without a stored result: draw the character it names.
    const symbol = /^\s*SYMBOL\s+(\d+)(?:.*\\f\s+"?([^"\\]+)"?)?/i.exec(field.inst);
    if (symbol && !field.result) {
      const code = Number(symbol[1]);
      const font = /wingdings|webdings/i.test(symbol[2] ?? '') ? 'wingdings' : /symbol/i.test(symbol[2] ?? '') ? 'symbol' : '';
      this.addText(s.flow, font ? symbolChar(code, font) : String.fromCharCode(code));
    }
  }

  private finishPicture(s: State): void {
    const pict = s.pict!;
    const parent = this.stack[this.stack.length - 1];
    if (parent?.dest === 'sv' && parent.shape) parent.shape.picture = true;
    if (s.char.hidden) return;
    const data = pict.data.take();
    let width = (pict.goalW || 0) * PX;
    let height = (pict.goalH || 0) * PX;
    if (!width || !height) {
      // Metafiles give their size in 0.01 mm, bitmaps in pixels.
      const metric = pict.kind === 'emf' || pict.kind === 'wmf';
      width = metric ? (pict.w / 2540) * 96 : pict.w;
      height = metric ? (pict.h / 2540) * 96 : pict.h;
    }
    width *= pict.scaleX / 100;
    height *= pict.scaleY / 100;
    const img = h('img', { class: 'rtf-pic', alt: '', draggable: false });
    if (width > 0 && height > 0) {
      img.style.width = `${width.toFixed(1)}px`;
      img.style.aspectRatio = `${width.toFixed(1)} / ${height.toFixed(1)}`;
    }
    const blob = (bytes: Uint8Array, type: string) => {
      const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
      this.urls.push(url);
      img.src = url;
    };
    if (pict.kind === 'png' || (data[0] === 0x89 && data[1] === 0x50)) blob(data, 'image/png');
    else if (pict.kind === 'jpeg' || (data[0] === 0xff && data[1] === 0xd8)) blob(data, 'image/jpeg');
    else if (pict.kind === 'emf' || pict.kind === 'wmf') this.metafiles.push({ img, data, label: pict.kind.toUpperCase() });
    else if (pict.kind === 'dib' && dibToBmp(data)) blob(dibToBmp(data)!, 'image/bmp');
    else {
      img.classList.add('rtf-pic-missing');
      img.alt = 'Picture';
    }
    this.addNode(s.flow, img);
  }

  private finishFlow(flow: Flow): void {
    if (flow.run) this.endParagraph(flow);
    this.syncTables(flow, 0);
  }

  /** Opens or closes tables so that `level` tables are open; returns where content of that level goes. */
  private syncTables(flow: Flow, level: number): HTMLElement {
    while (flow.tables.length > level) this.closeTable(flow);
    while (flow.tables.length < level) {
      const parent = flow.tables.length ? flow.tables[flow.tables.length - 1].cell : this.blockParent(flow);
      const slot = h('div', { class: 'rtf-table-slot' });
      parent.append(slot);
      flow.tables.push({ slot, rows: [], cells: [], cell: h('div', { class: 'rtf-cell' }) });
    }
    return level ? flow.tables[level - 1].cell : this.blockParent(flow);
  }

  private blockParent(flow: Flow): HTMLElement {
    if (flow === this.main && this.pendingBreak) {
      this.pendingBreak = false;
      this.newSheet();
    }
    return flow.root;
  }

  private newSheet(): void {
    if (this.main.tables.length || !this.main.root.hasChildNodes()) return;
    this.main.root = this.newSheetBody();
  }

  private pageBreak(): void {
    if (this.main.tables.length) return;
    if (this.main.run) this.endParagraph(this.main);
    this.newSheet();
  }

  private endCell(flow: Flow, level: number): void {
    if (flow.run) this.endParagraph(flow, level);
    else this.syncTables(flow, level);
    const table = flow.tables[level - 1];
    table.cells.push(table.cell);
    table.cell = h('div', { class: 'rtf-cell' });
  }

  private endRow(flow: Flow, level: number): void {
    if (flow.run) this.endParagraph(flow, level);
    this.syncTables(flow, level);
    const table = flow.tables[level - 1];
    if (table.cell.hasChildNodes()) {
      table.cells.push(table.cell);
      table.cell = h('div', { class: 'rtf-cell' });
    }
    table.rows.push({ cells: table.cells, def: this.rowDefs.get(level) ?? newRowDef() });
    table.cells = [];
  }

  private endParagraph(flow: Flow, cellLevel = 0): void {
    const s = this.state;
    const p = s.para;
    const run = flow.run;
    flow.run = null;
    const level = cellLevel || (p.intbl ? Math.max(1, p.itap) : 0);
    if (flow === this.main && level === 0 && p.pagebb && !this.pendingBreak) this.newSheet();
    if (!p.pn) this.pnActive = false;
    const parent = this.syncTables(flow, level);
    parent.append(this.paragraph(run, p, s.char));
  }

  private listMarker(p: Para): { text: string; font: number } | null {
    if (p.ls > 0) {
      const levels = this.lists.get(this.overrides.get(p.ls) ?? -1);
      const level = levels?.[p.ilvl];
      if (!levels || !level || level.nfc === 255) return null;
      let counts = this.counters.get(p.ls);
      if (!counts) this.counters.set(p.ls, (counts = []));
      counts[p.ilvl] = (counts[p.ilvl] ?? (level.start || 1) - 1) + 1;
      counts.length = p.ilvl + 1;
      let text = '';
      // The first character is the length; characters below 9 stand for the numbers of the levels.
      for (const ch of level.text.slice(1, 1 + (level.text.charCodeAt(0) || 0))) {
        const code = ch.charCodeAt(0);
        if (code < 9) {
          const lv = levels[code];
          text += numberText(counts[code] ?? lv?.start ?? 1, lv?.nfc ?? 0);
        } else {
          text += ch;
        }
      }
      if (level.nfc === 23 && !text) text = '•';
      return { text: text + (level.follow === 0 ? '\t' : level.follow === 1 ? ' ' : ''), font: level.font };
    }
    if (p.pn) {
      const pn = p.pn;
      if (pn.kind === 'cont') return null;
      if (pn.kind === 'bullet') return { text: `${pn.before || '•'}\t`, font: pn.font };
      this.pnCount = this.pnActive ? this.pnCount + 1 : pn.start;
      this.pnActive = true;
      return { text: `${pn.before}${numberText(this.pnCount, pn.nfc)}${pn.after}\t`, font: pn.font };
    }
    return null;
  }

  private paragraph(run: Run | null, p: Para, mark: Char): HTMLElement {
    const style = p.style ? this.styles.get(p.style) : undefined;
    const outline = p.outline >= 0 ? p.outline : (style?.outline ?? -1);
    const heading = outline >= 0 && outline < 6 ? outline + 1 : /^heading\s*([1-6])$/i.exec(style?.name ?? '')?.[1];
    const el = document.createElement(heading ? `h${heading}` : 'p');
    el.className = 'rtf-p';
    const css: string[] = [];
    if (p.align) css.push(`text-align:${p.align}`);
    if (p.li) css.push(p.li > 0 ? `padding-left:${(p.li * PX).toFixed(1)}px` : `margin-left:${(p.li * PX).toFixed(1)}px`);
    if (p.ri) css.push(p.ri > 0 ? `padding-right:${(p.ri * PX).toFixed(1)}px` : `margin-right:${(p.ri * PX).toFixed(1)}px`);
    if (p.fi) css.push(`text-indent:${(p.fi * PX).toFixed(1)}px`);
    const boxed = !!(p.borders || p.bg);
    // Word adds the space after one paragraph to the space before the next; padding does not collapse like margins.
    if (p.sb) css.push(`${boxed ? 'margin' : 'padding'}-top:${(p.sb * PX).toFixed(1)}px`);
    if (p.sa) css.push(`${boxed ? 'margin' : 'padding'}-bottom:${(p.sa * PX).toFixed(1)}px`);
    const pt = mark.size / 2;
    if (pt !== 12) css.push(`font-size:${pt}pt`);
    if (p.sl) {
      if (p.slmult) css.push(`line-height:${((Math.abs(p.sl) / 240) * 1.15).toFixed(3)}`);
      else if (p.sl < 0) css.push(`line-height:${-p.sl / 20}pt`);
      else if (p.sl / 20 > pt * 1.15) css.push(`line-height:${p.sl / 20}pt`);
    }
    const bg = this.colorOf(p.bg);
    if (bg && p.bg > 0) css.push(`background-color:${bg}`);
    if (p.borders) {
      for (const [side, b] of Object.entries(p.borders) as [Side, Border][]) css.push(`border-${side}:${this.borderCss(b)}`);
      css.push('padding-top:2px', 'padding-bottom:2px');
    }
    if (css.length) el.style.cssText = css.join(';');
    if (p.rtl) el.dir = 'rtl';

    if (run && !run.listText) {
      const marker = this.listMarker(p);
      if (marker) {
        const font = this.fonts.get(marker.font);
        const symbol = font?.symbol ?? '';
        // Bullets in symbol fonts arrive as bytes (\'b7) or as private-use characters (\u-3913).
        const text = Array.from(marker.text, (ch) => {
          const code = ch.charCodeAt(0);
          if (code >= 0xf020 && code <= 0xf0ff) return symbolChar(code - 0xf000, symbol || 'symbol');
          return symbol && code > 0x20 && code <= 0xff ? symbolChar(code, symbol) : ch;
        }).join('');
        const label = text.replace(/\t$/, '');
        const sep = text.endsWith('\t');
        const span = h('span', { class: 'rtf-marker' }, label);
        if (font && !font.symbol) span.style.fontFamily = fontCss(font);
        run.frag.prepend(span, ...(sep ? [h('span', { class: 'rtf-tab' }, '\t')] : []));
        if (sep) run.tabs.unshift(span.nextSibling as HTMLElement);
      }
    }
    if (run) {
      el.append(run.frag);
      if (run.tabs.length) {
        this.tabStops.set(el, { stops: p.tabs, li: p.li, fi: p.fi });
        this.tabbed.push(el);
      }
    }
    if (!el.textContent && !el.querySelector('img, br')) el.append(h('br'));
    return el;
  }

  private borderCss(b: Border | undefined): string {
    if (!b || b.style === 'none') return 'none';
    const width = Math.max(b.style === 'double' ? 3 : 1, Math.round(b.width * PX * (b.style === 'double' ? 3 : 1)));
    return `${width}px ${b.style} ${(b.color > 0 && this.colorOf(b.color)) || '#000'}`;
  }

  // ---- Tables ----

  private closeTable(flow: Flow): void {
    const table = flow.tables.pop()!;
    if (table.cells.length || table.cell.hasChildNodes()) {
      if (table.cell.hasChildNodes()) table.cells.push(table.cell);
      table.rows.push({ cells: table.cells, def: this.rowDefs.get(flow.tables.length + 1) ?? newRowDef() });
    }
    table.slot.replaceWith(this.renderTable(table));
  }

  private renderTable(table: Table): HTMLElement {
    // One grid column between every pair of neighboring cell edges, over all rows.
    const edges = new Set<number>();
    const layout = table.rows.map(({ cells, def }) => {
      let x = def.left;
      edges.add(x);
      return cells.map((content, j) => {
        const cd = def.cells[j] ?? { ...newCellDef(), right: x + 1440 };
        const left = x;
        x = Math.max(cd.right, x + 1);
        edges.add(x);
        return { content, cd, left, right: x };
      });
    });
    const grid = [...edges].sort((a, b) => a - b);
    const col = (x: number) => grid.indexOf(x);
    const first = table.rows[0]?.def ?? newRowDef();
    const el = h('table', { class: 'rtf-table' });
    el.style.width = `${((grid[grid.length - 1] - grid[0]) * PX).toFixed(1)}px`;
    if (first.align === 'center') el.style.margin = '0 auto';
    else if (first.align === 'right') el.style.marginLeft = 'auto';
    else el.style.marginLeft = `${(grid[0] * PX).toFixed(1)}px`;
    if (first.rtl) el.dir = 'rtl';
    el.append(h('colgroup', {}, ...grid.slice(1).map((x, k) => h('col', { style: `width:${((x - grid[k]) * PX).toFixed(1)}px` }))));
    const body = h('tbody');
    const vertical = new Map<number, HTMLTableCellElement>();
    table.rows.forEach(({ def }, r) => {
      const tr = h('tr');
      if (def.height) tr.style.height = `${(Math.abs(def.height) * PX).toFixed(1)}px`;
      let at = 0;
      let last: HTMLTableCellElement | null = null;
      const cells = layout[r];
      cells.forEach(({ content, cd, left, right }, j) => {
        const start = col(left);
        const span = Math.max(1, col(right) - start);
        if (cd.merge === 'merged' && last) {
          last.colSpan += span;
          at = start + span;
          return;
        }
        const origin = vertical.get(start);
        if (cd.vmerge === 'merged' && origin && origin.colSpan === span) {
          origin.rowSpan++;
          if (content.textContent?.trim()) origin.append(...content.childNodes);
          at = start + span;
          return;
        }
        if (start > at) tr.append(h('td', { class: 'rtf-gap', colSpan: start - at }));
        const td = h('td', { colSpan: span });
        const pad = (side: Side) => def.pad[side] ?? (side === 'left' || side === 'right' ? (def.gap >= 0 ? def.gap : 108) : 0);
        const css = [`padding:${(pad('top') * PX).toFixed(1)}px ${(pad('right') * PX).toFixed(1)}px ${(pad('bottom') * PX).toFixed(1)}px ${(pad('left') * PX).toFixed(1)}px`];
        const rb = def.borders;
        const borders: Record<Side, Border | undefined> = {
          top: cd.borders.top ?? (r === 0 ? rb.top : rb.h) ?? rb.top,
          bottom: cd.borders.bottom ?? (r === table.rows.length - 1 ? rb.bottom : rb.h) ?? rb.bottom,
          left: cd.borders.left ?? (j === 0 ? rb.left : rb.v),
          right: cd.borders.right ?? (j === cells.length - 1 ? rb.right : rb.v),
        };
        for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) if (borders[side]) css.push(`border-${side}:${this.borderCss(borders[side])}`);
        const bg = this.colorOf(cd.bg);
        if (cd.shading > 0) {
          const fg = this.colorOf(cd.pattern) ?? '#000000';
          css.push(`background-color:${mix(fg, bg ?? '#ffffff', Math.min(1, cd.shading / 10000))}`);
        } else if (bg && cd.bg > 0) {
          css.push(`background-color:${bg}`);
        }
        if (cd.valign) css.push(`vertical-align:${cd.valign}`);
        td.style.cssText = css.join(';');
        td.append(...content.childNodes);
        tr.append(td);
        last = td;
        if (cd.vmerge === 'first') vertical.set(start, td);
        else vertical.delete(start);
        at = start + span;
      });
      body.append(tr);
    });
    el.append(body);
    return el;
  }

  // ---- Result ----

  finish(): void {
    this.finishFlow(this.main);
    if (this.header) this.finishFlow(this.header);
    if (this.footer) this.finishFlow(this.footer);
    if (this.notes.length) this.sheets[this.sheets.length - 1].append(h('div', { class: 'rtf-notes' }, h('hr'), ...this.notes));
    const { width, height, left, right, top, bottom } = this.page;
    const px = (twips: number) => `${(twips * PX).toFixed(1)}px`;
    const shown = (flow: Flow | null) => (flow && (flow.root.textContent?.trim() || flow.root.querySelector('img')) ? flow.root : null);
    const margins: [HTMLElement | null, string, number][] = [[shown(this.header), 'top', this.page.header], [shown(this.footer), 'bottom', this.page.footer]];
    const font = this.fonts.get(this.deff);
    this.sheets.forEach((sheet, k) => {
      sheet.style.width = px(width);
      sheet.style.minHeight = px(height);
      sheet.style.padding = `${px(top)} ${px(right)} ${px(bottom)} ${px(left)}`;
      if (font && !font.symbol) sheet.style.fontFamily = fontCss(font);
      // Header and footer sit in the page margins of every sheet, with the sheet number in PAGE fields.
      for (const [root, edge, distance] of margins) {
        if (!root) continue;
        const copy = root.cloneNode(true) as HTMLElement;
        for (const num of copy.querySelectorAll('.rtf-pagenum')) num.textContent = String(k + 1);
        copy.style.cssText = `${edge}:${px(distance)};left:${px(left)};right:${px(right)}`;
        sheet.append(copy);
      }
    });
    for (const key of Object.keys(this.info) as (keyof RtfInfo)[]) {
      const value = this.info[key];
      if (typeof value === 'string') (this.info as Record<string, unknown>)[key] = value.trim().replace(/;$/, '') || undefined;
    }
  }

  get paperWidth(): number {
    return this.page.width * PX;
  }

  get deftabPx(): number {
    return this.deftab * PX;
  }
}

// ---- Tabs -----------------------------------------------------------------------------------------------------------

/** Longest run of tab measurements; beyond it tabs keep their fixed default width. */
const TAB_LIMIT = 5000;

function layoutTabs(parser: RtfParser): void {
  let budget = TAB_LIMIT;
  const deftab = parser.deftabPx || 48;
  for (const p of parser.tabbed) {
    const info = parser.tabStops.get(p);
    if (!info) continue;
    const tabs = [...p.querySelectorAll<HTMLElement>('.rtf-tab')];
    const origin = p.getBoundingClientRect().left - Math.min(0, info.li * PX);
    const stops = info.stops.map((t) => ({ ...t, x: t.pos * PX }));
    const hanging = info.fi < 0 ? info.li * PX : -1;
    for (let k = 0; k < tabs.length; k++) {
      if (--budget < 0) return;
      const tab = tabs[k];
      tab.style.width = '0px';
      const x = tab.getBoundingClientRect().left - origin;
      let stop = stops.find((t) => t.x > x + 0.5);
      if (hanging > x + 0.5 && (!stop || hanging < stop.x)) stop = { pos: 0, kind: 'left', leader: '', x: hanging };
      const target = stop ? stop.x : (Math.floor(x / deftab + 0.01) + 1) * deftab;
      let width = target - x;
      if (stop && stop.kind !== 'left') {
        // Right, center and decimal tabs align the text that follows up to the next tab.
        const range = document.createRange();
        range.setStartAfter(tab);
        if (tabs[k + 1]) range.setEndBefore(tabs[k + 1]);
        else range.setEndAfter(p.lastChild!);
        const segment = range.getBoundingClientRect().width;
        width -= stop.kind === 'center' ? segment / 2 : segment;
      }
      tab.style.width = `${Math.max(2, width).toFixed(1)}px`;
      if (stop?.leader) tab.classList.add(`rtf-leader-${stop.leader}`);
    }
  }
}

// ---- Entry points ---------------------------------------------------------------------------------------------------

export function parseRtf(data: Uint8Array): RtfDocument {
  const parser = new RtfParser();
  parser.parse(data);
  parser.finish();
  const words = parser.sheets.reduce((sum, sheet) => sum + (sheet.textContent ?? '').split(/\s+/).filter(Boolean).length, 0);
  return {
    sheets: parser.sheets,
    width: parser.paperWidth,
    info: parser.info,
    words,
    layoutTabs: () => layoutTabs(parser),
    drawPictures: async () => {
      if (!parser.metafiles.length) return;
      const { metafileToPng } = await import('ooxml-pages/metafile');
      for (const { img, data, label } of parser.metafiles) {
        const png = await metafileToPng(data).catch(() => null);
        if (png) {
          const url = URL.createObjectURL(png);
          parser.urls.push(url);
          img.src = url;
        } else {
          img.classList.add('rtf-pic-missing');
          img.alt = `Picture (${label})`;
        }
      }
    },
    destroy: () => {
      for (const url of parser.urls) URL.revokeObjectURL(url);
    },
  };
}

/** Only the document properties: reading stops where the text begins. */
export function readRtfInfo(data: Uint8Array): RtfInfo {
  const parser = new RtfParser(true);
  parser.parse(data);
  parser.finish();
  return parser.info;
}
