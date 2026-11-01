// SPDX-License-Identifier: GPL-3.0-or-later
// Document blocks → LaTeX: sections, lists, tables (tabular with merged cells), formulas as equations, pictures as
// files next to the .tex, one page of the original per page. Blocks side by side follow each other in reading order:
// a LaTeX source is for editing, and its own layout sets the columns.
import { babelName, documentFrame, escapeLatex, tabularLatex } from '../latex/write';
import { walk, type Block } from './assemble';
import type { Img } from './image';
import type { TableGrid } from './table';

export interface LatexResult {
  tex: string;
  /** Pictures the document includes, by file name (figure-1.png …) */
  figures: { name: string; img: Img }[];
}

const SECTIONS = ['\\section*', '\\subsection*', '\\subsubsection*'];

/** @param pages the blocks of each page, with the width of its image in pixels */
export function toLatex(pages: { blocks: Block[]; width: number }[]): LatexResult {
  const figures: LatexResult['figures'] = [];
  let tables = false;

  const render = (blocks: Block[]): string[] => {
    const out: string[] = [];
    for (const b of walk(blocks)) {
      if (b.type === 'heading') out.push(`${SECTIONS[Math.min(b.level, 3) - 1] ?? SECTIONS[0]}{${escapeLatex(b.text)}}`);
      else if (b.type === 'paragraph') {
        const text = b.text.split('\n').map(escapeLatex).join('\\\\\n');
        out.push(b.role === 'caption' ? `\\begin{center}\\itshape\n${text}\n\\end{center}` : text);
      } else if (b.type === 'list') {
        const env = b.ordered ? 'enumerate' : 'itemize';
        out.push([`\\begin{${env}}`, ...b.items.map((t) => `  \\item ${escapeLatex(t)}`), `\\end{${env}}`].join('\n'));
      } else if (b.type === 'table') {
        tables = true;
        out.push(tabular(b.grid, b.borderless));
      } else if (b.type !== 'image') {
        continue;
      } else if (b.latex) {
        out.push(`\\begin{equation*}\n  ${b.latex}${b.tag ? `\n  \\tag{${b.tag.replace(/[{}\\]/g, '')}}` : ''}\n\\end{equation*}`);
      } else if (b.img) {
        const name = `figure-${figures.length + 1}.png`;
        figures.push({ name, img: b.img });
        // As wide as in the original: the text width is about 76 % of an A4 page with 2.5 cm margins
        const w = Math.min(1, (b.box.x1 - b.box.x0) / pageWidth / 0.76);
        out.push(`\\begin{center}\n  \\includegraphics[width=${w.toFixed(2)}\\linewidth]{${name}}\n\\end{center}`);
      }
    }
    return out;
  };

  let pageWidth = 1;
  const body: string[] = [];
  pages.forEach((page, p) => {
    pageWidth = page.width;
    if (p) body.push('\\clearpage');
    body.push(...render(page.blocks));
  });

  // babel: the languages of the paragraphs, the most frequent one last (the main language)
  const counts = new Map<string, number>();
  for (const page of pages) for (const b of walk(page.blocks)) {
    const name = 'lang' in b ? babelName(b.lang) : undefined;
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const languages = [...counts].sort((a, b) => a[1] - b[1]).map(([n]) => n);
  const tex = documentFrame(body.join('\n\n'), { languages, graphics: figures.length > 0, tables });
  return { tex, figures };
}

/** A recognized table: cell text escaped, the header row bold */
function tabular(g: TableGrid, borderless: boolean): string {
  const header = (r: number, header?: boolean) => header || (r === 0 && g.source !== 'columns' && !borderless);
  return tabularLatex({
    shares: columnShares(g),
    rows: g.rows,
    ruled: !borderless,
    cells: g.cells.map((c) => {
      const text = (c.text ?? '').split('\n').map(escapeLatex).join(' \\newline ');
      return { row: c.row, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, content: text && header(c.row, c.header) ? `\\textbf{${text}}` : text };
    }),
  });
}

/** Column widths as shares of the table, from the single-column cells' boxes */
function columnShares(g: TableGrid): number[] {
  const w = Array<number>(g.cols).fill(0);
  for (const c of g.cells) if (c.colSpan === 1) w[c.col] = Math.max(w[c.col], c.x1 - c.x0);
  const min = Math.max(...w, 1) * 0.08;
  const total = w.reduce((a, b) => a + Math.max(b, min), 0) || 1;
  return w.map((v) => Math.max(v, min) / total);
}
