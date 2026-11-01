// SPDX-License-Identifier: GPL-3.0-or-later
// Word content (ooxml-pages/content) → LaTeX: headings by outline level, lists nested by level, tables with merged
// cells, footnotes, links, text formatting, equations (math/omml-latex.ts) and pictures as files next to the .tex.
// Word's look (fonts, colors, spacing, page layout) is left to LaTeX.
import { francAll } from 'franc-min';
import type { ContentBlock, ContentInline, ContentParagraph, ContentTable, ContentText, DocxContent } from 'ooxml-pages/content';
import { ommlToLatex } from '../math/omml-latex';
import { babelName, documentFrame, escapeLatex, tabularLatex } from './write';

export interface DocxLatex {
  tex: string;
  /** Pictures the document includes: file name → picture id in the content */
  pictures: { name: string; id: number }[];
  notes: string[];
}

const SECTIONS = ['\\section', '\\subsection', '\\subsubsection', '\\paragraph', '\\subparagraph'];

/** ISO 639-3 (franc) → the two-letter codes babelName knows */
const FRANC: Record<string, string> = {
  eng: 'en', deu: 'de', fra: 'fr', spa: 'es', ita: 'it', por: 'pt', nld: 'nl', pol: 'pl', swe: 'sv', dan: 'da',
  nob: 'no', ces: 'cs', hun: 'hu', ron: 'ro', fin: 'fi', tur: 'tr',
};

/** Outline level of a heading: from the paragraph or its style, or from a style named "Heading 2" (also in other languages) */
function outline(p: ContentParagraph): number | undefined {
  if (p.outlineLevel !== undefined) return p.outlineLevel;
  const m = (p.styleName ?? p.style ?? '').match(/^(heading|überschrift|titre|título|titolo|kop|nagłówek)\s*(\d)$/i);
  return m ? Number(m[2]) - 1 : undefined;
}

