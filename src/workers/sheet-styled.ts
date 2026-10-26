// SPDX-License-Identifier: GPL-3.0-or-later
// Formatting of .xlsx/.xlsm, read straight from the package (styles.xml, theme, sheet XML) with zip.js. The values
// come from SheetJS; this adds fonts, fills, borders, alignment, row heights, column widths and merged cells.
import { BlobReader, TextWriter, ZipReader, configure } from '@zip.js/zip.js';
import * as XLSX from 'xlsx';
import type { GridCell, Merge } from '../viewers/grid';
import type { SheetData } from './sheet-types';

configure({ useWebWorkers: false, useCompressionStream: true });

/** Excel's legacy 64-color palette for "indexed" colors (64/65: system foreground/background). */
const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00',
  '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080',
  '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF',
  '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300',
  '993300', '993366', '333399', '333333', '000000', 'FFFFFF',
];

/** Theme color order as styles reference it: light 1, dark 1, light 2, dark 2, accents, links. */
const THEME_SLOTS = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
const OFFICE_THEME: Record<string, string> = {
  dk1: '000000', lt1: 'FFFFFF', dk2: '44546A', lt2: 'E7E6E6', accent1: '4472C4', accent2: 'ED7D31', accent3: 'A5A5A5',
  accent4: 'FFC000', accent5: '5B9BD5', accent6: '70AD47', hlink: '0563C1', folHlink: '954F72',
};

const FALLBACK_FONTS = 'Calibri,Carlito,"Segoe UI",Arial,sans-serif';
const ptToPx = (pt: number) => (pt * 96) / 72;

// ---- Tiny XML helpers: the parts we read are flat and machine-written, so regular expressions suffice. -------

function attributes(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:]+)="([^"]*)"/g)) out[m[1].replace(/^\w+:/, '')] = m[2];
  return out;
}

/** Contents of each <name>…</name> or <name/> element inside `xml` (not nested in itself). */
function elements(xml: string, name: string): { attrs: Record<string, string>; body: string }[] {
  const out: { attrs: Record<string, string>; body: string }[] = [];
  const re = new RegExp(`<(?:\\w+:)?${name}\\b([^>]*?)(/>|>([\\s\\S]*?)</(?:\\w+:)?${name}>)`, 'g');
  for (const m of xml.matchAll(re)) out.push({ attrs: attributes(m[1]), body: m[3] ?? '' });
  return out;
}

const section = (xml: string, name: string) => elements(xml, name)[0]?.body ?? '';

// ---- Colors ---------------------------------------------------------------------------------------------------

function parseTheme(xml: string | null): string[] {
  const colors = { ...OFFICE_THEME };
  if (xml) {
    for (const m of xml.matchAll(/<a:(dk1|lt1|dk2|lt2|accent[1-6]|hlink|folHlink)>\s*<a:(?:srgbClr val="([0-9A-Fa-f]{6})"|sysClr[^>]*lastClr="([0-9A-Fa-f]{6})")/g)) {
      colors[m[1]] = (m[2] ?? m[3]).toUpperCase();
    }
  }
  return THEME_SLOTS.map((slot) => colors[slot]);
}

/** Excel's tint: lighten (positive) or darken (negative) in HSL lightness. */
function applyTint(hex: string, tint: number): string {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let hue = 0;
  let sat = 0;
  let light = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    sat = light > 0.5 ? d / (2 - max - min) : d / (max + min);
    hue = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
  }
  light = tint < 0 ? light * (1 + tint) : light * (1 - tint) + tint;
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const channel = (t: number) => {
    const x = t < 0 ? t + 1 : t > 1 ? t - 1 : t;
    const v = x < 1 / 6 ? p + (q - p) * 6 * x : x < 1 / 2 ? q : x < 2 / 3 ? p + (q - p) * (2 / 3 - x) * 6 : p;
    return Math.round(v * 255).toString(16).padStart(2, '0');
  };
  return sat === 0 ? channel(light).repeat(3) : channel(hue + 1 / 3) + channel(hue) + channel(hue - 1 / 3);
}

