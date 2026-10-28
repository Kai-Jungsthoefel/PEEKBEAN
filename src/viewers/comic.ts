// SPDX-License-Identifier: GPL-3.0-or-later
// Comic book archives (CBZ, CBR, CB7, CBT): the pictures inside, in name order, as one scrolling column of pages.
// Pages are unpacked only when they come near the visible area.
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import { openArchive, type Entry } from './archive';
import { createPagedView } from './paged';

const PICTURE = /\.(jpe?g|png|gif|webp|avif|bmp)$/i;
// "page2" before "page10", as file managers sort.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
// Placeholder shape until a page is loaded: a typical comic page.
const PAGE_RATIO = 1.5;

/** The pictures of a comic archive in reading order; the CBZ converter uses the same. */
export function comicPages(entries: Entry[]): Entry[] {
  return entries
    .filter((e) => PICTURE.test(e.name) && !e.name.startsWith('.') && !e.dir.startsWith('__MACOSX'))
    .sort((a, b) => collator.compare(a.dir + a.name, b.dir + b.name));
}

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  progress('Reading comic …');
  const archive = await openArchive(file);
  const pages = comicPages(archive.entries);
  if (pages.length === 0) {
    await archive.close();
    throw new Error('The comic archive contains no pictures.');
  }

  const view = createPagedView(container, toolbar);
  view.pages.classList.add('comic-pages');
  const urls: string[] = [];
  let pageWidth = 0;

  const frames = pages.map((entry, index) => {
    const img = h('img', { class: 'comic-img', alt: `Page ${index + 1}`, draggable: false });
    const frame = h('div', { class: 'comic-page', 'data-index': String(index) }, img);
    return { entry, frame, img, state: 'empty' as 'empty' | 'loading' | 'done' };
  });

  const sizeFrames = () => {
    for (const f of frames) {
      if (f.state === 'done') continue;
      f.frame.style.width = `${pageWidth}px`;
      f.frame.style.height = `${pageWidth * PAGE_RATIO}px`;
    }
  };

  const load = async (f: (typeof frames)[number]) => {
    if (f.state !== 'empty') return;
    f.state = 'loading';
    try {
      const url = URL.createObjectURL(await f.entry.read());
      urls.push(url);
      f.img.src = url;
      await f.img.decode();
      f.state = 'done';
      f.frame.style.width = `${f.img.naturalWidth}px`;
      f.frame.style.height = '';
      // The first page sets the width of the column and the placeholders.
      if (!pageWidth) {
        pageWidth = f.img.naturalWidth;
        view.setNaturalWidth(pageWidth);
        sizeFrames();
        view.fitWidth();
      }
    } catch {
      f.state = 'done';
      f.frame.classList.add('broken');
      f.frame.replaceChildren(h('span', {}, `Page ${frames.indexOf(f) + 1} could not be read.`));
    }
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void load(frames[Number((entry.target as HTMLElement).dataset.index)]);
      }
    },
    { root: view.scroller, rootMargin: '150% 0px' },
  );
  view.pages.append(...frames.map((f) => f.frame));
  await load(frames[0]);
  if (!pageWidth) pageWidth = 800;
  sizeFrames();
  for (const f of frames) observer.observe(f.frame);

  const pageSelect = h(
    'select',
    { title: 'Go to page', onchange: () => frames[Number(pageSelect.value)].frame.scrollIntoView({ block: 'start' }) },
    ...frames.map((_, i) => h('option', { value: String(i) }, `Page ${i + 1} of ${frames.length}`)),
  );
  // The select follows the page at the top of the view.
  view.scroller.addEventListener('scroll', () => {
    const top = view.scroller.getBoundingClientRect().top + 40;
    const current = frames.findIndex((f) => f.frame.getBoundingClientRect().bottom > top);
    if (current >= 0) pageSelect.value = String(current);
  }, { passive: true });
  toolbar.prepend(pageSelect);

  return {
    destroy: () => {
      observer.disconnect();
      for (const url of urls) URL.revokeObjectURL(url);
      void archive.close();
    },
  };
}
