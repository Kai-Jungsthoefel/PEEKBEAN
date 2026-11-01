// SPDX-License-Identifier: GPL-3.0-or-later
// LaTeX formulas → Word equations (Office MathML): temml writes MathML, mathml2omml turns that into OMML. Used by the
// Word export of the text recognition and by the LaTeX to Word conversion.
import { mml2omml } from 'mathml2omml';
import temml from 'temml';

export interface OmmlOptions {
  /** A formula set apart (\[ … \]) rather than within a line */
  display?: boolean;
  /** The document's own macros: "\\R" → "\\mathbb{R}", with #1 … for arguments */
  macros?: Record<string, string>;
}

/** Environments of several lines; Word writes them as an equation array */
const LINES = /^\\begin\{(aligned|gathered|split|align\*?|gather\*?|multline\*?|eqnarray\*?)\}([\s\S]*)\\end\{\1\}$/;

/**
 * One formula as an <m:oMath> element, or null when temml cannot read it. \tag and \label are left out: Word numbers
 * equations with text next to them, which the caller writes.
 */
export function latexToOmml(latex: string, options: OmmlOptions = {}): string | null {
  const body = latex.replace(/\\(tag\*?|label)\{[^{}]*\}/g, '').replace(/\\(nonumber|notag)\b/g, '').trim();
  if (!body) return null;
  // mml2omml merges the rows of temml's aligned tables; each line is converted alone and put in m:eqArr
  const lines = body.match(LINES);
  if (lines) {
    const rows = splitTop(lines[2]).map((row) => row.replace(/&/g, ' ').trim()).filter(Boolean);
    const inner = rows.map((row) => convert(row, options));
    if (inner.length && inner.every((r) => r !== null)) {
      const parts = inner.map((r) => `<m:e>${r!.replace(/^<m:oMath[^>]*>/, '').replace(/<\/m:oMath>$/, '')}</m:e>`).join('');
      return `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><m:eqArr>${parts}</m:eqArr></m:oMath>`;
    }
  }
  return convert(body, options);
}

function convert(latex: string, options: OmmlOptions): string | null {
  let mathml: string;
  try {
    mathml = temml.renderToString(latex, { displayMode: options.display ?? true, xml: true, throwOnError: true, trust: false, macros: { ...options.macros } });
  } catch {
    return null;
  }
  // Names of several letters (\operatorname, \sin, units) are upright; mml2omml would set them in italics
  mathml = mathml.replace(/<mi>([^<]{2,})<\/mi>/g, '<mi mathvariant="normal">$1</mi>');
  try {
    // mml2omml writes upright names as normal text with an invalid style; Word's own form is the plain style
    const omml = mml2omml(mathml).replace(/<m:nor\/><m:sty m:val="undefined"\/>/g, '<m:sty m:val="p"/>')
      // mml2omml writes text unescaped: "e<1" would break the document
      .replace(/(<([mw]):t\b[^>]*>)([\s\S]*?)(<\/\2:t>)/g, (_, open: string, _ns: string, text: string, close: string) =>
        open + text.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);)/gi, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + close);
    return omml.startsWith('<m:oMath') ? omml : null;
  } catch {
    return null;
  }
}

/** Rows of a multi-line environment: split at \\ outside braces */
function splitTop(s: string): string[] {
  const rows: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\\' && depth === 0) {
        rows.push(s.slice(start, i));
        start = i + 2;
      }
      i++;
    } else if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  rows.push(s.slice(start));
  return rows;
}
