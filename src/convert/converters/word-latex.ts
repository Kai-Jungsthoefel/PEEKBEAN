// SPDX-License-Identifier: GPL-3.0-or-later
// Word to LaTeX: the content as ooxml-pages reads it (no layout), written by latex/from-docx.ts. Pictures go next to
// the .tex file, in one ZIP with it.
import { readDocxContent } from 'ooxml-pages/content';
import { docxToLatex } from '../../latex/from-docx';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

/** File extensions LaTeX's graphicx takes; other pictures are written as PNG */
const TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'application/pdf': 'pdf' };

export async function convert({ file, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading the document …');
  const content = await readDocxContent(file);
  try {
    // Picture types first: the file names in the .tex carry them
    const blobs = new Map<number, Blob>();
    const ids: number[] = [];
    const walk = (blocks: typeof content.blocks) => {
      for (const b of blocks) {
        if (b.type === 'table') b.rows.forEach((r) => r.cells.forEach((c) => walk(c.blocks)));
        else for (const i of b.inlines) {
          if (i.kind === 'picture') ids.push(i.id);
          else if (i.kind === 'box') walk(i.blocks);
        }
      }
    };
    walk(content.blocks);
    for (const [k, id] of ids.entries()) {
      progress('Reading pictures …', k / ids.length);
      const blob = await content.picture(id);
      if (blob) blobs.set(id, TYPES[blob.type] ? blob : await toPng(blob));
    }
    progress('Writing LaTeX …');
    const { tex, pictures, notes } = docxToLatex(content, (id) => TYPES[blobs.get(id)?.type ?? ''] ?? 'png');
    const files = [new File([tex], resultName(file.name, 'tex'), { type: 'application/x-tex' })];
    let missing = 0;
    for (const p of pictures) {
      const blob = blobs.get(p.id);
      if (blob) files.push(new File([blob], p.name, { type: blob.type }));
      else missing++;
    }
    if (missing) notes.push(`${missing === 1 ? 'One picture' : `${missing} pictures`} could not be read; the .tex file still refers to ${missing === 1 ? 'it' : 'them'}.`);
    return { files, notes };
  } finally {
    content.close();
  }
}

/** Pictures in other formats (GIF, WebP, SVG …) as PNG, which LaTeX takes */
async function toPng(blob: Blob): Promise<Blob> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = new OffscreenCanvas(img.naturalWidth || 1, img.naturalHeight || 1);
    canvas.getContext('2d')!.drawImage(img, 0, 0);
    return await canvas.convertToBlob({ type: 'image/png' });
  } finally {
    URL.revokeObjectURL(url);
  }
}
