// SPDX-License-Identifier: GPL-3.0-or-later
// Word equations (Office MathML) → LaTeX: fractions, scripts, roots, big operators, delimiters, functions, limits,
// accents, bars, braces, matrices and equation arrays; symbols as LaTeX commands. Unknown elements give their content.

/** Unicode in math → LaTeX */
const SYMBOLS: Record<string, string> = {
  α: '\\alpha', β: '\\beta', γ: '\\gamma', δ: '\\delta', ε: '\\varepsilon', ϵ: '\\epsilon', ζ: '\\zeta', η: '\\eta',
  θ: '\\theta', ϑ: '\\vartheta', ι: '\\iota', κ: '\\kappa', λ: '\\lambda', μ: '\\mu', ν: '\\nu', ξ: '\\xi', π: '\\pi',
  ϖ: '\\varpi', ρ: '\\rho', ϱ: '\\varrho', σ: '\\sigma', ς: '\\varsigma', τ: '\\tau', υ: '\\upsilon', φ: '\\varphi',
  ϕ: '\\phi', χ: '\\chi', ψ: '\\psi', ω: '\\omega', Γ: '\\Gamma', Δ: '\\Delta', Θ: '\\Theta', Λ: '\\Lambda', Ξ: '\\Xi',
  Π: '\\Pi', Σ: '\\Sigma', Υ: '\\Upsilon', Φ: '\\Phi', Ψ: '\\Psi', Ω: '\\Omega', '∆': '\\Delta', 'µ': '\\mu',
  '±': '\\pm', '∓': '\\mp', '×': '\\times', '÷': '\\div', '·': '\\cdot', '⋅': '\\cdot', '∗': '\\ast', '∘': '\\circ',
  '≤': '\\leq', '≥': '\\geq', '≦': '\\leqq', '≧': '\\geqq', '≠': '\\neq', '≈': '\\approx', '≡': '\\equiv', '∼': '\\sim',
  '≃': '\\simeq', '≅': '\\cong', '∝': '\\propto', '≪': '\\ll', '≫': '\\gg', '≺': '\\prec', '≻': '\\succ',
  '∞': '\\infty', '∂': '\\partial', '∇': '\\nabla', '∈': '\\in', '∉': '\\notin', '∋': '\\ni', '⊂': '\\subset',
  '⊆': '\\subseteq', '⊃': '\\supset', '⊇': '\\supseteq', '∪': '\\cup', '∩': '\\cap', '∅': '\\emptyset',
  '∀': '\\forall', '∃': '\\exists', '∄': '\\nexists', '¬': '\\neg', '∧': '\\wedge', '∨': '\\vee', '⊕': '\\oplus',
  '⊗': '\\otimes', '⊥': '\\perp', '∥': '\\parallel', '∠': '\\angle', '△': '\\triangle',
  '→': '\\rightarrow', '←': '\\leftarrow', '↔': '\\leftrightarrow', '⇒': '\\Rightarrow', '⇐': '\\Leftarrow',
  '⇔': '\\Leftrightarrow', '↦': '\\mapsto', '↑': '\\uparrow', '↓': '\\downarrow', '⟶': '\\longrightarrow',
  '…': '\\ldots', '⋯': '\\cdots', '⋮': '\\vdots', '⋱': '\\ddots', '′': "'", '″': "''", '‴': "'''",
  'ℏ': '\\hbar', 'ℓ': '\\ell', 'ℜ': '\\Re', 'ℑ': '\\Im', 'ℵ': '\\aleph', '℘': '\\wp',
  'ℝ': '\\mathbb{R}', 'ℕ': '\\mathbb{N}', 'ℤ': '\\mathbb{Z}', 'ℚ': '\\mathbb{Q}', 'ℂ': '\\mathbb{C}',
  '−': '-', '∶': ':', '⟨': '\\langle', '⟩': '\\rangle', '〈': '\\langle', '〉': '\\rangle', '‖': '\\|',
  '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil', '√': '\\surd', '°': '^{\\circ}',
  '∑': '\\sum', '∏': '\\prod', '∐': '\\coprod', '∫': '\\int', '∬': '\\iint', '∭': '\\iiint', '∮': '\\oint',
  '⋃': '\\bigcup', '⋂': '\\bigcap', '⋁': '\\bigvee', '⋀': '\\bigwedge', '⨁': '\\bigoplus', '⨂': '\\bigotimes',
  '{': '\\{', '}': '\\}', '#': '\\#', $: '\\$', '%': '\\%', '&': '\\&', _: '\\_', '~': '\\sim', '\\': '\\backslash',
  '^': '\\hat{}', ' ': '\\,', ' ': '\\,', ' ': '\\:', ' ': '\\;', ' ': '\\quad', ' ': '~',
  '⁡': '', '⁢': '', '⁣': '', '⁤': '', '​': '',
};

