// SPDX-License-Identifier: GPL-3.0-or-later
// Word viewer: our own renderer (src/viewers/docx/) lays out the document like Word does (lines, pages, columns,
// tables, floating objects, headers and footers, notes) and draws each page from absolutely positioned text and
// shapes. DrawingML shapes, charts and SmartArt use the PowerPoint renderer. Pages render lazily near the viewport.
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import { loadDocument } from './docx/document';
import { loadEmbeddedFonts } from './docx/fonts';
import { type FlowContext, PageFlow, type PageBox, loadHeaders, sections } from './docx/flow';
import { createContext, defaultSection, emptyNotes, parseBlocks, parseSection } from './docx/parse';
import { pageNumberText } from './docx/line';
import { type RenderShared, renderPage } from './docx/render';
import { kid } from './docx/xml';
import { createPagedView } from './paged';
import './pptx/pptx.css';
import './docx/docx.css';

/** How far outside the visible area pages are prepared, in CSS px of the scroll container. */
const PRELOAD_MARGIN = '1600px 0px';

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  progress('Reading document …');
  const doc = await loadDocument(file);
  let fonts: Awaited<ReturnType<typeof loadEmbeddedFonts>> | null = null;
  try {
    // Embedded fonts first: every measurement depends on them.
    fonts = await loadEmbeddedFonts(doc.pkg, doc.fontTable);
    progress('Reading content …');
    await tick();
    const notes = emptyNotes();
    const totals = { used: false };
    const blocks = parseBlocks(doc.body, { ...createContext(doc, doc.source, notes, true), totals });
    const finalSect = kid(doc.body, 'sectPr');
    const runs = sections(blocks, finalSect ? parseSection(finalSect, doc.source) : defaultSection());
    const headers = await loadHeaders(doc, runs);

    const flow: FlowContext = {
      doc, notes, stories: new Map(), pageNumber: { value: 1, text: '1', fmt: 'decimal', total: 99, sectionPages: 9 }, budget: { lines: 3_000_000 },
      bookmarks: new Map(), sectionCounts: [], headers,
    };
    /** Page numbers the next pass (and the drawing) uses for NUMPAGES, SECTIONPAGES and PAGEREF. */
    const learn = (pages: PageBox[]) => {
      flow.pageNumber.total = pages.length;
      flow.sectionCounts = [];
      flow.bookmarks = new Map();
      for (const page of pages) {
        flow.sectionCounts[page.sectionIndex] = (flow.sectionCounts[page.sectionIndex] ?? 0) + 1;
        for (const [name] of page.bookmarks) if (!flow.bookmarks.has(name)) flow.bookmarks.set(name, pageNumberText(page.number, page.section.pgNumFmt));
      }
    };
    const layout = async (pre: Map<number, Map<number, never>>, pass: number) => {
      const late = new Map();
      const pageFlow = new PageFlow(flow, pre, late);
      flow.budget.lines = 3_000_000;
      const pages = await pageFlow.run(runs, async (fraction) => {
        progress(pass === 1 ? 'Laying out pages …' : 'Laying out pages again around floating objects …', fraction);
        await tick();
      });
      return { pageFlow, pages, late };
    };
    let result = await layout(new Map(), 1);
    learn(result.pages);
    // Floating objects found below text they should push aside, or page totals and page references in the
    // text: lay out once more with them known.
    if (result.late.size || totals.used) {
      result = await layout(result.late as Map<number, Map<number, never>>, 2);
      learn(result.pages);
    }
    const { pages, pageFlow } = result;
    if (!pages.length) throw new Error('The document contains no content that can be displayed.');

    const view = createPagedView(container, toolbar);
    view.pages.classList.add('docx-doc');
    const shared: RenderShared = { doc, flow, pages, pageFlow, parsed: new WeakMap() };
    const elements = pages.map((page: PageBox) => {
      const el = h('div', { class: 'docx-page', 'data-state': 'pending' });
      el.style.width = `${page.width}px`;
      el.style.height = `${page.height}px`;
      view.pages.append(el);
      return el;
    });
    toolbar.prepend(h('span', { class: 'meta' }, `${pages.length} ${pages.length === 1 ? 'page' : 'pages'}`));
    view.setNaturalWidth(Math.max(...pages.map((p) => p.width)));
    view.fitWidth();

    let queue: Promise<void> = Promise.resolve();
    let destroyed = false;
    const render = (index: number) => {
      const el = elements[index];
      if (el.dataset.state !== 'pending') return;
      el.dataset.state = 'loading';
      queue = queue.then(async () => {
        if (destroyed) return;
        try {
          const pending = renderPage(pages[index], el, shared);
          // Objects add the pictures they wait for while they render.
          while (pending.length) await Promise.allSettled(pending.splice(0));
          el.dataset.state = 'done';
        } catch (error) {
          console.error(error);
          el.replaceChildren(h('div', { class: 'pptx-error' }, 'This page could not be displayed.'));
          el.dataset.state = 'error';
        }
      });
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          observer.unobserve(entry.target);
          render(elements.indexOf(entry.target as HTMLDivElement));
        }
      },
      { root: view.scroller, rootMargin: PRELOAD_MARGIN },
    );
    elements.forEach((el) => observer.observe(el));

    // Links to bookmarks inside the document (tables of contents, cross references).
    const onClick = (event: MouseEvent) => {
      const link = (event.target as HTMLElement).closest<HTMLElement>('a[data-anchor]');
      if (!link) return;
      event.preventDefault();
      const name = link.dataset.anchor;
      const index = pages.findIndex((p) => p.bookmarks.some(([n]) => n === name));
      if (index < 0) return;
      const target = elements[index];
      const y = pages[index].bookmarks.find(([n]) => n === name)?.[1] ?? 0;
      const zoom = Number(view.pages.style.zoom) || 1;
      view.scroller.scrollTo({ top: (target.offsetTop + y - 24) * zoom, behavior: 'smooth' });
    };
    view.pages.addEventListener('click', onClick);

    return {
      destroy: () => {
        destroyed = true;
        observer.disconnect();
        view.pages.removeEventListener('click', onClick);
        doc.media.revokeAll();
        doc.pkg.close();
        fonts?.release();
      },
    };
  } catch (error) {
    doc.media.revokeAll();
    doc.pkg.close();
    fonts?.release();
    throw error;
  }
}
