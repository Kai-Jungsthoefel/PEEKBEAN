// SPDX-License-Identifier: GPL-3.0-or-later
// Writing LaTeX: text escaped so pdfLaTeX takes it (signs it cannot type in text mode become commands), and the
// document frame. Used by the text recognition's export and by Word to LaTeX.

const SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', $: '\\$', '&': '\\&', '%': '\\%', '#': '\\#', _: '\\_',
  '^': '\\textasciicircum{}', '~': '\\textasciitilde{}', '<': '\\textless{}', '>': '\\textgreater{}', '|': '\\textbar{}',
  // babel's German makes " a shorthand
  '"': '\\textquotedbl{}',
};

/** Signs outside pdfLaTeX's text encodings, as commands (math mode where LaTeX has them only there) */
const SIGNS: Record<string, string> = {
  '−': '-', '–': '--', '—': '---', '…': '\\dots{}', '•': '\\textbullet{}', '·': '\\textperiodcentered{}',
  '°': '\\textdegree{}', '€': '\\texteuro{}', '™': '\\texttrademark{}', '©': '\\textcopyright{}', '®': '\\textregistered{}',
  '²': '\\textsuperscript{2}', '³': '\\textsuperscript{3}', '¹': '\\textsuperscript{1}', 'µ': '\\textmu{}',
  '\u00a0': '~', '\u2009': '\\,', '\u202f': '\\,', '\u00ad': '\\-',
  '×': '$\\times$', '÷': '$\\div$', '±': '$\\pm$', '≤': '$\\leq$', '≥': '$\\geq$', '≠': '$\\neq$', '≈': '$\\approx$',
  '∞': '$\\infty$', '→': '$\\rightarrow$', '←': '$\\leftarrow$', '↔': '$\\leftrightarrow$', '⇒': '$\\Rightarrow$',
  '⇔': '$\\Leftrightarrow$', '√': '$\\surd$', '∑': '$\\sum$', '∫': '$\\int$', '∂': '$\\partial$', 'Δ': '$\\Delta$',
  '∆': '$\\Delta$', 'Ω': '$\\Omega$', 'Φ': '$\\Phi$', 'Σ': '$\\Sigma$', 'Π': '$\\Pi$', 'Θ': '$\\Theta$', 'Λ': '$\\Lambda$',
  'Γ': '$\\Gamma$', 'Ψ': '$\\Psi$', 'α': '$\\alpha$', 'β': '$\\beta$', 'γ': '$\\gamma$', 'δ': '$\\delta$',
  'ε': '$\\varepsilon$', 'ζ': '$\\zeta$', 'η': '$\\eta$', 'θ': '$\\theta$', 'ι': '$\\iota$', 'κ': '$\\kappa$',
  'λ': '$\\lambda$', 'μ': '$\\mu$', 'ν': '$\\nu$', 'ξ': '$\\xi$', 'π': '$\\pi$', 'ρ': '$\\rho$', 'σ': '$\\sigma$',
  'ς': '$\\varsigma$', 'τ': '$\\tau$', 'υ': '$\\upsilon$', 'φ': '$\\varphi$', 'χ': '$\\chi$', 'ψ': '$\\psi$', 'ω': '$\\omega$',
  '‘': '`', '’': "'", '“': '``', '”': "''", '„': ',,', '‚': ',',
  '∎': '$\\blacksquare$', '■': '$\\blacksquare$', '□': '$\\square$', '✓': '$\\checkmark$', '✔': '$\\checkmark$',
  '★': '$\\bigstar$', '↑': '$\\uparrow$', '↓': '$\\downarrow$', '∈': '$\\in$', '≡': '$\\equiv$', '∅': '$\\emptyset$',
};

export function escapeLatex(text: string): string {
  let out = '';
  for (const c of text) out += SPECIAL[c] ?? SIGNS[c] ?? c;
  // Signs next to each other in math mode: "$\leq$$\alpha$" reads as display math
  return out.replace(/\$\$/g, '$ $');
}

/** Languages with word lists in the text recognition, and those Word tags, → babel's names (hyphenation) */
const BABEL: Record<string, string> = {
  en: 'english', de: 'ngerman', fr: 'french', es: 'spanish', it: 'italian', pt: 'portuguese', nl: 'dutch', pl: 'polish',
  sv: 'swedish', da: 'danish', no: 'norsk', nb: 'norsk', nn: 'nynorsk', cs: 'czech', hu: 'magyar', ro: 'romanian',
  fi: 'finnish', tr: 'turkish',
};

export function babelName(lang: string | undefined): string | undefined {
  return lang ? BABEL[lang.toLowerCase().split('-')[0]] : undefined;
}

export interface Preamble {
  /** babel names; the last one is the main language */
  languages: string[];
  graphics: boolean;
  tables: boolean;
}

