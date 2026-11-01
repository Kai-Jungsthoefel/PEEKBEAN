// SPDX-License-Identifier: GPL-3.0-or-later
// LaTeX to Word (latex/to-docx.ts): the .tex file is parsed and written as a Word document with real headings, lists,
// tables, footnotes and equations.
import { latexToDocx } from '../../latex/to-docx';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

export async function convert({ file, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading LaTeX …');
  const source = await file.text();
  progress('Writing Word …');
  const { docx, notes } = await latexToDocx(source);
  return { files: [new File([docx], resultName(file.name, 'docx'), { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })], notes };
}
