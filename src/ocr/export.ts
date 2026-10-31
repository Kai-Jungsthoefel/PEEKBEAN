// SPDX-License-Identifier: GPL-3.0-or-later
// Document blocks → plain text, Markdown and Word. Word gets real headings, lists, tables with merged cells,
// the pictures, a language per paragraph (so spell checking fits), blocks side by side as a table without borders,
// and each page as a section with its own header and footer (page numbers as fields, counting on from the original).
import {
  AlignmentType, BorderStyle, Document, Footer, Header, HeadingLevel, ImageRun, LevelFormat, Packer, PageNumber,
  PageOrientation, Paragraph, Tab, Table, TableCell, TableRow, TabStopType, TextRun, WidthType, type IBorderOptions,
} from 'docx';
import { walk, type Block, type MarginRow } from './assemble';
import type { Img } from './image';
import type { TableGrid } from './table';

export type Pages = Block[][];

// ---------- Markdown ----------

/** Markdown; pictures are left out (they would be files of their own), Word keeps them */
export function toMarkdown(pages: Pages): string {
  const out: string[] = [];
  pages.forEach((blocks, p) => {
    if (p) out.push('---');
    // Markdown has no columns: side-by-side blocks follow each other in reading order
    for (const b of walk(blocks)) {
      if (b.type === 'heading') out.push(`${'#'.repeat(b.level)} ${b.text}`);
      else if (b.type === 'paragraph') out.push(b.role === 'caption' ? `*${b.text}*` : b.text.replace(/\n/g, '  \n'));
      else if (b.type === 'list') out.push(b.items.map((t, i) => (b.ordered ? `${i + 1}. ` : '- ') + t).join('\n'));
      else if (b.type === 'table') out.push(tableMarkdown(b.grid));
    }
  });
  return out.join('\n\n') + '\n';
}

/** Plain text in reading order: paragraphs separated by a blank line, table rows with tabs between the cells */
export function toText(pages: Pages): string {
  const out: string[] = [];
  pages.forEach((blocks, p) => {
    if (p) out.push('');
    for (const b of walk(blocks)) {
      if (b.type === 'heading' || b.type === 'paragraph') out.push(b.text);
      else if (b.type === 'list') out.push(b.items.map((t, i) => (b.ordered ? `${i + 1}. ` : '- ') + t).join('\n'));
      else if (b.type === 'table') {
        const rows: string[] = [];
        for (let r = 0; r < b.grid.rows; r++) {
          rows.push(b.grid.cells.filter((c) => c.row === r).sort((x, y) => x.col - y.col).map((c) => (c.text ?? '').replace(/\s*\n\s*/g, ' ')).join('\t'));
        }
        out.push(rows.join('\n'));
      }
    }
  });
  return out.join('\n\n') + '\n';
}

function tableMarkdown(g: TableGrid): string {
  const spans = g.cells.some((c) => c.rowSpan > 1 || c.colSpan > 1);
  const cell = (t = '') => t.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
  if (spans) return tableHtml(g);
  const rows: string[][] = Array.from({ length: g.rows }, () => Array(g.cols).fill(''));
  for (const c of g.cells) rows[c.row][c.col] = cell(c.text);
  const line = (r: string[]) => `| ${r.join(' | ')} |`;
  return [line(rows[0]), `|${rows[0].map(() => '---').join('|')}|`, ...rows.slice(1).map(line)].join('\n');
}

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function tableHtml(g: TableGrid): string {
  const rows: string[] = [];
  for (let r = 0; r < g.rows; r++) {
    const cells = g.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col).map((c) => {
      const tag = c.header || (r === 0 && g.source !== 'columns') ? 'th' : 'td';
      const attrs = (c.colSpan > 1 ? ` colspan="${c.colSpan}"` : '') + (c.rowSpan > 1 ? ` rowspan="${c.rowSpan}"` : '');
      return `<${tag}${attrs}>${esc(c.text ?? '').replace(/\n/g, '<br>')}</${tag}>`;
    });
    rows.push(`<tr>${cells.join('')}</tr>`);
  }
  return `<table>${rows.join('')}</table>`;
}

