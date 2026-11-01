// SPDX-License-Identifier: GPL-3.0-or-later
// LaTeX → Word, through unified-latex's syntax tree: sections (numbered as LaTeX numbers them), lists, tables with
// merged cells, footnotes, links, text formatting, title block, theorems, verbatim text, and formulas as Word
// equations (math/omml.ts, with the document's own macros). The document's own text macros are expanded; what draws
// (TikZ) or comes from other files (pictures, \input, bibliographies) becomes a short note in brackets.
import { getParser, parse } from '@unified-latex/unified-latex-util-parse';
import type * as Ast from '@unified-latex/unified-latex-types';
import {
  AlignmentType, BorderStyle, Document, ExternalHyperlink, FootnoteReferenceRun, HeadingLevel, LevelFormat, Packer,
  Paragraph, Table, TableCell, TableRow, TextRun, WidthType, type IBorderOptions, type ParagraphChild,
} from 'docx';
import { latexToOmml } from '../math/omml';
import { ommlChild, wordEquation } from '../math/word';

export interface LatexDocx {
  docx: Blob;
  notes: string[];
}

interface Style {
  bold?: boolean;
  italics?: boolean;
  underline?: boolean;
  strike?: boolean;
  smallCaps?: boolean;
  mono?: boolean;
  superScript?: boolean;
  subScript?: boolean;
}

interface Macro {
  args: number;
  /** Default of an optional first argument */
  optional?: string;
  body: string;
}

const HEADINGS = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5];
/** Sectioning commands → depth (chapter is the top when a document has chapters) */
const SECTIONS: Record<string, number> = { part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5 };
const LINE: IBorderOptions = { style: BorderStyle.SINGLE, size: 4, color: '808080' };

/** Text signs LaTeX writes as commands */
const SIGNS: Record<string, string> = {
  ldots: '…', dots: '…', textellipsis: '…', LaTeX: 'LaTeX', TeX: 'TeX', LaTeXe: 'LaTeX2ε', textendash: '–', textemdash: '—',
  textbackslash: '\\', textasciitilde: '~', textasciicircum: '^', textbar: '|', textless: '<', textgreater: '>',
  textdegree: '°', textregistered: '®', texttrademark: '™', textcopyright: '©', copyright: '©', euro: '€', texteuro: '€',
  textbullet: '•', textperiodcentered: '·', textquotedbl: '"', textquoteleft: '‘', textquoteright: '’', S: '§', P: '¶',
  ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø', aa: 'å', AA: 'Å', l: 'ł', L: 'Ł', i: 'ı', dag: '†', ddag: '‡',
  textmu: 'µ', textpm: '±', texttimes: '×', quad: ' ', qquad: '  ', enspace: ' ', thinspace: ' ',
  ',': ' ', ';': ' ', ':': ' ', ' ': ' ', '&': '&', '%': '%', $: '$', '#': '#', _: '_', '{': '{', '}': '}',
  '-': '', '/': '', '@': '', slash: '/', textunderscore: '_', checkmark: '✓',
};

/** Accent commands → combining marks */
const ACCENTS: Record<string, string> = {
  '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃', '=': '̄', '.': '̇', u: '̆',
  v: '̌', H: '̋', c: '̧', k: '̨', r: '̊', b: '̱', d: '̣',
};

const STYLES: Record<string, Style> = {
  textbf: { bold: true }, bfseries: { bold: true }, bf: { bold: true }, textit: { italics: true }, itshape: { italics: true },
  it: { italics: true }, emph: { italics: true }, em: { italics: true }, textsl: { italics: true }, slshape: { italics: true },
  texttt: { mono: true }, ttfamily: { mono: true }, tt: { mono: true }, underline: { underline: true }, uline: { underline: true },
  textsc: { smallCaps: true }, scshape: { smallCaps: true }, sout: { strike: true }, st: { strike: true },
  textsuperscript: { superScript: true }, textsubscript: { subScript: true },
  textrm: {}, textsf: {}, textup: {}, textnormal: {}, textmd: {}, mbox: {}, text: {}, hbox: {}, makebox: {}, fbox: {},
};

/** Environments for theorems and the like: a bold label in front of the content */
const THEOREMS: Record<string, string> = {
  theorem: 'Theorem', lemma: 'Lemma', proposition: 'Proposition', corollary: 'Corollary', definition: 'Definition',
  example: 'Example', remark: 'Remark', note: 'Note', proof: 'Proof', claim: 'Claim', conjecture: 'Conjecture',
  exercise: 'Exercise', satz: 'Satz', beweis: 'Beweis', beispiel: 'Beispiel', bemerkung: 'Bemerkung',
};