export function docxToLatex(content: DocxContent, pictureType: (id: number) => string): DocxLatex {
  const pictures: DocxLatex['pictures'] = [];
  const used = { tables: false, strike: false, graphics: false, boxes: 0 };
  // Bookmarks that links point to get a \label
  const anchors = new Set<string>();
  const collect = (blocks: ContentBlock[]) => {
    for (const b of blocks) {
      if (b.type === 'table') b.rows.forEach((r) => r.cells.forEach((c) => collect(c.blocks)));
      else for (const i of b.inlines) {
        if (i.kind === 'text' && i.anchor) anchors.add(i.anchor);
        if (i.kind === 'box') collect(i.blocks);
      }
    }
  };
  collect(content.blocks);

  const label = (name: string) => `\\label{${name.replace(/[^A-Za-z0-9:._-]/g, '-')}}`;

  const text = (t: ContentText): string => {
    let s = escapeLatex(t.caps ? t.text.toUpperCase() : t.text);
    if (!s.trim()) return s;
    // Spaces stay outside the commands, so "\textbf{word }next" does not lose them
    const lead = s.match(/^\s*/)![0], trail = s.match(/\s*$/)![0];
    s = s.trim();
    if (t.monospace) s = `\\texttt{${s}}`;
    if (t.smallCaps) s = `\\textsc{${s}}`;
    if (t.bold) s = `\\textbf{${s}}`;
    if (t.italic) s = `\\emph{${s}}`;
    if (t.underline && !t.href) s = `\\underline{${s}}`;
    if (t.strike) { s = `\\sout{${s}}`; used.strike = true; }
    if (t.script === 'super') s = `\\textsuperscript{${s}}`;
    if (t.script === 'sub') s = `\\textsubscript{${s}}`;
    if (t.href) s = `\\href{${t.href.replace(/[%#\\{}]/g, (c) => `\\${c}`)}}{${s}}`;
    else if (t.anchor) s = `\\hyperref[${t.anchor.replace(/[^A-Za-z0-9:._-]/g, '-')}]{${s}}`;
    return lead + s + trail;
  };

  const picture = (i: Extract<ContentInline, { kind: 'picture' }>): string => {
    const name = `picture-${pictures.length + 1}.${pictureType(i.id)}`;
    pictures.push({ name, id: i.id });
    used.graphics = true;
    // CSS px → cm, never wider than the text
    const cm = (i.width / 96) * 2.54;
    const width = cm > 15 ? '\\linewidth' : `${cm.toFixed(1)}cm`;
    return `\\includegraphics[width=${width}]{${name}}`;
  };

  /** A paragraph's inlines; boxes (text frames) are returned separately and follow the paragraph */
  const inlines = (list: ContentInline[], after: string[]): string => {
    let out = '';
    for (const i of list) {
      if (i.kind === 'text') out += text(i);
      else if (i.kind === 'tab') out += '\\quad ';
      else if (i.kind === 'break') out += i.type === 'page' ? '\n\\newpage\n' : out.trim() ? '\\\\\n' : '';
      else if (i.kind === 'math') {
        const tex = ommlToLatex(i.omml);
        if (tex) out += i.display ? `\n\\[\n${tex}\n\\]\n` : `$${tex}$`;
      } else if (i.kind === 'note') {
        const blocks = (i.note === 'footnote' ? content.footnotes : content.endnotes).get(i.id) ?? [];
        out += `\\footnote{${blocks.map((b) => (b.type === 'paragraph' ? inlines(b.inlines, []).trim() : '')).filter(Boolean).join('\\par ')}}`;
      } else if (i.kind === 'picture') out += picture(i);
      else if (i.kind === 'bookmark') { if (anchors.has(i.name)) out += label(i.name); }
      else if (i.kind === 'box') { used.boxes++; after.push(...render(i.blocks)); }
    }
    return out.replace(/(\\\\\n)+$/, '').replace(/^\s*\\\\\n/, '');
  };

  /** An equation alone in its paragraph, numbered "(1)" after a tab as Word does it, becomes a numbered display */
  const equation = (p: ContentParagraph, number?: string): string | null => {
    const parts = [...p.inlines, ...(number ? [{ kind: 'text', text: number } as ContentText] : [])].filter((i) => !(i.kind === 'tab' || i.kind === 'bookmark' || (i.kind === 'text' && !i.text.trim())));
    const math = parts.filter((i) => i.kind === 'math');
    if (math.length !== 1) return null;
    const rest = parts.filter((i) => i.kind !== 'math');
    const tag = rest.length === 1 && rest[0].kind === 'text' ? rest[0].text.trim().match(/^\((\S{1,12})\)$/)?.[1] : undefined;
    if (rest.length && !tag) return null;
    const m = math[0] as Extract<ContentInline, { kind: 'math' }>;
    if (!m.display && !tag && p.align !== 'center') return null;
    const tex = ommlToLatex(m.omml);
    return `\\begin{equation*}\n  ${tex}${tag ? `\n  \\tag{${tag.replace(/[{}\\]/g, '')}}` : ''}\n\\end{equation*}`;
  };

  /** An equation numbered in a table row without borders: the formula in one cell, "(1)" in the other */
  const numberedEquation = (t: ContentTable): string | null => {
    const cells = t.rows.length === 1 ? t.rows[0].cells : [];
    const [formula, number] = cells.map((c) => (c.blocks.length === 1 && c.blocks[0].type === 'paragraph' ? c.blocks[0] : null));
    if (cells.length !== 2 || !formula || !number) return null;
    const text = number.inlines.map((i) => (i.kind === 'text' ? i.text : '')).join('').trim();
    return /^\(\S{1,12}\)$/.test(text) ? equation(formula, text) : null;
  };

  const paragraph = (p: ContentParagraph): string[] => {
    const after: string[] = [];
    const eq = equation(p);
    if (eq) return [eq];
    const body = inlines(p.inlines, after).trim();
    const style = (p.styleName ?? '').toLowerCase();
    const level = outline(p);
    let out: string | null = null;
    if (!body) out = null;
    else if (style === 'title') out = `{\\centering\\LARGE\\bfseries ${body}\\par}\n\\bigskip`;
    else if (style === 'subtitle') out = `{\\centering\\Large ${body}\\par}\n\\bigskip`;
    else if (level !== undefined && level < SECTIONS.length) {
      // A heading Word numbers itself is numbered by LaTeX too; otherwise its number (if any) is part of the text
      const cmd = SECTIONS[level] + (p.list ? '' : '*');
      out = `${cmd}{${body.replace(/\\\\\n/g, ' ')}}`;
    } else if (inCell) out = body;
    else if (/^(quote|intense quote|zitat|intensives zitat)$/.test(style)) out = `\\begin{quote}\n${body}\n\\end{quote}`;
    else if (p.align === 'center') out = `\\begin{center}\n${body}\n\\end{center}`;
    else if (p.align === 'right') out = `\\begin{flushright}\n${body}\n\\end{flushright}`;
    else out = body;
    return [...(out ? [out] : []), ...after];
  };

  /** Depth of table cells the writing is in: no centering or quote environments there */
  let inCell = 0;

  const table = (t: ContentTable): string => {
    used.tables = true;
    const total = t.columns.reduce((a, b) => a + b, 0) || 1;
    return tabularLatex({
      shares: t.columns.map((w) => w / total),
      rows: t.rows.length,
      ruled: true,
      cells: t.rows.flatMap((row, r) => row.cells.map((c) => {
        // Paragraphs of a cell are separated by \par (a line break after a list or table would have no line to end)
        inCell++;
        const inner = render(c.blocks).join(' \\par ').replace(/\n+/g, ' ');
        inCell--;
        return { row: r, col: c.col, rowSpan: c.rowSpan, colSpan: c.colSpan, content: row.header && inner ? `{\\bfseries ${inner}}` : inner };
      })),
    });
  };

  /** Blocks; list paragraphs that follow each other become one nested list */
  function render(blocks: ContentBlock[]): string[] {
    const out: string[] = [];
    let list: { env: string; level: number }[] = [];
    let items: string[] = [];
    const close = (to: number) => {
      while (list.length > to) items.push(`${'  '.repeat(list.length - 1)}\\end{${list.pop()!.env}}`);
      if (!list.length && items.length) { out.push(items.join('\n')); items = []; }
    };
    for (const b of blocks) {
      if (b.type === 'paragraph' && b.list && outline(b) === undefined) {
        const env = b.list.ordered ? 'enumerate' : 'itemize';
        const level = b.list.level;
        // Deeper levels open lists inside the current item; LaTeX nests at most four deep
        while (list.length && (list[list.length - 1].level > level || (list[list.length - 1].level === level && list[list.length - 1].env !== env))) close(list.length - 1);
        if (!list.length || list[list.length - 1].level < level) {
          if (list.length < 4) {
            items.push(`${'  '.repeat(list.length)}\\begin{${env}}`);
            list.push({ env, level });
          }
        }
        const after: string[] = [];
        const body = inlines(b.inlines, after).trim();
        items.push(`${'  '.repeat(list.length)}\\item ${body}`);
        items.push(...after);
        continue;
      }
      close(0);
      if (b.type === 'table') out.push(numberedEquation(b) ?? table(b));
      else out.push(...paragraph(b));
    }
    close(0);
    return out;
  }

  const body = render(content.blocks).join('\n\n');

  // Main language for hyphenation, from the text itself (Word's language tags are often just the default)
  const sample = body.replace(/\\[A-Za-z]+|[{}$\\]/g, ' ').slice(0, 20000);
  const lang = francAll(sample, { only: Object.keys(FRANC), minLength: 20 })[0]?.[0];
  const main = lang && lang !== 'und' ? babelName(FRANC[lang]) : undefined;

  let tex = documentFrame(body, { languages: main ? [main] : [], graphics: used.graphics, tables: used.tables });
  if (used.strike) tex = tex.replace('\\usepackage{amsmath,amssymb}', '\\usepackage{amsmath,amssymb}\n\\usepackage[normalem]{ulem}');
  const notes: string[] = [];
  if (pictures.length) notes.push(`${pictures.length === 1 ? 'The picture comes as a file' : `The ${pictures.length} pictures come as files`} next to the .tex file, in one ZIP.`);
  if (used.boxes) notes.push(`${used.boxes === 1 ? 'A text box follows' : `${used.boxes} text boxes follow`} the paragraph it is anchored to.`);
  return { tex, pictures, notes };
}
