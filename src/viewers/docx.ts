// SPDX-License-Identifier: GPL-3.0-or-later
// Word viewer on top of ooxml-pages, which lays out the document like Word does and draws each page from
// absolutely positioned text and shapes. Pages render lazily near the viewport.
import { type DocxPhase, renderDocx } from 'ooxml-pages/docx';
import 'ooxml-pages/docx.css';
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import { createPagedView } from './paged';

const PHASES: Record<DocxPhase, string> = {
  read: 'Reading document …',
  parse: 'Reading content …',
  layout: 'Laying out pages …',
  relayout: 'Laying out pages again around floating objects …',
};

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  const view = createPagedView(container, toolbar);
  const doc = await renderDocx(file, view.pages, {
    root: view.scroller,
    onProgress: ({ phase, fraction }) => progress(PHASES[phase], fraction),
  });
  const { pages } = doc.layout;
  toolbar.prepend(h('span', { class: 'meta' }, `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`));
  view.setNaturalWidth(Math.max(...pages.map((p) => p.width)));
  view.fitWidth();
  return { destroy: () => doc.destroy() };
}
