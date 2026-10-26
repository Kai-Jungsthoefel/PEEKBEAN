// SPDX-License-Identifier: GPL-3.0-or-later
// DWG is converted to DXF in a worker, then shown by the same 2D view as DXF files. Model space and every paper-space
// layout get a tab at the bottom, as in AutoCAD.
import { h } from '../core/dom';
import type { Viewer, ViewerContext } from '../core/types';
import type { DwgRequest, DwgResponse } from '../workers/dwg.worker';
import { mountDrawing } from './drawing2d';

class DwgSession {
  private readonly worker = new Worker(new URL('../workers/dwg.worker.ts', import.meta.url), { type: 'module' });
  private queue: Promise<unknown> = Promise.resolve();

  /** One request at a time, so each answer belongs to the request before it. */
  call(request: DwgRequest, transfer: Transferable[] = []): Promise<Extract<DwgResponse, { ok: true }>> {
    const next = this.queue.then(
      () =>
        new Promise<Extract<DwgResponse, { ok: true }>>((resolve, reject) => {
          this.worker.onmessage = (event: MessageEvent<DwgResponse>) => {
            if (event.data.ok) resolve(event.data);
            else reject(new Error(`The DWG file could not be read: ${event.data.error}`));
          };
          this.worker.onerror = (event) => reject(new Error(event.message || 'The DWG converter could not be loaded.'));
          this.worker.postMessage(request, transfer);
        }),
    );
    this.queue = next.catch(() => {});
    return next;
  }

  close(): void {
    this.worker.terminate();
  }
}

function warningBanner(warnings: string[], details: string[], recovered: boolean): HTMLElement | null {
  if (!warnings.length && !recovered) return null;
  const list = h('ul', { class: 'banner-details', hidden: true }, ...details.map((d) => h('li', {}, d)));
  const toggle = details.length
    ? h('button', { type: 'button', class: 'link', onclick: () => {
        list.hidden = !list.hidden;
        toggle!.textContent = list.hidden ? 'Details' : 'Hide details';
      } }, 'Details')
    : null;
  const lead = recovered ? 'The file is damaged; showing what could be recovered.' : '';
  return h('div', { class: 'banner' }, h('div', { class: 'banner-row' }, h('span', {}, [lead, ...warnings].filter(Boolean).join(' · ')), toggle), list);
}

export async function mount(ctx: ViewerContext): Promise<Viewer> {
  const session = new DwgSession();
  const area = h('div', { class: 'drawing-area' });
  const tabs = h('div', { class: 'sheet-tabs layout-tabs' });
  const tools = h('span', { class: 'drawing-tools' });
  const status = h('div', { class: 'status' }, h('span', { class: 'spinner' }), 'Reading DWG …');
  ctx.container.classList.add('dwg-view');
  ctx.container.append(area, tabs);
  area.append(status);

  let opened: Extract<DwgResponse, { kind: 'open' }>;
  ctx.progress('Reading and converting DWG …');
  try {
    const buffer = await ctx.file.arrayBuffer();
    opened = (await session.call({ kind: 'open', buffer }, [buffer])) as Extract<DwgResponse, { kind: 'open' }>;
  } catch (error) {
    session.close();
    throw error;
  } finally {
    status.remove();
  }

  const banner = warningBanner(opened.warnings, opened.details, opened.recovered);
  if (banner) ctx.container.prepend(banner);
  const release = h('span', { class: 'meta' }, `DWG ${opened.release}`);
  ctx.toolbar.append(release, tools);

  let current: Viewer | null = null;
  let currentUrl = '';
  let token = 0;
  async function show(dxf: Uint8Array): Promise<void> {
    const mine = ++token;
    current?.destroy();
    current = null;
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    tools.replaceChildren();
    const sheet = h('div', { class: 'viewer-root drawing-sheet' });
    area.replaceChildren(sheet);
    currentUrl = URL.createObjectURL(new Blob([dxf as Uint8Array<ArrayBuffer>], { type: 'image/vnd.dxf' }));
    // The converter always writes DXF R2007 or later, which is UTF-8.
    const viewer = await mountDrawing({ ...ctx, container: sheet, toolbar: tools }, { url: currentUrl, encoding: 'utf-8' });
    if (mine !== token) viewer.destroy();
    else current = viewer;
  }

  const select = async (index: number, button: HTMLElement) => {
    for (const b of tabs.children) b.classList.toggle('on', b === button);
    area.replaceChildren(h('div', { class: 'status' }, h('span', { class: 'spinner' }), index < 0 ? 'Preparing model space …' : 'Preparing layout …'));
    try {
      const response = await session.call(index < 0 ? { kind: 'model' } : { kind: 'layout', index });
      await show(response.dxf);
    } catch (error) {
      area.replaceChildren(h('div', { class: 'status' }, h('div', { class: 'error-card' }, h('p', {}, error instanceof Error ? error.message : String(error)))));
    }
  };

  const modelTab = h('button', { type: 'button', class: 'sheet-tab on', onclick: () => select(-1, modelTab) }, 'Model');
  tabs.append(modelTab, ...opened.layouts.map((name, i) => {
    const tab: HTMLButtonElement = h('button', { type: 'button', class: 'sheet-tab', title: `Layout ${name}`, onclick: () => select(i, tab) }, name);
    return tab;
  }));
  tabs.hidden = opened.layouts.length === 0;

  try {
    await show(opened.dxf);
  } catch (error) {
    session.close();
    throw error;
  }

  return {
    destroy: () => {
      token++;
      current?.destroy();
      if (currentUrl) URL.revokeObjectURL(currentUrl);
      session.close();
    },
  };
}
