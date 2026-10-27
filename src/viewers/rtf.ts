// SPDX-License-Identifier: GPL-3.0-or-later
// RTF documents with our own reader (rtf/parse.ts): sheets of the document's paper width, page and section breaks
// start a new sheet. Embedded EMF and WMF pictures are drawn by the metafile renderer of ooxml-pages (MIT).
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import { createPagedView } from './paged';
import { parseRtf } from './rtf/parse';

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  progress('Reading document …');
  const bytes = new Uint8Array(await file.arrayBuffer());
  // Some writers put a byte order mark or blank lines before the opening brace.
  const start = String.fromCharCode(...bytes.subarray(0, 64)).search(/\{\\rtf/);
  if (start < 0) throw new Error('This file is not an RTF document.');
  progress('Laying out text …');
  const doc = parseRtf(bytes.subarray(start));

  const view = createPagedView(container, toolbar);
  view.pages.classList.add('rtf-pages');
  view.pages.append(...doc.sheets);
  doc.layoutTabs();
  view.setNaturalWidth(doc.width);
  view.fitWidth();
  void doc.drawPictures();

  // Footnotes and bookmarks link within the document; scroll there without touching the page address.
  view.pages.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest('a[href^="#"]');
    if (!link) return;
    event.preventDefault();
    const target = document.getElementById(decodeURIComponent(link.getAttribute('href')!.slice(1)));
    if (target && view.pages.contains(target)) target.scrollIntoView({ block: 'center' });
  });

  const sheets = doc.sheets.length;
  const parts = [doc.info.title, sheets > 1 && `${sheets} pages`, `${doc.words.toLocaleString('en-US')} words`].filter(Boolean);
  toolbar.prepend(h('span', { class: 'meta', title: doc.info.title ? 'Document title' : undefined }, parts.join(' · ')));
  return { destroy: () => doc.destroy() };
}