const MATH_ENVS = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'flalign', 'flalign*', 'alignat', 'alignat*', 'eqnarray', 'eqnarray*', 'displaymath', 'math']);
const DRAWINGS = new Set(['tikzpicture', 'pgfpicture', 'picture', 'circuitikz', 'forest', 'axis']);
const VERBATIM = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'Verbatim', 'alltt', 'comment']);
/** Commands with arguments that print nothing */
const SILENT = new Set([
  'documentclass', 'usepackage', 'RequirePackage', 'label', 'vspace', 'hspace', 'vspace*', 'hspace*', 'setlength', 'addtolength',
  'pagestyle', 'thispagestyle', 'pagenumbering', 'setcounter', 'addtocounter', 'geometry', 'hypersetup', 'bibliographystyle',
  'newtheorem', 'theoremstyle', 'graphicspath', 'definecolor', 'color', 'lstset', 'setlist', 'renewenvironment', 'newenvironment',
  'numberwithin', 'DeclareMathOperator', 'DeclareMathOperator*', 'newcommand', 'renewcommand', 'providecommand', 'def',
  'let', 'newcounter', 'centering', 'raggedright', 'raggedleft', 'noindent', 'indent', 'small', 'footnotesize', 'scriptsize',
  'tiny', 'large', 'Large', 'LARGE', 'huge', 'Huge', 'normalsize', 'smallskip', 'medskip', 'bigskip', 'vfill', 'hfill',
  'tableofcontents', 'listoffigures', 'listoftables', 'protect', 'phantomsection', 'addcontentsline',
  'index', 'nocite', 'appendix', 'frontmatter', 'mainmatter', 'backmatter', 'linewidth', 'textwidth', 'selectlanguage',
  'hline', 'cline', 'toprule', 'midrule', 'bottomrule', 'cmidrule', 'rowcolor', 'cellcolor', 'arraystretch',
  'FloatBarrier', 'restoregeometry', 'newgeometry', 'onehalfspacing', 'doublespacing', 'singlespacing',
  'linespread', 'sloppy', 'fussy', 'nopagebreak', 'allowbreak', 'relax',
]);

const isGroup = (n: Ast.Node | undefined): n is Ast.Group => n?.type === 'group';
/** Macros of common packages the parser does not know: their arguments */
const SIGNATURES: Record<string, { signature: string }> = {
  multirow: { signature: 'o m o m o m' }, sout: { signature: 'm' }, uline: { signature: 'm' }, st: { signature: 'm' },
  textcolor: { signature: 'o m m' }, colorbox: { signature: 'o m m' }, cref: { signature: 'm' }, Cref: { signature: 'm' },
  autoref: { signature: 'm' }, eqref: { signature: 'm' }, autocite: { signature: 'o o m' }, parencite: { signature: 'o o m' },
  textcite: { signature: 'o o m' }, citep: { signature: 'o o m' }, citet: { signature: 'o o m' }, highlight: { signature: 'm' },
  subfile: { signature: 'm' }, printbibliography: { signature: 'o' }, checkmark: { signature: '' },
};
const argContent = (m: Ast.Macro, i: number): Ast.Node[] => m.args?.[i]?.content ?? [];
/** The arguments a macro was given in braces or brackets, in order, without the empty ones unified-latex adds */
const givenArgs = (m: Ast.Macro) => (m.args ?? []).filter((a) => a.openMark || a.content.length);