export interface DocxPage {
  blocks: Block[];
  header: MarginRow[];
  footer: MarginRow[];
  /** Size of the page image in pixels: pictures keep their share of the page, wide pages become landscape */
  width: number;
  height: number;
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3];
const NONE: IBorderOptions = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const LINE: IBorderOptions = { style: BorderStyle.SINGLE, size: 4, color: '808080' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };
/** A4 with 2.54 cm margins: text width in twips (1/1440 in), portrait and landscape */
const TEXT_TWIPS = { portrait: 11906 - 2 * 1440, landscape: 16838 - 2 * 1440 };

type Out = Paragraph | Table;

export async function toDocx(pages: DocxPage[], png: (img: Img) => Promise<Uint8Array>): Promise<Blob> {
  let lists = 0;
  const sections = [];
  for (const page of pages) {
    const landscape = page.width > page.height;
    const textTwips = landscape ? TEXT_TWIPS.landscape : TEXT_TWIPS.portrait;
    // Image pixels → Word pixels (96 per inch): the page image's width maps to the text width
    const scale = (textTwips / 1440) * 96 / page.width;

    const render = async (blocks: Block[], share: number): Promise<Out[]> => {
      const out: Out[] = [];
      for (const b of blocks) {
        const run = (text: string, extra: object = {}) => new TextRun({ text, language: 'lang' in b && b.lang ? { value: b.lang } : undefined, ...extra });
        if (b.type === 'heading') out.push(new Paragraph({ heading: HEADINGS[b.level - 1], children: [run(b.text)] }));
        else if (b.type === 'paragraph') {
          const extra = b.role === 'caption' ? { italics: true } : {};
          const runs = b.text.split('\n').map((t, i) => run(t, i ? { ...extra, break: 1 } : extra));
          out.push(new Paragraph({ children: runs, spacing: { after: 120 } }));
        } else if (b.type === 'list') {
          const ref = `list-${lists++}`;
          for (const item of b.items) {
            out.push(new Paragraph({ children: [run(item)], ...(b.ordered ? { numbering: { reference: ref, level: 0 } } : { bullet: { level: 0 } }) }));
          }
        } else if (b.type === 'table') {
          out.push(wordTable(b.grid, b.borderless), new Paragraph(''));
        } else if (b.type === 'columns') {
          out.push(await columnsTable(b, share, textTwips, render), new Paragraph(''));
        } else if (b.img) {
          // As large as in the original, but never wider than its column
          const maxW = (share * textTwips / 1440) * 96 - 8;
          const s = Math.min(scale, maxW / b.img.width);
          out.push(new Paragraph({
            children: [new ImageRun({ type: 'png', data: await png(b.img), transformation: { width: Math.round(b.img.width * s), height: Math.round(b.img.height * s) } })],
          }));
        }
      }
      return out;
    };

    const children = await render(page.blocks, 1);
    const start = pageNumberOf([...page.footer, ...page.header]);
    sections.push({
      properties: {
        page: {
          size: { orientation: landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT },
          ...(start ? { pageNumbers: { start } } : {}),
        },
      },
      headers: { default: new Header({ children: page.header.map((r) => marginParagraph(r, textTwips)) }) },
      footers: { default: new Footer({ children: page.footer.map((r) => marginParagraph(r, textTwips)) }) },
      children: children.length ? children : [new Paragraph('')],
    });
  }
  const doc = new Document({
    styles: { default: { document: { run: { font: 'Calibri', size: 22 } } } },
    numbering: {
      config: Array.from({ length: lists }, (_, i) => ({
        reference: `list-${i}`,
        levels: [{ level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.START, style: { paragraph: { indent: { left: 720, hanging: 360 } } } }],
      })),
    },
    sections: sections.length ? sections : [{ children: [new Paragraph('')] }],
  });
  return Packer.toBlob(doc);
}

