// SPDX-License-Identifier: GPL-3.0-or-later
// PowerPoint viewer: our own renderer (src/viewers/pptx/) reads the package and builds each slide from
// HTML text, SVG shapes and <img> pictures. Slides render lazily as they come near the viewport.
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import { createPagedView } from './paged';
import { type Deck, loadDeck, renderSlide } from './pptx/slide';
import './pptx/pptx.css';

/** How far outside the visible area slides are prepared, in CSS px of the scroll container. */
const PRELOAD_MARGIN = '1200px 0px';

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  progress('Reading presentation …');
  const deck: Deck = await loadDeck(file, (fraction) => progress('Reading slides …', fraction));
  if (deck.slides.length === 0) {
    deck.pkg.close();
    throw new Error('The presentation contains no slides.');
  }

  const view = createPagedView(container, toolbar);
  view.pages.classList.add('slides');
  const { width, height } = deck;
  const slides = deck.slides.map((ref, i) => {
    const el = h('div', { class: 'ev-slide pptx-slide', 'data-state': 'pending' });
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    const caption = ref.hidden ? `Slide ${i + 1} (hidden)` : `Slide ${i + 1}`;
    view.pages.append(h('figure', { class: 'slide-frame' }, el, h('figcaption', {}, caption)));
    return el;
  });
  const count = deck.slides.length;
  toolbar.prepend(h('span', { class: 'meta' }, `${count} ${count === 1 ? 'slide' : 'slides'}`));
  view.setNaturalWidth(width);
  view.fitWidth();

  // One slide at a time: decoding several large pictures at once would only make every slide slower.
  let queue: Promise<void> = Promise.resolve();
  let destroyed = false;
  const render = (index: number) => {
    const el = slides[index];
    el.dataset.state = 'loading';
    queue = queue.then(async () => {
      if (destroyed) return;
      try {
        const pending = await renderSlide(deck, index, el);
        await Promise.allSettled(pending);
        el.dataset.state = 'done';
      } catch (error) {
        console.error(error);
        el.replaceChildren(h('div', { class: 'pptx-error' }, 'This slide could not be displayed.'));
        el.dataset.state = 'error';
      }
    });
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        render(slides.indexOf(entry.target as HTMLDivElement));
      }
    },
    { root: view.scroller, rootMargin: PRELOAD_MARGIN },
  );
  slides.forEach((el) => observer.observe(el));

  return {
    destroy: () => {
      destroyed = true;
      observer.disconnect();
      deck.media.revokeAll();
      deck.pkg.close();
    },
  };
}