function color(attrs: Record<string, string> | undefined, theme: string[]): string | null {
  if (!attrs || attrs.auto === '1') return null;
  let hex: string | undefined;
  if (attrs.rgb) hex = attrs.rgb.length === 8 ? attrs.rgb.slice(2) : attrs.rgb;
  else if (attrs.theme !== undefined) hex = theme[Number(attrs.theme)];
  else if (attrs.indexed !== undefined) hex = INDEXED[Number(attrs.indexed)];
  if (!hex || !/^[0-9A-Fa-f]{6}$/.test(hex)) return null;
  const tint = Number(attrs.tint ?? 0);
  return `#${tint ? applyTint(hex, tint) : hex}`;
}

const child = (body: string, name: string) => elements(body, name)[0];

// ---- Styles ---------------------------------------------------------------------------------------------------

const BORDERS: Record<string, string> = {
  thin: '1px solid', hair: '1px solid', medium: '2px solid', thick: '3px solid', dashed: '1px dashed', dotted: '1px dotted',
  double: '3px double', mediumDashed: '2px dashed', dashDot: '1px dashed', mediumDashDot: '2px dashed', dashDotDot: '1px dotted',
  mediumDashDotDot: '2px dotted', slantDashDot: '2px dashed',
};
const H_ALIGN: Record<string, [string, string]> = {
  left: ['flex-start', 'left'], center: ['center', 'center'], right: ['flex-end', 'right'], centerContinuous: ['center', 'center'],
  distributed: ['center', 'center'], justify: ['flex-start', 'justify'], fill: ['flex-start', 'left'],
};
const V_ALIGN: Record<string, string> = { top: 'flex-start', center: 'center', bottom: 'flex-end', distributed: 'center', justify: 'flex-start' };

interface Font {
  css: string[];
  name: string;
  size: number;
}

interface Styles {
  /** CSS per cellXfs index; '' when the style looks like the default. */
  xf: string[];
  base: { name: string; size: number };
}

function parseStyles(xml: string | null, theme: string[]): Styles {
  if (!xml) return { xf: [], base: { name: 'Calibri', size: 11 } };
  const fonts: Font[] = elements(section(xml, 'fonts'), 'font').map(({ body }) => {
    const css: string[] = [];
    if (child(body, 'b') && child(body, 'b').attrs.val !== '0') css.push('font-weight:700');
    if (child(body, 'i') && child(body, 'i').attrs.val !== '0') css.push('font-style:italic');
    const decoration = [child(body, 'u') && child(body, 'u').attrs.val !== 'none' ? 'underline' : '', child(body, 'strike') && child(body, 'strike').attrs.val !== '0' ? 'line-through' : ''].filter(Boolean).join(' ');
    if (decoration) css.push(`text-decoration:${decoration}`);
    const c = color(child(body, 'color')?.attrs, theme);
    if (c && c.toUpperCase() !== '#000000') css.push(`color:${c}`);
    const vert = child(body, 'vertAlign')?.attrs.val;
    if (vert === 'superscript' || vert === 'subscript') css.push('font-size:75%');
    return { css, name: child(body, 'name')?.attrs.val ?? 'Calibri', size: Number(child(body, 'sz')?.attrs.val ?? 11) };
  });
  const fills: string[] = elements(section(xml, 'fills'), 'fill').map(({ body }) => {
    const pattern = child(body, 'patternFill');
    if (pattern && pattern.attrs.patternType && pattern.attrs.patternType !== 'none') {
      const c = color(child(pattern.body, 'fgColor')?.attrs, theme) ?? color(child(pattern.body, 'bgColor')?.attrs, theme);
      return c ? `background:${c}` : '';
    }
    const stop = child(body, 'gradientFill') ? child(child(body, 'gradientFill').body, 'stop') : undefined;
    const c = stop ? color(child(stop.body, 'color')?.attrs, theme) : null;
    return c ? `background:${c}` : '';
  });
  const borders: string[] = elements(section(xml, 'borders'), 'border').map(({ body }) =>
    (['top', 'left', 'bottom', 'right'] as const)
      .map((side) => {
        const b = child(body, side);
        if (!b?.attrs.style || !BORDERS[b.attrs.style]) return '';
        return `border-${side}:${BORDERS[b.attrs.style]} ${color(child(b.body, 'color')?.attrs, theme) ?? '#000'}`;
      })
      .filter(Boolean)
      .join(';'),
  );
  const base = fonts[0] ?? { css: [], name: 'Calibri', size: 11 };
  const xf = elements(section(xml, 'cellXfs'), 'xf').map(({ attrs, body }) => {
    const css: string[] = [];
    const font = fonts[Number(attrs.fontId ?? 0)];
    if (font) {
      css.push(...font.css);
      if (font.size !== base.size) css.push(`font-size:${ptToPx(font.size).toFixed(1)}px`);
      if (font.name !== base.name) css.push(`font-family:"${font.name.replace(/"/g, '')}",${FALLBACK_FONTS}`);
    }
    const fill = fills[Number(attrs.fillId ?? 0)];
    if (fill) css.push(fill);
    const border = borders[Number(attrs.borderId ?? 0)];
    if (border) css.push(border);
    const alignment = child(body, 'alignment')?.attrs;
    if (alignment) {
      const horizontal = H_ALIGN[alignment.horizontal];
      if (horizontal) css.push(`justify-content:${horizontal[0]};text-align:${horizontal[1]}`);
      if (V_ALIGN[alignment.vertical]) css.push(`align-items:${V_ALIGN[alignment.vertical]}`);
      if (Number(alignment.indent)) css.push(`padding-left:${4 + Number(alignment.indent) * 9}px`);
      if (alignment.wrapText === '1' || alignment.wrapText === 'true') css.push('--wrap:1');
    }
    return css.join(';');
  });
  return { xf, base: { name: base.name, size: base.size } };
}