export async function latexToDocx(input: string): Promise<LatexDocx> {
  // Windows line ends: the parser would take \r\n for two line ends, a new paragraph
  const source = input.replace(/\r\n?/g, '\n');
  const notes = new Set<string>();
  const macros = new Map<string, Macro>();
  const mathMacros: Record<string, string> = {};
  /** Text the positions of the nodes being walked point into: the file, or the expansion of a macro */
  let src = source;
  /** The source text of nodes; a macro's position leaves out its arguments, so their ends count too */
  const end = (n: Ast.Node): number => {
    let e = n.position?.end.offset ?? -1;
    if (n.type === 'macro') for (const a of n.args ?? []) for (const c of a.content) e = Math.max(e, end(c) + (a.closeMark ? a.closeMark.length : 0));
    return e;
  };
  const raw = (n: Ast.Node | Ast.Node[]): string => {
    const nodes = Array.isArray(n) ? n : [n];
    if (!nodes.length) return '';
    const start = nodes[0].position?.start.offset;
    const stop = Math.max(...nodes.map(end));
    return start !== undefined && stop >= start ? src.slice(start, stop) : '';
  };
  const rawArg = (a: Ast.Argument | undefined) => (a ? raw(a.content) : '');
  /** A line break \\ */
  const isBreak = (n: Ast.Node) => n.type === 'macro' && n.content === '\\';
  /** The formula inside $…$, \(…\), \[…\], $$…$$ or \begin{env}…\end{env} */
  const mathSource = (n: Ast.Node) => raw(n)
    .replace(/^\\begin\{alignat\*?\}\{\d+\}/, '').replace(/^\\begin\{[^{}]*\}/, '').replace(/\\end\{[^{}]*\}$/, '')
    .replace(/^(\$\$?|\\\(|\\\[)/, '').replace(/(\$\$?|\\\)|\\\])$/, '');

  let root = parse(source);
  // Preamble: macros, title, author, date
  const meta: { title?: Ast.Node[]; author?: Ast.Node[]; date?: Ast.Node[] } = {};
  let hasChapters = false;
  /** Keys of \bibitem in order: \cite gives their numbers */
  const bibitems: string[] = [];
  const scan = (nodes: Ast.Node[]) => {
    nodes.forEach((n, i) => {
      if (n.type === 'macro') {
        if (['newcommand', 'renewcommand', 'providecommand', 'newcommand*', 'renewcommand*'].includes(n.content)) defineMacro(n);
        else if (n.content === 'def') defineDef(nodes, i);
        else if (n.content === 'DeclareMathOperator') {
          const [name, body] = givenArgs(n).map(rawArg).filter((a) => a !== '');
          if (name && body !== undefined) mathMacros[name.trim()] = `\\operatorname{${body}}`;
        } else if (n.content === 'title' || n.content === 'author' || n.content === 'date') meta[n.content] = argContent(n, n.args!.length - 1);
        else if (n.content === 'chapter') hasChapters = true;
        else if (n.content === 'bibitem') {
          const key = rawArg(givenArgs(n).find((a) => a.openMark === '{')).trim();
          if (key && !bibitems.includes(key)) bibitems.push(key);
        }
      }
      if ('content' in n && Array.isArray(n.content)) scan(n.content);
    });
  };
  /** \newcommand{\name}[count][default]{body}: unified-latex gives star, name, count, default and body as arguments */
  function defineMacro(m: Ast.Macro) {
    const args = m.args ?? [];
    const name = rawArg(args[2]).trim();
    if (!/^\\[A-Za-z@]+$/.test(name)) return;
    const count = Number(rawArg(args[3]).trim()) || 0;
    const optional = args[4]?.openMark === '[' ? rawArg(args[4]) : undefined;
    const body = rawArg(args[5]);
    macros.set(name.slice(1), { args: count, optional, body });
    mathMacros[name] = body;
  }
  function defineDef(siblings: Ast.Node[], i: number) {
    const name = siblings[i + 1];
    const body = siblings.slice(i + 2).find((n) => n.type !== 'whitespace');
    if (name?.type === 'macro' && isGroup(body)) {
      macros.set(name.content, { args: 0, body: raw(body.content) });
      mathMacros[`\\${name.content}`] = raw(body.content);
    }
  }
  scan(root.content);
  // Parsed again, now knowing how many arguments the document's own macros and some common package macros take
  const signatures: Record<string, { signature: string }> = { ...SIGNATURES };
  for (const [name, def] of macros) signatures[name] = { signature: `${def.optional !== undefined ? 'o ' : ''}${'m '.repeat(Math.max(0, def.args - (def.optional !== undefined ? 1 : 0)))}`.trim() };
  const parser = getParser({ macros: signatures });
  root = parser.parse(source);
  scan(root.content);

  const docEnv = findEnv(root.content, 'document');
  const body = docEnv ? docEnv.content : root.content;

  // ---------- Output state ----------
  const out: (Paragraph | Table)[] = [];
  const footnotes: Record<string, { children: Paragraph[] }> = {};
  let footnoteId = 1;
  /** Numbering references of the numbered lists */
  const lists: string[] = [];
  let listDepth = 0;
  const counters = [0, 0, 0, 0, 0, 0];
  let equationNo = 0, figureNo = 0, tableNo = 0;
  const labels = new Map<string, string>();
  let lastNumber = '';

  interface Para { runs: ParagraphChild[]; align?: (typeof AlignmentType)[keyof typeof AlignmentType]; indent?: number; heading?: (typeof HeadingLevel)[keyof typeof HeadingLevel]; list?: { reference: string; level: number; bullet: boolean }; style?: string }
  let para: Para = { runs: [] };
  let target: (Paragraph | Table)[] = out;
  /** Alignment and indent of the environment the walk is in (center, quote …) */
  const ctx = { align: undefined as Para['align'], indent: 0 };

  // Text is collected while the style stays the same: the parser hands out ``, -- and the like sign by sign
  let pending = { text: '', style: {} as Style };
  const emit = () => {
    const t = ligatures(pending.text);
    pending.text = '';
    if (!t) return;
    const s = pending.style;
    para.runs.push(new TextRun({
      text: t, bold: s.bold, italics: s.italics, underline: s.underline ? {} : undefined, strike: s.strike, smallCaps: s.smallCaps,
      superScript: s.superScript, subScript: s.subScript, font: s.mono ? 'Courier New' : undefined,
    }));
  };
  const text = (t: string, s: Style) => {
    if (!t) return;
    // Spaces at the start of a paragraph come from line ends in the source
    if (!para.runs.length && !pending.text) t = t.replace(/^\s+/, '');
    if (!t) return;
    if (pending.text && !sameStyle(pending.style, s)) emit();
    if (!pending.text) pending.style = s;
    pending.text += t;
  };
  const push = (child: ParagraphChild) => {
    emit();
    para.runs.push(child);
  };

  const flush = () => {
    pending.text = pending.text.replace(/\s+$/, '');
    emit();
    const runs = para.runs;
    if (runs.length || para.heading) {
      target.push(new Paragraph({
        children: runs,
        heading: para.heading,
        style: para.style,
        alignment: para.align ?? ctx.align,
        indent: (para.indent ?? ctx.indent) ? { left: para.indent ?? ctx.indent } : undefined,
        ...(para.list ? (para.list.bullet ? { bullet: { level: para.list.level } } : { numbering: { reference: para.list.reference, level: para.list.level } }) : {}),
        spacing: { after: 120 },
      }));
    }
    para = { runs: [] };
  };
  const note = (t: string) => {
    notes.add(t);
  };
  const omml = (latex: string, display: boolean) => latexToOmml(latex, { display, macros: mathMacros });

  const equation = (latex: string, numbered: boolean) => {
    flush();
    const label = latex.match(/\\label\{([^{}]*)\}/)?.[1];
    const tag = latex.match(/\\tag\*?\{([^{}]*)\}/)?.[1];
    const number = tag ?? (numbered && !/\\(nonumber|notag)\b/.test(latex) ? String(++equationNo) : undefined);
    if (label && number) labels.set(label, number);
    const m = omml(latex, true);
    if (!m) {
      // temml could not read it: the source as text, so nothing is lost
      target.push(new Paragraph({ children: [new TextRun({ text: latex.trim(), font: 'Courier New' })], alignment: AlignmentType.CENTER }));
      note('Some formulas could not be converted and are kept as LaTeX text.');
      return;
    }
    target.push(wordEquation(m, number));
  };

  /** Lines of an align-like environment as one aligned formula */
  const alignBody = (env: string, content: string) => {
    const name = env.replace('*', '');
    if (name === 'align' || name === 'flalign' || name === 'alignat' || name === 'eqnarray') return `\\begin{aligned}${content}\\end{aligned}`;
    if (name === 'gather') return `\\begin{gathered}${content}\\end{gathered}`;
    if (name === 'multline') return `\\begin{gathered}${content}\\end{gathered}`;
    return content;
  };

  // ---------- Walking the tree ----------

  /** Nodes rendered as paragraphs of their own (a footnote, a table cell), outside the current paragraph */
  const blocks = (nodes: Ast.Node[], depth: number, align?: Para['align']): (Paragraph | Table)[] => {
    emit();
    const saved = { para, target, pending, align: ctx.align, indent: ctx.indent };
    const children: (Paragraph | Table)[] = [];
    para = { runs: [] };
    pending = { text: '', style: {} };
    target = children;
    ctx.align = align;
    ctx.indent = 0;
    walk(nodes, {}, depth);
    flush();
    ({ para, target, pending } = saved);
    ctx.align = saved.align;
    ctx.indent = saved.indent;
    return children;
  };

  /** Expands a macro of the document's own: its body with the arguments put in, parsed again */
  const expand = (m: Ast.Macro, depth: number): { nodes: Ast.Node[]; source: string } | null => {
    const def = macros.get(m.content);
    if (!def || depth > 20) return null;
    // The arguments as the parser attached them (it knows the signature); a missing optional one takes its default
    const args = (m.args ?? []).map((a) => (a.openMark ? raw(a.content) : undefined));
    if (def.optional !== undefined) args[0] ??= def.optional;
    const body = def.body.replace(/#(\d)/g, (_, d) => args[Number(d) - 1] ?? '');
    return { nodes: parser.parse(body).content, source: body };
  };

  const walk = (nodes: Ast.Node[], style: Style, depth = 0): void => {
    let local = style;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      switch (n.type) {
        case 'string':
          text(ligatures(n.content), local);
          break;
        case 'whitespace':
          text(' ', local);
          break;
        case 'parbreak':
          flush();
          break;
        case 'comment':
          break;
        case 'group':
          walk(n.content, local, depth);
          break;
        case 'inlinemath': {
          const m = omml(mathSource(n), false);
          if (m) push(ommlChild(m));
          else text(raw(n), { mono: true });
          break;
        }
        case 'displaymath':
          equation(mathSource(n), false);
          break;
        case 'verb':
          text(n.content, { ...local, mono: true });
          break;
        case 'verbatim':
          flush();
          for (const line of n.content.replace(/^\n/, '').split('\n')) target.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Courier New', size: 20 })], spacing: { after: 0 } }));
          break;
        case 'environment':
        case 'mathenv':
          environment(n, local, depth);
          break;
        case 'macro': {
          const own = expand(n, depth);
          if (own) {
            // The expansion's positions point into its own text
            const outer = src;
            src = own.source;
            walk(own.nodes, local, depth + 1);
            src = outer;
            break;
          }
          // Switches like \bfseries change the rest of the group
          const sw = ['bfseries', 'bf', 'itshape', 'it', 'em', 'slshape', 'ttfamily', 'tt', 'scshape'].includes(n.content);
          if (sw) local = { ...local, ...STYLES[n.content] };
          else if (n.content in ACCENTS && !givenArgs(n).length && nodes[i + 1]?.type === 'string') {
            // \"u: the letter is the start of the next piece of text
            const next = nodes[++i] as Ast.String;
            text((next.content[0] + ACCENTS[n.content]).normalize('NFC') + next.content.slice(1), local);
          } else if (isBreak(n)) push(new TextRun({ break: 1 }));
          else macro(n, local, depth);
          // TeX drops the space after a command word (\ss e is "ße"); \LaTeX{} keeps it with the braces
          if (/^[A-Za-z]+$/.test(n.content) && !givenArgs(n).length && nodes[i + 1]?.type === 'whitespace') i++;
          break;
        }
      }
    }
  };

  const ref = (key: string) => labels.get(key) ?? '??';

  const macro = (m: Ast.Macro, style: Style, depth: number) => {
    const name = m.content;
    const args = givenArgs(m);
    const last = args[args.length - 1];
    if (name in SECTIONS) {
      flush();
      const starred = !!m.args?.[0]?.content.length || raw(m).startsWith(`\\${name}*`);
      let level = SECTIONS[name] - (hasChapters ? 0 : 1);
      if (name === 'part') level = 0;
      let prefix = '';
      if (!starred && name !== 'part' && SECTIONS[name] <= 3) {
        const d = SECTIONS[name] - (hasChapters ? 0 : 1);
        counters[d]++;
        for (let k = d + 1; k < counters.length; k++) counters[k] = 0;
        lastNumber = counters.slice(hasChapters ? 0 : 0, d + 1).filter((_, k) => k >= 0).join('.');
        prefix = `${lastNumber} `;
      }
      para.heading = HEADINGS[Math.max(0, Math.min(level, HEADINGS.length - 1))];
      if (prefix) text(prefix, {});
      walk(last?.content ?? [], {}, depth);
      flush();
      return;
    }
    if (name in STYLES) {
      walk(last?.content ?? [], { ...style, ...STYLES[name] }, depth);
      return;
    }
    if (name in SIGNS && !args.length) {
      text(SIGNS[name], style);
      return;
    }
    if (name in ACCENTS) {
      const t = raw(last?.content ?? []).replace(/^\\/, '') || '';
      text((t ? t[0] + ACCENTS[name] + t.slice(1) : ACCENTS[name]).normalize('NFC'), style);
      return;
    }
    switch (name) {
      case '\\':
      case 'newline':
      case 'linebreak':
        push(new TextRun({ break: 1 }));
        return;
      case 'par':
        flush();
        return;
      case 'newpage':
      case 'clearpage':
      case 'cleardoublepage':
      case 'pagebreak':
        flush();
        target.push(new Paragraph({ pageBreakBefore: true, children: [] }));
        return;
      case 'today':
        text(new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }), style);
        return;
      case 'footnote': {
        const id = footnoteId++;
        const children = blocks(last?.content ?? [], depth) as Paragraph[];
        footnotes[id] = { children: children.length ? children : [new Paragraph('')] };
        push(new FootnoteReferenceRun(id));
        return;
      }
      case 'href': {
        const url = rawArg(args[0]).trim();
        emit();
        const saved = para.runs;
        para.runs = [];
        walk(args[1]?.content ?? [], style, depth);
        emit();
        const runs = para.runs;
        para.runs = saved;
        if (/^(https?:|mailto:)/i.test(url)) para.runs.push(new ExternalHyperlink({ link: url, children: runs.filter((r): r is TextRun => r instanceof TextRun) }));
        else para.runs.push(...runs);
        return;
      }
      case 'url':
      case 'path': {
        const url = rawArg(last).trim();
        if (/^(https?:|mailto:)/i.test(url)) push(new ExternalHyperlink({ link: url, children: [new TextRun({ text: url, style: 'Hyperlink' })] }));
        else text(url, { ...style, mono: true });
        return;
      }
      case 'ref':
      case 'autoref':
      case 'cref':
      case 'Cref':
      case 'pageref':
        text(rawArg(last).split(',').map((k) => ref(k.trim())).join(', '), style);
        return;
      case 'eqref':
        text(`(${ref(rawArg(last).trim())})`, style);
        return;
      case 'label': {
        // A label after a section or caption refers to its number
        if (lastNumber) labels.set(rawArg(last).trim(), lastNumber);
        return;
      }
      case 'cite':
      case 'citep':
      case 'citet':
      case 'parencite':
      case 'textcite':
      case 'autocite':
        // Numbered as in the document's own bibliography; keys of an external one stay as they are
        text(`[${rawArg(last).split(',').map((k) => { const key = k.trim(); const n = bibitems.indexOf(key); return n >= 0 ? String(n + 1) : key; }).join(', ')}]`, style);
        return;
      case 'maketitle':
        titleBlock();
        return;
      case 'caption': {
        flush();
        para.style = 'Caption';
        walk(last?.content ?? [], { italics: true }, depth);
        flush();
        return;
      }
      case 'includegraphics':
        flush();
        text(`[Picture: ${rawArg(last).trim()}]`, { italics: true });
        flush();
        note('Pictures are not part of the .tex file; their places are marked in the text.');
        return;
      case 'input':
      case 'include':
      case 'subfile':
        text(`[File: ${rawArg(last).trim()}]`, { italics: true });
        note('Files the document includes with \\input or \\include are not part of the .tex file; their places are marked in the text.');
        return;
      case 'bibliography':
      case 'printbibliography':
        note('The bibliography comes from a separate file and is left out.');
        return;
      case 'item':
        return; // handled by the list
      case 'multicolumn':
      case 'multirow':
        walk(last?.content ?? [], style, depth);
        return;
      case 'textcolor':
      case 'colorbox':
      case 'highlight':
        walk(last?.content ?? [], style, depth);
        return;
      case 'thanks':
        return;
      case 'and':
        pending.text = pending.text.replace(/\s+$/, '');
        text(', ', style);
        return;
    }
    if (SILENT.has(name)) return;
    // Anything else: its arguments in braces, so no text is lost
    for (const a of args) if (a.openMark === '{') walk(a.content, style, depth);
  };

  const titleBlock = () => {
    flush();
    if (meta.title) {
      para.heading = HeadingLevel.TITLE;
      walk(meta.title, {}, 0);
      flush();
    }
    if (meta.author) {
      para.align = AlignmentType.CENTER;
      walk(meta.author, {}, 0);
      flush();
    }
    const date = meta.date ? raw(meta.date).trim() : '\\today';
    if (date) {
      para.align = AlignmentType.CENTER;
      walk(meta.date ?? parse('\\today').content, {}, 0);
      flush();
    }
  };

  const environment = (e: Ast.Environment, style: Style, depth: number) => {
    const name = typeof e.env === 'string' ? e.env : (e.env as Ast.String).content;
    if (MATH_ENVS.has(name) || e.type === 'mathenv') {
      equation(alignBody(name, mathSource(e)),!name.endsWith('*') && name !== 'displaymath' && name !== 'math');
      return;
    }
    if (name === 'itemize' || name === 'enumerate' || name === 'description') {
      flush();
      const ordered = name === 'enumerate';
      // Each numbered list has a numbering of its own, so it starts at 1
      const reference = ordered ? `list-${lists.length}` : '';
      if (ordered) lists.push(reference);
      const level = Math.min(listDepth++, 8);
      // \item splits the content; an item's text runs until the next \item
      for (const item of splitItems(e.content)) {
        flush();
        if (name === 'description') {
          if (item.label) walk(item.label, { ...style, bold: true }, depth);
          text(' ', style);
        } else if (item.label) {
          // \item[label]: the label instead of the bullet or number
          para.indent = 360 * (level + 1);
          walk(item.label, style, depth);
          text(' ', style);
        } else para.list = { reference, level, bullet: !ordered };
        walk(item.body, style, depth);
        flush();
      }
      listDepth--;
      return;
    }
    if (name === 'center' || name === 'flushright' || name === 'flushleft') {
      flush();
      const saved = ctx.align;
      ctx.align = name === 'center' ? AlignmentType.CENTER : name === 'flushright' ? AlignmentType.RIGHT : AlignmentType.LEFT;
      walk(e.content, style, depth);
      flush();
      ctx.align = saved;
      return;
    }
    if (name === 'quote' || name === 'quotation' || name === 'verse' || name === 'abstract') {
      flush();
      if (name === 'abstract') {
        para.align = AlignmentType.CENTER;
        text('Abstract', { bold: true });
        flush();
      }
      ctx.indent += 720;
      walk(e.content, style, depth);
      flush();
      ctx.indent -= 720;
      return;
    }
    if (name === 'tabular' || name === 'tabular*' || name === 'tabularx' || name === 'longtable' || name === 'tabu' || name === 'tblr') {
      flush();
      target.push(table(e, depth), new Paragraph(''));
      return;
    }
    if (name === 'figure' || name === 'figure*' || name === 'table' || name === 'table*' || name === 'wrapfigure') {
      flush();
      if (name.startsWith('figure') || name === 'wrapfigure') figureNo++;
      else tableNo++;
      const number = String(name.startsWith('table') ? tableNo : figureNo);
      const saved = lastNumber;
      lastNumber = number;
      // The caption gets "Figure 1:" in front, as LaTeX writes it
      const captioned = e.content.map((n) => (n.type === 'macro' && n.content === 'caption' ? { ...n, args: [...(n.args ?? []).slice(0, -1), { type: 'argument', openMark: '{', closeMark: '}', content: [{ type: 'string', content: `${name.startsWith('table') ? 'Table' : 'Figure'} ${number}: ` } as Ast.String, ...argContent(n, n.args!.length - 1)] } as Ast.Argument] } : n));
      const savedAlign = ctx.align;
      ctx.align = AlignmentType.CENTER;
      walk(captioned, style, depth);
      flush();
      ctx.align = savedAlign;
      lastNumber = saved;
      return;
    }
    if (DRAWINGS.has(name)) {
      flush();
      text('[Drawing]', { italics: true });
      flush();
      note('Drawings (TikZ and the like) cannot be converted; their places are marked in the text.');
      return;
    }
    if (VERBATIM.has(name)) {
      flush();
      for (const line of mathSource(e).replace(/^\[[^\]\n]*\]/, '').replace(/^\{[^}\n]*\}/, '').replace(/^\n/, '').replace(/\n$/, '').split('\n')) target.push(new Paragraph({ children: [new TextRun({ text: line, font: 'Courier New', size: 20 })], spacing: { after: 0 } }));
      return;
    }
    if (name === 'thebibliography') {
      flush();
      para.heading = HEADINGS[0];
      text('References', {});
      flush();
      let n = 0;
      for (const item of splitItems(e.content, 'bibitem')) {
        flush();
        text(`[${++n}] `, style);
        walk(item.body, style, depth);
        flush();
      }
      return;
    }
    const theorem = THEOREMS[name.replace('*', '')];
    if (theorem) {
      flush();
      text(`${theorem}${e.args?.some((a) => a.content.length) ? '' : '.'} `, { bold: name !== 'proof', italics: name === 'proof' });
      walk(e.content, name === 'proof' ? style : { ...style, italics: true }, depth);
      if (name === 'proof') text(' ∎', style);
      flush();
      return;
    }
    if (name === 'document') {
      walk(e.content, style, depth);
      return;
    }
    // minipage, multicols and environments of the document's own: their content
    walk(e.content, style, depth);
  };

  const table = (e: Ast.Environment, depth: number): Table => {
    // Rows split at \\, cells at &; \multicolumn and \multirow give the spans
    const rows = splitRows(e.content, isBreak);
    type Cell = { nodes: Ast.Node[]; colSpan: number; rowSpan: number; col: number; align?: Para['align'] };
    // Column alignment from the column spec (l c r, p{..} and X wrap left); \multicolumn brings its own
    const aligns = (spec: string) => spec.replace(/\{[^{}]*\}/g, '').replace(/[^lcrpmbXS]/g, '').split('')
      .map((c) => (c === 'c' ? AlignmentType.CENTER : c === 'r' ? AlignmentType.RIGHT : undefined));
    const columns = aligns(rawArg(e.args?.filter((a) => a.openMark === '{').slice(-1)[0]));
    const grid: Cell[][] = [];
    rows.forEach((cells, r) => {
      grid[r] = [];
      let col = 0;
      for (const nodes of cells) {
        const mc = nodes.find((n): n is Ast.Macro => n.type === 'macro' && n.content === 'multicolumn');
        const mr = nodes.find((n): n is Ast.Macro => n.type === 'macro' && n.content === 'multirow');
        const colSpan = mc ? Number(rawArg(givenArgs(mc)[0])) || 1 : 1;
        const inner = mc ? givenArgs(mc).slice(-1)[0]?.content ?? [] : nodes;
        const multirow = mr ?? inner.find((n): n is Ast.Macro => n.type === 'macro' && n.content === 'multirow');
        const rowSpan = multirow ? Math.max(1, Number(rawArg(givenArgs(multirow)[0])) || 1) : 1;
        const content = multirow ? givenArgs(multirow).slice(-1)[0]?.content ?? [] : inner;
        // An empty cell under a \multirow is part of it
        const coveredAbove = r > 0 && grid.slice(0, r).some((row, rr) => row.some((c) => c.col <= col && col < c.col + c.colSpan && rr + c.rowSpan > r));
        if (coveredAbove && !content.some((n) => n.type !== 'whitespace')) {
          col += colSpan;
          continue;
        }
        grid[r].push({ nodes: content, colSpan, rowSpan, col, align: mc ? aligns(rawArg(givenArgs(mc)[1]))[0] : columns[col] });
        col += colSpan;
      }
    });
    const cols = Math.max(1, ...grid.map((row) => row.reduce((n, c) => Math.max(n, c.col + c.colSpan), 0)));
    const trows: TableRow[] = [];
    grid.forEach((row) => {
      if (!row.length) return;
      trows.push(new TableRow({
        children: row.map((c) => {
          const children = blocks(c.nodes, depth, c.align);
          return new TableCell({
            columnSpan: c.colSpan > 1 ? c.colSpan : undefined,
            rowSpan: c.rowSpan > 1 ? c.rowSpan : undefined,
            borders: { top: LINE, bottom: LINE, left: LINE, right: LINE },
            width: { size: Math.round((100 * c.colSpan) / cols), type: WidthType.PERCENTAGE },
            children: children.length ? children : [new Paragraph('')],
          });
        }),
      }));
    });
    return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: trows.length ? trows : [new TableRow({ children: [new TableCell({ children: [new Paragraph('')] })] })] });
  };

  walk(body, {});
  flush();

  const doc = new Document({
    creator: 'Peekbean',
    styles: { default: { document: { run: { font: 'Cambria', size: 22 } } } },
    footnotes,
    numbering: {
      config: lists.map((reference) => ({
        reference,
        levels: Array.from({ length: 9 }, (_, level) => ({
          level, format: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN, LevelFormat.UPPER_LETTER][level % 4],
          text: level % 4 === 1 ? `(%${level + 1})` : `%${level + 1}.`, alignment: AlignmentType.START,
          style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
        })),
      })),
    },
    sections: [{ children: out.length ? out : [new Paragraph('')] }],
  });
  return { docx: await Packer.toBlob(doc), notes: [...notes] };
}

