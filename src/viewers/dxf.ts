// SPDX-License-Identifier: GPL-3.0-or-later
import { startsWith } from '../core/bytes';
import type { ViewerContext } from '../core/types';
import { dxfEncoding, mountDrawing } from './drawing2d';

export async function mount(ctx: ViewerContext) {
  const head = new Uint8Array(await ctx.file.slice(0, 64 * 1024).arrayBuffer());
  if (startsWith(head, 'AutoCAD Binary DXF')) {
    throw new Error('Binary DXF files are not supported yet, only text DXF.');
  }
  const url = URL.createObjectURL(ctx.file);
  try {
    const viewer = await mountDrawing(ctx, { url, encoding: dxfEncoding(new TextDecoder('latin1').decode(head)) });
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
