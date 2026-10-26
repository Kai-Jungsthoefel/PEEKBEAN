// SPDX-License-Identifier: GPL-3.0-or-later
// PowerPoint viewer on top of ooxml-pages, which builds each slide from HTML text, SVG shapes and <img>
// pictures. Slides render lazily as they come near the viewport.
import { renderPptx } from 'ooxml-pages/pptx';
import 'ooxml-pages/pptx.css';
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import { createPagedView } from './paged';

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  progress('Reading presentation …');
  const view = createPagedView(container, toolbar);
  view.pages.classList.add('slides');
  const deck = await renderPptx(file, view.pages, {
    root: view.scroller,
    onProgress: (fraction) => progress('Reading slides …', fraction),
    frame: (slide, { index, hidden }) => h('figure', { class: 'slide-frame' }, slide, h('figcaption', {}, hidden ? `Slide ${index + 1} (hidden)` : `Slide ${index + 1}`)),
  });
  const count = deck.slides.length;
  toolbar.prepend(h('span', { class: 'meta' }, `${count} ${count === 1 ? 'slide' : 'slides'}`));
  view.setNaturalWidth(deck.presentation.width);
  view.fitWidth();
  return { destroy: () => deck.destroy() };
}
