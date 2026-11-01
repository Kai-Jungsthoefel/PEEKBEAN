// SPDX-License-Identifier: GPL-3.0-or-later
// A LaTeX project as TeX Live typesets it (workers/latex.worker.ts): which file is the document, which engine it is
// written for, and what its log says went wrong.

export type Engine = 'pdflatex' | 'xelatex';

const withoutComments = (source: string) => source.replace(/(^|[^\\])%.*$/gm, '$1');

/** The engine a document is written for: fontspec and friends need XeTeX; a magic comment can say so too */
export function engineFor(source: string): Engine {
  const program = /^\s*%\s*!\s*TEX\s+(?:TS-)?program\s*=\s*(\w+)/im.exec(source)?.[1]?.toLowerCase();
  if (program) return program.startsWith('pdf') || program === 'latex' ? 'pdflatex' : 'xelatex';
  return /\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(?:fontspec|unicode-math|polyglossia|xeCJK|mathspec)\b/.test(withoutComments(source)) ? 'xelatex' : 'pdflatex';
}

/** Whether a .tex file is a document of its own rather than a part that another file includes */
export const isDocument = (source: string) => /\\documentclass\b/.test(withoutComments(source)) && /\\begin\s*\{document\}/.test(source);

/**
 * The documents of a project, the main file first: the one highest up in the folders, by preference named main or like
 * the project. Folders of their own (templates, old versions) lose against the top level.
 */
export function documentsOf(files: Record<string, string>, project = ''): string[] {
  const documents = Object.keys(files).filter((path) => /\.(tex|ltx|latex)$/i.test(path) && isDocument(files[path]));
  const stem = (path: string) => path.replace(/^.*\//, '').replace(/\.[^.]+$/, '').toLowerCase();
  const rank = (path: string) => [path.split('/').length, ['main', 'document', project.toLowerCase()].includes(stem(path)) ? 0 : 1, path.length];
  documents.sort((a, b) => {
    const [x, y] = [rank(a), rank(b)];
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
  });
  return documents;
}

/** Files the document reads that are not there: other parts of the project, pictures, or a package that is missing */
export function missingFiles(log: string): string[] {
  const found = new Set<string>();
  for (const m of log.matchAll(/File `([^']+)' not found|I can't find file `([^']+)'/g)) found.add(m[1] ?? m[2]);
  return [...found];
}

export interface LatexError {
  message: string;
  line?: number;
}

/** The errors in a log: a line starting with "!" and, a few lines below, "l.<line>" where TeX stopped */
export function latexErrors(log: string): LatexError[] {
  const lines = log.split(/\r?\n/);
  const errors: LatexError[] = [];
  lines.forEach((text, i) => {
    if (!text.startsWith('! ')) return;
    const at = lines.slice(i + 1, i + 12).map((l) => /^l\.(\d+)/.exec(l)).find(Boolean);
    errors.push({ message: text.slice(2).trim(), line: at ? Number(at[1]) : undefined });
  });
  return errors;
}