/** The document frame: compiles with pdfLaTeX, XeLaTeX and LuaLaTeX */
export function documentFrame(body: string, p: Preamble): string {
  const lines = [
    '\\documentclass[a4paper,11pt]{article}',
    '\\usepackage{iftex}',
    '\\ifPDFTeX',
    '  \\usepackage[utf8]{inputenc}',
    '  \\usepackage[T1]{fontenc}',
    '  \\usepackage{lmodern}',
    '\\fi',
    '\\usepackage{textcomp}',
  ];
  if (p.languages.length) lines.push(`\\usepackage[${p.languages.join(',')}]{babel}`);
  lines.push('\\usepackage{amsmath,amssymb}', '\\usepackage[margin=2.5cm]{geometry}');
  if (p.graphics) lines.push('\\usepackage{graphicx}');
  if (p.tables) lines.push('\\usepackage{array,multirow}');
  lines.push('\\usepackage[hidelinks]{hyperref}');
  // Characters pdfLaTeX has no glyph for (other scripts, rare symbols) show as their code there; XeLaTeX and LuaLaTeX
  // show them as they are
  const unknown = [...new Set([...body].filter((c) => c.codePointAt(0)! > 0x17f && !TEXT_OK.test(c)))];
  if (unknown.length) {
    lines.push('\\ifPDFTeX');
    for (const c of unknown) {
      const hex = c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0');
      lines.push(`  \\DeclareUnicodeCharacter{${hex}}{[U+${hex}]}`);
    }
    lines.push('\\fi');
  }
  lines.push('', '\\begin{document}', '', body.trim(), '', '\\end{document}', '');
  return lines.join('\n');
}

/** Characters above Latin Extended-A that pdfLaTeX's T1 encoding and textcomp still have */
const TEXT_OK = /[\u0218-\u021b\u02c6\u02c7\u02dc\u2013\u2014\u2018-\u201e\u2020-\u2022\u2026\u2030\u2039\u203a\u20ac\u2122]/;

export interface LatexTable {
  /** Column widths as shares of the table */
  shares: number[];
  rows: number;
  /** Rules around all cells */
  ruled: boolean;
  /** Cells as LaTeX, at their grid position */
  cells: { row: number; col: number; rowSpan: number; colSpan: number; content: string }[];
}

/** A table as tabular with paragraph columns (so long cell text wraps), merged cells as \multicolumn and \multirow */
export function tabularLatex(t: LatexTable): string {
  const cols = t.shares.length;
  const widths = t.shares.map((w) => (w * 0.94).toFixed(3));
  const rule = t.ruled ? '|' : '';
  const spec = rule + widths.map((w) => `p{${w}\\linewidth}`).join(rule) + rule;
  const span = (from: number, n: number) => widths.slice(from, from + n).reduce((s, w) => s + Number(w), 0).toFixed(3);
  const column = (k: number, n: number, content: string) => `\\multicolumn{${n}}{${k ? '' : rule}p{${span(k, n)}\\linewidth}${rule}}{${content}}`;
  // Which grid positions a cell from a row above covers
  const covered = Array.from({ length: t.rows + 1 }, () => Array<boolean>(cols).fill(false));
  for (const c of t.cells) {
    for (let r = c.row + 1; r < c.row + c.rowSpan && r < t.rows; r++) for (let k = c.col; k < c.col + c.colSpan && k < cols; k++) covered[r][k] = true;
  }
  const lines = [`\\begin{tabular}{${spec}}`];
  if (t.ruled) lines.push('\\hline');
  for (let r = 0; r < t.rows; r++) {
    const cells: string[] = [];
    for (let k = 0; k < cols;) {
      const c = t.cells.find((x) => x.row === r && x.col === k);
      if (!c) {
        // Under a cell spanning rows: an empty cell as wide as that one
        const above = t.cells.find((x) => x.row < r && x.row + x.rowSpan > r && x.col === k);
        const n = Math.max(1, Math.min(above?.colSpan ?? 1, cols - k));
        cells.push(n > 1 ? column(k, n, '') : '');
        k += n;
        continue;
      }
      const n = Math.max(1, Math.min(c.colSpan, cols - k));
      let content = c.content;
      if (c.rowSpan > 1) content = `\\multirow{${c.rowSpan}}{=}{${content}}`;
      cells.push(n > 1 ? column(k, n, content) : content);
      k += n;
    }
    lines.push(`${cells.join(' & ')} \\\\`);
    if (!t.ruled) continue;
    // Rules only where no cell continues downwards
    const open = covered[r + 1];
    if (!open.some(Boolean)) {
      lines.push('\\hline');
      continue;
    }
    const ranges: string[] = [];
    for (let k = 0; k < cols; k++) {
      if (open[k]) continue;
      let e = k;
      while (e + 1 < cols && !open[e + 1]) e++;
      ranges.push(`\\cline{${k + 1}-${e + 1}}`);
      k = e;
    }
    lines.push(ranges.join(' '));
  }
  lines.push('\\end{tabular}');
  return `\\begin{center}\n${lines.join('\n')}\n\\end{center}`;
}
