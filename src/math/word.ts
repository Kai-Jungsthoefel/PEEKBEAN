// SPDX-License-Identifier: GPL-3.0-or-later
// A formula set apart in a Word document (docx library): centred on its own, or with its number at the right margin in
// a table row without borders, as Word users number equations. Tab stops would push a wide formula onto two lines.
import {
  AlignmentType, BorderStyle, ImportedXmlComponent, Paragraph, Table, TableCell, TableRow, VerticalAlign, WidthType,
  type IBorderOptions, type ParagraphChild,
} from 'docx';

const NONE: IBorderOptions = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const NO_BORDERS = { top: NONE, bottom: NONE, left: NONE, right: NONE, insideHorizontal: NONE, insideVertical: NONE };

/** An <m:oMath> element (math/omml.ts) as a paragraph child */
export function ommlChild(xml: string): ParagraphChild {
  return (ImportedXmlComponent.fromXmlString(xml) as unknown as { root: ParagraphChild[] }).root[0];
}

export function wordEquation(omml: string, tag?: string): Paragraph | Table {
  const display = ommlChild(`<m:oMathPara xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${omml}</m:oMathPara>`);
  if (!tag) return new Paragraph({ children: [display], spacing: { before: 120, after: 120 } });
  const cell = (children: Paragraph[], width: number) => new TableCell({
    children, width: { size: width, type: WidthType.PERCENTAGE }, verticalAlign: VerticalAlign.CENTER,
    borders: { top: NONE, bottom: NONE, left: NONE, right: NONE },
  });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    borders: NO_BORDERS,
    rows: [new TableRow({
      children: [
        cell([new Paragraph({ children: [display] })], 88),
        cell([new Paragraph({ text: `(${tag})`, alignment: AlignmentType.RIGHT })], 12),
      ],
    })],
  });
}
