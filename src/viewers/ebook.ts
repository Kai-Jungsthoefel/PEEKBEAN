// SPDX-License-Identifier: GPL-3.0-or-later
// E-books (EPUB 2 and 3, FictionBook 2) with our own reader: the chapters in reading order in one scrolling column,
// each in a shadow root with the book's sanitized style sheets, drawn when it comes near the visible area. Table of
// contents beside the text (a drawer on phones), text size, light and dark theme. Fixed-layout pages are scaled to fit.
import { extensionOf } from '../core/bytes';
import { h, setPressed, toolButton } from '../core/dom';
import { icon } from '../core/icons';
import type { ViewerContext } from '../core/types';
import { type Book, type TocEntry, fragmentOf, resolvePath } from './ebook/book';
import { openEpub } from './ebook/epub';
import { openFb2 } from './ebook/fb2';
import { ChapterRenderer } from './ebook/render';
import { guardLinks } from './paged';

/** Same breakpoint as the phone layout in styles.css. */
const PHONE = window.matchMedia('(max-width: 639px)');
const SIZES = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5, 1.7, 2];
const SIZE_KEY = 'ev-ebook-size';
const XLINK = 'http://www.w3.org/1999/xlink';

// Reader defaults inside each chapter; the book's own style sheets come after and win.
const BASE_CSS = `
html { display: block; color: inherit; font: inherit; line-height: 1.6; overflow-wrap: break-word; }
body { display: block; margin: 0; }
a { color: var(--ebook-link); }
pre { white-space: pre-wrap; }
table { border-collapse: collapse; }
`;
// Only for flowing text: pictures fit the column and the window. Fixed-layout pages keep their own sizes.
const REFLOW_CSS = `
img, svg, video { max-width: 100%; }
img, video { height: auto; }
img, svg { max-height: 92vh; }
img { object-fit: contain; }
table { max-width: 100%; }
`;
let baseSheets: [CSSStyleSheet, CSSStyleSheet] | null = null;
let books = 0;

interface Slot {
  host: HTMLElement;
  path: string;
  fixed: boolean;
  state: 'empty' | 'loading' | 'done';
  done?: Promise<void>;
  root?: ShadowRoot;
  page?: HTMLElement;
  viewport?: { width: number; height: number } | null;
}

interface TocRow {
  button: HTMLButtonElement;
  slot: number;
  fragment: string;
  label: string;
}

function readSize(): number {
  try {
    const index = Number(localStorage.getItem(SIZE_KEY));
    return Number.isInteger(index) && index >= 0 && index < SIZES.length && localStorage.getItem(SIZE_KEY) !== null ? index : 2;
  } catch {
    return 2;
  }
}

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  progress('Opening book …');
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const fb2 = extensionOf(file.name) === 'fb2' || /<FictionBook\b/.test(String.fromCharCode(...head));
  const book: Book = fb2 ? await openFb2(file) : await openEpub(file);
  const renderer = new ChapterRenderer(book, `ebook${++books}`);
  try {
    progress('Reading style sheets …');
    await renderer.prepare();
    return await show(book, renderer, container, toolbar);
  } catch (error) {
    renderer.dispose();
    await book.close();
    throw error;
  }
}