const ACCENTS: Record<string, string> = {
  '̂': '\\hat', '̃': '\\tilde', '̄': '\\bar', '̅': '\\overline', '⃗': '\\vec', '⃑': '\\vec',
  '̇': '\\dot', '̈': '\\ddot', '⃛': '\\dddot', '̌': '\\check', '́': '\\acute', '̀': '\\grave',
  '̆': '\\breve', '̊': '\\mathring', '^': '\\hat', '~': '\\tilde', '¯': '\\bar', '→': '\\vec',
};

const FUNCTIONS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'arcsin', 'arccos', 'arctan', 'sinh', 'cosh', 'tanh', 'coth', 'log', 'ln',
  'lg', 'exp', 'lim', 'liminf', 'limsup', 'max', 'min', 'sup', 'inf', 'det', 'dim', 'ker', 'gcd', 'arg', 'deg', 'hom', 'Pr',
]);

const DELIMITERS: Record<string, string> = {
  '(': '(', ')': ')', '[': '[', ']': ']', '{': '\\{', '}': '\\}', '|': '|', '‖': '\\|', '⟨': '\\langle', '⟩': '\\rangle',
  '〈': '\\langle', '〉': '\\rangle', '⌊': '\\lfloor', '⌋': '\\rfloor', '⌈': '\\lceil', '⌉': '\\rceil', '': '.',
};

const kids = (el: Element | null | undefined) => (el ? [...el.children] : []);
const kid = (el: Element | null | undefined, name: string) => kids(el).find((c) => c.localName === name) ?? null;
/** m:val of a property element, e.g. <m:chr m:val="∑"/> */
const val = (el: Element | null | undefined, name: string): string | null => {
  const p = kid(el, name);
  if (!p) return null;
  for (const a of p.attributes) if (a.localName === 'val') return a.value;
  return null;
};

/** An m:oMath or m:oMathPara element as LaTeX (without $ or display delimiters) */
export function ommlToLatex(el: Element): string {
  if (el.localName === 'oMathPara') {
    const lines = kids(el).filter((c) => c.localName === 'oMath').map((m) => tidy(convert(m)));
    return lines.length > 1 ? `\\begin{gathered}\n${lines.join(' \\\\\n')}\n\\end{gathered}` : lines[0] ?? '';
  }
  return tidy(convert(el));
}

/** Spaces collapsed; a command keeps its space only before a letter */
function tidy(s: string): string {
  return s.replace(/\s+/g, ' ').replace(/(\\[A-Za-z]+) (?![A-Za-z])/g, '$1').trim();
}

function convert(el: Element): string {
  return kids(el).map(node).join('');
}

/** Arguments are always braced: x^{2}, \frac{a}{b} */
const arg = (el: Element | null) => `{${el ? convert(el) : ''}}`;