/** "``", "''", "--" and "---" as typographic signs */
function ligatures(s: string): string {
  return s.replace(/---/g, '—').replace(/--/g, '–').replace(/``/g, '“').replace(/''/g, '”').replace(/~/g, ' ');
}

function sameStyle(a: Style, b: Style): boolean {
  const keys: (keyof Style)[] = ['bold', 'italics', 'underline', 'strike', 'smallCaps', 'mono', 'superScript', 'subScript'];
  return keys.every((k) => !a[k] === !b[k]);
}

function findEnv(nodes: Ast.Node[], name: string): Ast.Environment | null {
  for (const n of nodes) {
    if (n.type === 'environment' && n.env === name) return n;
    if ('content' in n && Array.isArray(n.content)) {
      const found = findEnv(n.content, name);
      if (found) return found;
    }
  }
  return null;
}

/** An environment's content split at \item (or \bibitem), with the optional [label] */
function splitItems(nodes: Ast.Node[], marker = 'item'): { label?: Ast.Node[]; body: Ast.Node[] }[] {
  const items: { label?: Ast.Node[]; body: Ast.Node[] }[] = [];
  for (const n of nodes) {
    if (n.type === 'macro' && n.content === marker) {
      // unified-latex gives \item its [label] and its text as arguments; \bibitem's key is no label
      const label = marker === 'item' ? n.args?.find((a) => a.openMark === '[' && a.content.length)?.content : undefined;
      items.push({ label, body: n.args?.filter((a) => !a.openMark).flatMap((a) => a.content) ?? [] });
    } else if (items.length) items[items.length - 1].body.push(n);
  }
  return items;
}

/** tabular content → rows → cells (node lists), split at \\ and & on the top level */
function splitRows(nodes: Ast.Node[], isBreak: (n: Ast.Node) => boolean): Ast.Node[][][] {
  const rows: Ast.Node[][][] = [[[]]];
  for (const n of nodes) {
    const row = rows[rows.length - 1];
    if (isBreak(n)) rows.push([[]]);
    else if (n.type === 'string' && n.content === '&') row.push([]);
    else if (n.type === 'string' && n.content.includes('&')) {
      n.content.split('&').forEach((part, k) => {
        if (k) row.push([]);
        if (part) row[row.length - 1].push({ type: 'string', content: part });
      });
    } else row[row.length - 1].push(n);
  }
  // Rules and empty trailing rows are no content
  return rows.filter((cells) => cells.some((c) => c.some((n) => !(n.type === 'whitespace' || n.type === 'comment' || n.type === 'parbreak' || (n.type === 'macro' && ['hline', 'cline', 'toprule', 'midrule', 'bottomrule', 'cmidrule', 'endhead', 'endfirsthead'].includes(n.content))))));
}