async function show(book: Book, renderer: ChapterRenderer, container: HTMLElement, toolbar: HTMLElement) {
  if (!baseSheets) {
    baseSheets = [new CSSStyleSheet(), new CSSStyleSheet()];
    baseSheets[0].replaceSync(BASE_CSS);
    baseSheets[1].replaceSync(REFLOW_CSS);
  }
  const [baseSheet, reflowSheet] = baseSheets;
  const column = h('div', { class: 'ebook-column', lang: book.meta.language || undefined, dir: book.direction === 'rtl' ? 'rtl' : undefined });
  const scroller = h('div', { class: 'ebook-scroll', tabindex: '0' }, column);
  const side = h('aside', { class: 'ebook-side', 'aria-label': 'Table of contents' });
  const backdrop = h('div', { class: 'ebook-backdrop' });
  const root = h('div', { class: book.spine.every((s) => s.fixed) ? 'ebook fixed-layout' : 'ebook' }, side, backdrop, scroller);
  container.append(root);

  // Where the reader is: the current entry of the table of contents (see track()).
  const where = h('span', { class: 'meta ebook-where' });
  const rows: TocRow[] = [];
  let active: TocRow | null = null;
  let frame = 0;

  // ---- Chapters ----

  const slots: Slot[] = [];
  // The cover comes first, unless the first page shows it already.
  if (book.cover) {
    const first = (await book.text(book.spine[0].path)) ?? '';
    const name = book.cover.split('/').pop()!;
    if (!first.includes(name) && !first.includes(encodeURI(name))) {
      const url = await renderer.resource(book.cover);
      if (url) slots.push({ host: h('section', { class: 'ebook-chapter ebook-cover' }, h('img', { src: url, alt: 'Cover' })), path: '', fixed: false, state: 'done' });
    }
  }
  for (const item of book.spine) {
    const host = h('section', { class: item.fixed ? 'ebook-chapter fixed' : 'ebook-chapter' });
    // Until it is drawn, a chapter keeps a height estimated from its size, so the scroll bar is roughly right.
    if (item.fixed) host.style.aspectRatio = '1 / 1.41';
    else host.style.minHeight = `${Math.max(4, Math.round(item.size * 0.018))}em`;
    slots.push({ host, path: item.path, fixed: item.fixed, state: 'empty' });
  }
  column.append(...slots.map((s) => s.host));

  const fitPage = (slot: Slot) => {
    if (!slot.page || !slot.viewport) return;
    const { width, height } = slot.viewport;
    // The whole page in the window, unless that makes a tall page narrower than half the column.
    const widthFit = Math.min(column.clientWidth, 1100, width * 2) / width;
    const scale = Math.min(widthFit, Math.max((scroller.clientHeight - 48) / height, widthFit / 2));
    slot.host.style.width = `${width * scale}px`;
    slot.host.style.height = `${height * scale}px`;
    slot.page.style.cssText = `width:${width}px;height:${height}px;overflow:hidden;position:relative;transform:scale(${scale});transform-origin:0 0`;
  };

  const load = (slot: Slot): Promise<void> => {
    if (slot.state !== 'empty') return slot.done ?? Promise.resolve();
    slot.state = 'loading';
    const item = book.spine.find((s) => s.path === slot.path)!;
    slot.done = renderer
      .chapter(item)
      .then((chapter) => {
        const page = slot.fixed && chapter.viewport;
        const shadow = slot.host.attachShadow({ mode: 'open' });
        shadow.adoptedStyleSheets = page ? [baseSheet, ...chapter.sheets] : [baseSheet, reflowSheet, ...chapter.sheets];
        shadow.append(chapter.html);
        wireLinks(chapter.html, slot.path);
        slot.root = shadow;
        slot.host.style.minHeight = '';
        slot.host.style.aspectRatio = '';
        if (page) {
          slot.page = chapter.html;
          slot.viewport = chapter.viewport;
          fitPage(slot);
        } else {
          // A fixed-layout chapter without a page size flows like text.
          slot.host.classList.remove('fixed');
        }
        root.classList.toggle('paper', renderer.colors);
      })
      .catch((error) => {
        console.error(error);
        slot.host.style.minHeight = '';
        slot.host.replaceChildren(h('p', { class: 'ebook-broken' }, `This chapter could not be read (${slot.path}).`));
      })
      .finally(() => {
        slot.state = 'done';
      });
    return slot.done;
  };

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) void load(slots[Number((entry.target as HTMLElement).dataset.slot)]);
      }
    },
    { root: scroller, rootMargin: '150% 0px' },
  );
  slots.forEach((slot, i) => {
    slot.host.dataset.slot = String(i);
    observer.observe(slot.host);
  });
  // Pages are scaled again when the window changes; drawn chapters and pictures move the reading position.
  const resize = new ResizeObserver(() => {
    slots.forEach(fitPage);
    schedule();
  });
  resize.observe(column);

  // ---- Navigation ----

  const slotOf = (path: string) => slots.findIndex((s) => s.path === path);

  async function goTo(path: string, fragment = ''): Promise<void> {
    const index = slotOf(path);
    if (index < 0) return;
    const slot = slots[index];
    await load(slot);
    const target = (fragment && slot.root && (slot.root.getElementById(fragment) ?? slot.root.querySelector(`[name="${CSS.escape(fragment)}"]`))) || slot.host;
    target.scrollIntoView({ block: 'start' });
    // Chapters above may still grow as they are drawn; scroll anchoring keeps the target in place, this catches the rest.
    requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
  }

  /** Links inside the book jump there; web, mail and phone links open in a new tab (guardLinks). */
  function wireLinks(html: HTMLElement, base: string): void {
    guardLinks(html);
    html.addEventListener('click', (event) => {
      const link = (event.target as Element).closest('a');
      if (!link) return;
      const href = link.getAttribute('href') ?? link.getAttributeNS(XLINK, 'href') ?? '';
      event.preventDefault();
      if (!href || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
      void goTo(href.startsWith('#') ? base : resolvePath(base, href), fragmentOf(href));
    });
  }

  // ---- Table of contents ----

  const entries: TocEntry[] = book.toc.length ? book.toc : book.spine.map((s, i) => ({ label: `Section ${i + 1}`, target: s.path, children: [] }));
  const list = (items: TocEntry[], depth: number): HTMLElement =>
    h(
      'ul',
      {},
      ...items.map((entry) => {
        const [path] = entry.target.split('#');
        const fragment = fragmentOf(entry.target);
        const button = h('button', { type: 'button', class: 'ebook-toc-item', style: `--depth:${depth}`, title: entry.label, onclick: () => {
          void goTo(path, fragment);
          if (PHONE.matches) setContents(false);
        } }, entry.label);
        rows.push({ button, slot: slotOf(path), fragment, label: entry.label });
        return h('li', {}, button, entry.children.length ? list(entry.children, depth + 1) : null);
      }),
    );
  const coverUrl = book.cover ? await renderer.resource(book.cover) : null;
  const creators = book.meta.creators.join(', ');
  side.append(
    h(
      'div',
      { class: 'ebook-about' },
      coverUrl && h('img', { class: 'ebook-thumb', src: coverUrl, alt: '' }),
      h('div', {}, h('b', {}, book.meta.title || 'Untitled'), creators && h('span', {}, creators)),
      h('button', { type: 'button', class: 'hb ebook-close', 'aria-label': 'Close table of contents', onclick: () => setContents(false) }, icon('close', 14, 2)),
    ),
    h('nav', { class: 'ebook-toc' }, list(entries, 0)),
  );

  const contentsButton = h('button', { type: 'button', class: 'btn sm pin', title: 'Table of contents', onclick: () => setContents(!root.classList.contains('contents')) }, icon('toc', 15), h('span', { class: 'lbl' }, 'Contents'));
  function setContents(open: boolean): void {
    root.classList.toggle('contents', open);
    setPressed(contentsButton, open);
  }
  backdrop.addEventListener('click', () => setContents(false));
  setContents(!PHONE.matches && entries.length > 1);

  // ---- Text size ----

  let size = readSize();
  const sizeLabel = h('span', { class: 'meta zoom-label' });
  const setSize = (index: number) => {
    // Keep the place: the same share of the same chapter stays at the top.
    const top = scroller.scrollTop;
    const current = slots.find((s) => s.host.offsetTop + s.host.offsetHeight > top);
    const ratio = current ? (top - current.host.offsetTop) / Math.max(1, current.host.offsetHeight) : 0;
    size = Math.max(0, Math.min(SIZES.length - 1, index));
    root.style.setProperty('--ebook-scale', String(SIZES[size]));
    sizeLabel.textContent = `${Math.round(SIZES[size] * 100)} %`;
    if (current) scroller.scrollTop = current.host.offsetTop + ratio * current.host.offsetHeight;
    try {
      localStorage.setItem(SIZE_KEY, String(size));
    } catch {
      // Not stored; the size still holds for this book.
    }
  };
  setSize(size);

  // ---- Where the reader is ----

  function track(): void {
    frame = 0;
    const line = scroller.clientHeight * 0.2;
    const top = scroller.scrollTop + line;
    let current = 0;
    for (let i = 0; i < slots.length; i++) if (slots[i].host.offsetTop <= top) current = i;
    let found: TocRow | null = null;
    let firstInSlot = true;
    for (const row of rows) {
      if (row.slot < 0 || row.slot > current) continue;
      if (row.slot === current && row.fragment) {
        // Entries further down in the chapter count once the reader has reached them.
        const el = slots[current].root?.getElementById(row.fragment);
        const below = el ? el.getBoundingClientRect().top - scroller.getBoundingClientRect().top > line : !firstInSlot;
        if (row.slot === current) firstInSlot = false;
        if (below) continue;
      } else if (row.slot === current) {
        firstInSlot = false;
      }
      if (!found || row.slot >= found.slot) found = row;
    }
    if (found === active) return;
    active?.button.removeAttribute('aria-current');
    active = found;
    where.textContent = found?.label ?? '';
    if (!found) return;
    found.button.setAttribute('aria-current', 'true');
    // Keep the entry visible in the list without scrolling the page.
    const nav = side.querySelector<HTMLElement>('.ebook-toc')!;
    const b = found.button.offsetTop - nav.offsetTop;
    if (b < nav.scrollTop || b > nav.scrollTop + nav.clientHeight - 40) nav.scrollTop = b - nav.clientHeight / 3;
  };
  function schedule(): void {
    frame ||= requestAnimationFrame(track);
  }
  scroller.addEventListener('scroll', schedule, { passive: true });

  toolbar.append(
    contentsButton,
    toolButton('A−', 'Smaller text', () => setSize(size - 1)),
    sizeLabel,
    toolButton('A+', 'Larger text', () => setSize(size + 1)),
    where,
  );

  await Promise.all(slots.slice(0, 2).map(load));
  schedule();

  return {
    destroy: () => {
      observer.disconnect();
      resize.disconnect();
      if (frame) cancelAnimationFrame(frame);
      renderer.dispose();
      void book.close();
    },
  };
}