/** Side-by-side blocks: one row without borders, a cell per column with its blocks. */
async function columnsTable(b: Extract<Block, { type: 'columns' }>, share: number, textTwips: number,
  render: (blocks: Block[], share: number) => Promise<Out[]>): Promise<Table> {
  const cells: TableCell[] = [];
  for (let i = 0; i < b.columns.length; i++) {
    const content = await render(b.columns[i], share * b.widths[i]);
    // Word wants every cell to end with a paragraph
    if (!content.length || content[content.length - 1] instanceof Table) content.push(new Paragraph(''));
    cells.push(new TableCell({
      width: { size: Math.round(b.widths[i] * 100), type: WidthType.PERCENTAGE },
      borders: { top: NONE, bottom: NONE, left: NONE, right: NONE },
      margins: { left: 60, right: 60 },
      children: content,
    }));
  }
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    columnWidths: b.widths.map((w) => Math.round(w * share * textTwips)),
    borders: NO_BORDERS,
    rows: [new TableRow({ children: cells })],
  });
}

const PAGE_RE = /^(page|seite|p\.)?\s*(\d{1,4})(\s*(of|von|\/)\s*(\d{1,4}))?$/i;

/** The page number printed in a header or footer, so Word can count on from it */
function pageNumberOf(rows: MarginRow[]): number | null {
  for (const r of rows) for (const p of r.pieces) {
    const m = p.text.trim().match(PAGE_RE);
    if (m) return Number(m[2]);
  }
  return null;
}

/** One header/footer row: left, centre and right pieces at tab stops; page numbers become fields. */
function marginParagraph(row: MarginRow, textTwips: number): Paragraph {
  const children: (string | Tab | (typeof PageNumber)[keyof typeof PageNumber])[] = [];
  // Only the stops this row uses: a long left text would otherwise jump past an unused centre stop
  const used = (['left', 'center', 'right'] as const).filter((a) => row.pieces.some((p) => p.align === a));
  const tabStops = used.filter((a) => a !== 'left')
    .map((a) => ({ type: a === 'center' ? TabStopType.CENTER : TabStopType.RIGHT, position: a === 'center' ? Math.round(textTwips / 2) : textTwips }));
  (['left', 'center', 'right'] as const).forEach((align) => {
    if (!used.includes(align)) return;
    if (align !== 'left') children.push(new Tab());
    row.pieces.filter((p) => p.align === align).forEach((p, k) => {
      if (k) children.push(' ');
      const m = p.text.trim().match(PAGE_RE);
      if (!m) children.push(p.text);
      else {
        if (m[1]) children.push(`${m[1]} `);
        children.push(PageNumber.CURRENT);
        if (m[3]) children.push(` ${m[4]} `, PageNumber.TOTAL_PAGES);
      }
    });
  });
  return new Paragraph({ tabStops, children: [new TextRun({ children, size: 18, color: '555555' })] });
}

function wordTable(g: TableGrid, borderless: boolean): Table {
  const border = borderless ? NONE : LINE;
  const widths = columnWidths(g);
  const rows: TableRow[] = [];
  for (let r = 0; r < g.rows; r++) {
    const cells = g.cells.filter((c) => c.row === r).sort((a, b) => a.col - b.col);
    if (!cells.length) continue;
    rows.push(new TableRow({
      tableHeader: r === 0 && cells.some((c) => c.header),
      children: cells.map((c) => new TableCell({
        columnSpan: c.colSpan > 1 ? c.colSpan : undefined,
        rowSpan: c.rowSpan > 1 ? c.rowSpan : undefined,
        width: { size: widths.slice(c.col, c.col + c.colSpan).reduce((a, b) => a + b, 0), type: WidthType.PERCENTAGE },
        borders: { top: border, bottom: border, left: border, right: border },
        children: (c.text ?? '').split('\n').map((t) => new Paragraph({ children: [new TextRun({ text: t, bold: c.header })] })),
      })),
    }));
  }
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, columnWidths: widths.map((w) => Math.round(w * 90)), rows });
}

/** Column widths in percent, from the single-column cells' boxes. */
function columnWidths(g: TableGrid): number[] {
  const w = Array<number>(g.cols).fill(0);
  for (const c of g.cells) if (c.colSpan === 1) w[c.col] = Math.max(w[c.col], c.x1 - c.x0);
  const total = w.reduce((a, b) => a + b, 0) || 1;
  return w.map((v) => Math.max(5, Math.round((v / total) * 100)));
}