// ---- Package --------------------------------------------------------------------------------------------------

async function readPackage(buffer: ArrayBuffer): Promise<Map<string, () => Promise<string>>> {
  const reader = new ZipReader(new BlobReader(new Blob([buffer])));
  const files = new Map<string, () => Promise<string>>();
  for (const entry of await reader.getEntries()) {
    if (!entry.directory && entry.getData) files.set(entry.filename.replace(/^\//, ''), () => entry.getData!(new TextWriter()));
  }
  return files;
}

/** Sheet XML paths in workbook order. */
async function sheetPaths(files: Map<string, () => Promise<string>>): Promise<string[]> {
  const workbook = (await files.get('xl/workbook.xml')?.()) ?? '';
  const rels = (await files.get('xl/_rels/workbook.xml.rels')?.()) ?? '';
  const targets = new Map(elements(rels, 'Relationship').map(({ attrs }) => [attrs.Id, attrs.Target]));
  return elements(section(workbook, 'sheets'), 'sheet').map(({ attrs }) => {
    const target = targets.get(attrs.id) ?? '';
    return target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
  });
}

interface SheetFormat {
  /** Style index per cell, keyed "row,col" (0-based). */
  cells: Map<string, number>;
  rowHeights: Map<number, number>;
  hiddenRows: Set<number>;
  columnWidths: Map<number, number>;
  merges: Merge[];
  gridlines: boolean;
  defaultRowHeight: number;
  defaultColumnWidth: number;
}

function parseSheet(xml: string): SheetFormat {
  const format: SheetFormat = {
    cells: new Map(), rowHeights: new Map(), hiddenRows: new Set(), columnWidths: new Map(), merges: [], gridlines: true,
    defaultRowHeight: 15, defaultColumnWidth: 8.43,
  };
  let row = -1;
  let column = -1;
  for (const m of xml.matchAll(/<(row|c|col|mergeCell|sheetView|sheetFormatPr)\b([^>]*?)\/?>/g)) {
    const attrs = attributes(m[2]);
    switch (m[1]) {
      case 'row':
        row = attrs.r ? Number(attrs.r) - 1 : row + 1;
        column = -1;
        if (attrs.hidden === '1') format.hiddenRows.add(row);
        if (attrs.ht && attrs.customHeight !== '0') format.rowHeights.set(row, Number(attrs.ht));
        break;
      case 'c': {
        const address = attrs.r ? XLSX.utils.decode_cell(attrs.r) : { r: row, c: column + 1 };
        column = address.c;
        if (attrs.s && attrs.s !== '0') format.cells.set(`${address.r},${address.c}`, Number(attrs.s));
        break;
      }
      case 'col':
        for (let c = Number(attrs.min) - 1; c <= Number(attrs.max) - 1 && c < 16384; c++) {
          format.columnWidths.set(c, attrs.hidden === '1' ? 0 : Number(attrs.width ?? format.defaultColumnWidth));
        }
        break;
      case 'mergeCell': {
        const range = XLSX.utils.decode_range(attrs.ref);
        format.merges.push({ r0: range.s.r, c0: range.s.c, r1: range.e.r, c1: range.e.c });
        break;
      }
      case 'sheetView':
        if (attrs.showGridLines === '0' || attrs.showGridLines === 'false') format.gridlines = false;
        break;
      case 'sheetFormatPr':
        if (attrs.defaultRowHeight) format.defaultRowHeight = Number(attrs.defaultRowHeight);
        if (attrs.defaultColWidth) format.defaultColumnWidth = Number(attrs.defaultColWidth);
        else if (attrs.baseColWidth) format.defaultColumnWidth = Number(attrs.baseColWidth) + 0.71;
        break;
    }
  }
  return format;
}

/** Adds formatting to the sheets SheetJS read from the same file (same order). */
export async function addFormatting(buffer: ArrayBuffer, sheets: SheetData[]): Promise<void> {
  const files = await readPackage(buffer);
  const theme = parseTheme((await files.get('xl/theme/theme1.xml')?.()) ?? null);
  const styles = parseStyles((await files.get('xl/styles.xml')?.()) ?? null, theme);
  const paths = await sheetPaths(files);

  for (const [index, sheet] of sheets.entries()) {
    const xml = await files.get(paths[index])?.();
    if (!xml) continue;
    const format = parseSheet(xml);
    // Cells that carry only a fill or border extend the shown area, too.
    let rowCount = sheet.rows.length;
    let columnCount = sheet.columnCount;
    for (const key of format.cells.keys()) {
      const [r, c] = key.split(',').map(Number);
      if (!styles.xf[format.cells.get(key)!]) continue;
      rowCount = Math.max(rowCount, r - sheet.firstRow + 1);
      columnCount = Math.max(columnCount, c + 1);
    }
    for (const m of format.merges) {
      rowCount = Math.max(rowCount, m.r1 - sheet.firstRow + 1);
      columnCount = Math.max(columnCount, m.c1 + 1);
    }
    // Keep it bounded: styled columns far to the right are usually whole-row formatting.
    columnCount = Math.min(columnCount, Math.max(sheet.columnCount, 256));
    rowCount = Math.min(rowCount, Math.max(sheet.rows.length, 100_000));

    const styleIds = new Map<string, number>();
    const css: string[] = [];
    const styleOf = (xfIndex: number | undefined) => {
      const text = xfIndex === undefined ? '' : styles.xf[xfIndex];
      if (!text) return undefined;
      let id = styleIds.get(text);
      if (id === undefined) {
        id = css.push(text) - 1;
        styleIds.set(text, id);
      }
      return id;
    };
    for (let r = 0; r < rowCount; r++) {
      const row = (sheet.rows[r] ??= []);
      const sheetRow = r + sheet.firstRow;
      for (let c = 0; c < columnCount; c++) {
        const style = styleOf(format.cells.get(`${sheetRow},${c}`));
        if (style === undefined) continue;
        const cell = row[c];
        row[c] = typeof cell === 'object' ? { ...cell, style } : { text: cell ?? '', style };
      }
    }
    sheet.rows.length = rowCount;
    sheet.columnCount = columnCount;
    sheet.styles = css;
    sheet.gridlines = format.gridlines;
    sheet.merges = format.merges
      .map((m) => ({ ...m, r0: m.r0 - sheet.firstRow, r1: m.r1 - sheet.firstRow }))
      .filter((m) => m.r1 >= 0);
    sheet.rowHeights = Array.from({ length: rowCount }, (_, r) => {
      const sheetRow = r + sheet.firstRow;
      return format.hiddenRows.has(sheetRow) ? 0 : Math.round(ptToPx(format.rowHeights.get(sheetRow) ?? format.defaultRowHeight));
    });
    // Excel column width is in characters of the default font: about 7 px each plus 5 px padding.
    sheet.columnWidths = Array.from({ length: columnCount }, (_, c) => {
      const width = format.columnWidths.get(c) ?? format.defaultColumnWidth;
      return width === 0 ? 0 : Math.round(width * 7 + 5);
    });
    sheet.baseStyle = `font-family:"${styles.base.name.replace(/"/g, '')}",${FALLBACK_FONTS};font-size:${ptToPx(styles.base.size).toFixed(1)}px`;
  }
}

export type { GridCell };
