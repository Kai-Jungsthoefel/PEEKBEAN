// SPDX-License-Identifier: GPL-3.0-or-later
// LaTeX to PDF with TeX Live in the browser (latex/typeset.ts), and to Word (latex/to-docx.ts): the .tex file is
// parsed and written as a Word document with real headings, lists, tables, footnotes and equations.
import { latexToDocx } from '../../latex/to-docx';
import { errorSummary, readProject, typeset } from '../../latex/typeset';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

export async function convert({ file, target, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading LaTeX …');
  if (target === 'pdf') {
    const result = await typeset(await readProject(file), progress);
    if (!result.pdf) throw new Error(['LaTeX stopped without a PDF.', ...errorSummary(result.log, 1), ...result.notes].join(' '));
    const errors = errorSummary(result.log, 50).length;
    const notes = [...result.notes, ...(errors ? [`LaTeX reported ${errors === 50 ? 'many' : errors} ${errors === 1 ? 'error' : 'errors'}; the PDF may be incomplete.`] : [])];
    return { files: [new File([result.pdf as BlobPart], resultName(file.name, 'pdf'), { type: 'application/pdf' })], notes };
  }
  const source = await file.text();
  progress('Writing Word …');
  const { docx, notes } = await latexToDocx(source);
  return { files: [new File([docx], resultName(file.name, 'docx'), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })], notes };
}