function node(el: Element): string {
  switch (el.localName) {
    case 'r':
      return run(el);
    case 'e':
    case 'num':
    case 'den':
    case 'sub':
    case 'sup':
    case 'deg':
    case 'lim':
    case 'fName':
    case 'oMath':
      return convert(el);
    case 'f': {
      const type = val(kid(el, 'fPr'), 'type');
      const num = kid(el, 'num'), den = kid(el, 'den');
      if (type === 'lin') return `${arg(num)}/${arg(den)}`;
      if (type === 'noBar') return `\\genfrac{}{}{0pt}{}${arg(num)}${arg(den)}`;
      return `\\frac${arg(num)}${arg(den)}`;
    }
    case 'sSup':
      return `${base(kid(el, 'e'))}^${arg(kid(el, 'sup'))}`;
    case 'sSub':
      return `${base(kid(el, 'e'))}_${arg(kid(el, 'sub'))}`;
    case 'sSubSup':
      return `${base(kid(el, 'e'))}_${arg(kid(el, 'sub'))}^${arg(kid(el, 'sup'))}`;
    case 'sPre':
      return `{}_${arg(kid(el, 'sub'))}^${arg(kid(el, 'sup'))}${base(kid(el, 'e'))}`;
    case 'rad': {
      const hide = val(kid(el, 'radPr'), 'degHide');
      const deg = kid(el, 'deg');
      const d = hide === '1' || hide === 'on' || hide === 'true' || !deg || !convert(deg).trim() ? '' : `[${convert(deg)}]`;
      return `\\sqrt${d}${arg(kid(el, 'e'))}`;
    }
    case 'nary':
      return nary(el);
    case 'd':
      return delimiter(el);
    case 'func': {
      const name = kid(el, 'fName');
      const text = name ? convert(name).trim() : '';
      const plain = text.replace(/\\mathrm\{([^{}]*)\}/g, '$1');
      const fn = FUNCTIONS.has(plain) ? `\\${plain}` : /^[A-Za-z]+$/.test(plain) ? `\\operatorname{${plain}}` : text;
      return `${fn} ${base(kid(el, 'e'))}`;
    }
    case 'limLow': {
      const e = kid(el, 'e');
      const text = e ? convert(e).trim().replace(/\\mathrm\{([^{}]*)\}/g, '$1') : '';
      if (FUNCTIONS.has(text)) return `\\${text}_${arg(kid(el, 'lim'))}`;
      return `\\underset${arg(kid(el, 'lim'))}${arg(e)}`;
    }
    case 'limUpp':
      return `\\overset${arg(kid(el, 'lim'))}${arg(kid(el, 'e'))}`;
    case 'acc': {
      const chr = val(kid(el, 'accPr'), 'chr') ?? '̂';
      return `${ACCENTS[chr] ?? '\\hat'}${arg(kid(el, 'e'))}`;
    }
    case 'bar':
      return `${val(kid(el, 'barPr'), 'pos') === 'top' ? '\\overline' : '\\underline'}${arg(kid(el, 'e'))}`;
    case 'groupChr': {
      const pr = kid(el, 'groupChrPr');
      const chr = val(pr, 'chr') ?? '⏟';
      const top = val(pr, 'pos') === 'top' || chr === '⏞';
      if (chr === '⏟' || chr === '⏞') return `${top ? '\\overbrace' : '\\underbrace'}${arg(kid(el, 'e'))}`;
      return `${top ? '\\overset' : '\\underset'}{${symbols(chr)}}${arg(kid(el, 'e'))}`;
    }
    case 'borderBox':
      return `\\boxed${arg(kid(el, 'e'))}`;
    case 'box':
    case 'phant':
      return convert(kid(el, 'e') ?? el);
    case 'm': {
      const rows = kids(el).filter((c) => c.localName === 'mr').map((r) => kids(r).filter((c) => c.localName === 'e').map(convert).join(' & '));
      return `\\begin{matrix}${rows.join(' \\\\ ')}\\end{matrix}`;
    }
    case 'eqArr': {
      const rows = kids(el).filter((c) => c.localName === 'e').map(convert);
      const aligned = rows.some((r) => r.includes('&'));
      return `\\begin{${aligned ? 'aligned' : 'gathered'}}${rows.join(' \\\\ ')}\\end{${aligned ? 'aligned' : 'gathered'}}`;
    }
    // Normal text inside an equation (w:r)
    case 'oMathParaPr':
    case 'ctrlPr':
      return '';
    default:
      if (el.localName.endsWith('Pr')) return '';
      return convert(el);
  }
}

/** A script's base: braced when it is more than one sign, so x_{1}^{2} stays right */
function base(el: Element | null): string {
  const s = el ? convert(el).trim() : '';
  return s.length === 1 || /^\\[A-Za-z]+$/.test(s) ? s : `{${s}}`;
}

