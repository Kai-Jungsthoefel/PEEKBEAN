// SPDX-License-Identifier: GPL-3.0-or-later
// HP-GL and HP-GL/2 plot files, turned into DXF in memory and shown by the 2D drawing view (dxf-viewer, MPL-2.0) with
// one layer per pen. .plt is also the extension of gnuplot scripts; files without plot instructions open as text.
import { looksLikeText } from '../core/bytes';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import type { Viewer, ViewerContext } from '../core/types';
import { mountDrawing } from './drawing2d';
import { convertHpgl } from './hpgl/convert';

export async function mount(ctx: ViewerContext): Promise<Viewer> {
  ctx.progress('Reading plot file …');
  const bytes = new Uint8Array(await ctx.file.arrayBuffer());
  const result = convertHpgl(bytes);
  if (!result.isHpgl) {
    if (!looksLikeText(bytes.subarray(0, 4096))) throw new Error('This file contains no HP-GL plot instructions.');
    const viewer = await (await import('./text')).mount(ctx);
    ctx.container.prepend(h('div', { class: 'banner' }, 'This file contains no HP-GL plot instructions, so it is shown as text. Gnuplot scripts use .plt as well.'));
    return viewer;
  }
  const info: Node[] = [h('span', { class: 'meta' }, result.dialect)];
  if (result.warnings.length) {
    info.push(h('span', { class: 'meta plot-warning', title: result.warnings.join('\n') }, icon('alert', 14), 'Raster image not shown'));
  }
  const url = URL.createObjectURL(new Blob([result.dxf], { type: 'image/vnd.dxf' }));
  try {
    const viewer = await mountDrawing(ctx, { url, encoding: 'utf-8', info });
    return {
      destroy: () => {
        viewer.destroy();
        URL.revokeObjectURL(url);
      },
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}