function run(r: Element): string {
  const text = kids(r).filter((c) => c.localName === 't').map((t) => t.textContent ?? '').join('');
  if (!text) return '';
  // The math run properties; a run may also carry Word's own w:rPr (fonts)
  const rPr = kids(r).find((c) => c.localName === 'rPr' && !c.namespaceURI?.includes('wordprocessingml')) ?? null;
  // A run in Word's own namespace is normal text, not math
  if (r.namespaceURI?.includes('wordprocessingml') || kid(rPr, 'nor')) return `\\text{${textMode(text)}}`;
  const sty = val(rPr, 'sty');
  const scr = val(rPr, 'scr');
  let out = symbols(text);
  // Upright text of several letters (units, names) and the styles Word offers
  if (sty === 'p' && /[A-Za-z]{2,}/.test(text) && !FUNCTIONS.has(text.trim())) out = `\\mathrm{${out}}`;
  else if (sty === 'p' && FUNCTIONS.has(text.trim())) out = `\\${text.trim()}`;
  else if (sty === 'b') out = `\\mathbf{${out}}`;
  else if (sty === 'bi') out = `\\boldsymbol{${out}}`;
  if (scr === 'double-struck') out = `\\mathbb{${out}}`;
  else if (scr === 'fraktur') out = `\\mathfrak{${out}}`;
  else if (scr === 'script') out = `\\mathcal{${out}}`;
  else if (scr === 'sans-serif') out = `\\mathsf{${out}}`;
  else if (scr === 'monospace') out = `\\mathtt{${out}}`;
  return out;
}

function symbols(text: string): string {
  let out = '';
  for (const raw of text) {
    // Mathematical italic, bold … letters (𝑥, 𝐀) are the plain ones in LaTeX
    const c = /[\u{1D400}-\u{1D7FF}]/u.test(raw) ? raw.normalize('NFKC') : raw;
    const s = SYMBOLS[c];
    if (s === undefined) out += c;
    else out += /^\\[A-Za-z]+$/.test(s) ? `${s} ` : s;
  }
  return out;
}

function textMode(text: string): string {
  return text.replace(/[\\{}#$%&_^~]/g, (c) => (c === '\\' ? '\\textbackslash{}' : c === '^' || c === '~' ? `\\${c}{}` : `\\${c}`));
}

function nary(el: Element): string {
  const pr = kid(el, 'naryPr');
  const chr = val(pr, 'chr') ?? '∫';
  const op = SYMBOLS[chr] ?? symbols(chr);
  const hidden = (name: string) => ['1', 'on', 'true'].includes(val(pr, name) ?? '');
  const sub = kid(el, 'sub'), sup = kid(el, 'sup');
  let out = op;
  if (!hidden('subHide') && sub && convert(sub).trim()) out += `_${arg(sub)}`;
  if (!hidden('supHide') && sup && convert(sup).trim()) out += `^${arg(sup)}`;
  return `${out} ${convert(kid(el, 'e') ?? el)}`;
}

function delimiter(el: Element): string {
  const pr = kid(el, 'dPr');
  const beg = val(pr, 'begChr') ?? '(';
  const end = val(pr, 'endChr') ?? ')';
  const sep = val(pr, 'sepChr') ?? '|';
  const parts = kids(el).filter((c) => c.localName === 'e').map(convert);
  const inner = parts.join(` ${sep === '|' ? '\\mid' : symbols(sep)} `);
  // A matrix in round or square brackets is pmatrix or bmatrix
  if (parts.length === 1 && /^\\begin\{matrix\}[\s\S]*\\end\{matrix\}$/.test(inner.trim())) {
    const env = beg === '(' ? 'pmatrix' : beg === '[' ? 'bmatrix' : beg === '|' ? 'vmatrix' : beg === '{' ? 'Bmatrix' : null;
    if (env) return inner.trim().replace(/^\\begin\{matrix\}/, `\\begin{${env}}`).replace(/\\end\{matrix\}$/, `\\end{${env}}`);
  }
  return `\\left${DELIMITERS[beg] ?? '.'}${inner}\\right${DELIMITERS[end] ?? '.'}`;
}
