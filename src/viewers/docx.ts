// SPDX-License-Identifier: GPL-3.0-or-later
import { renderAsync } from 'docx-preview';
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import { createPagedView } from './paged';

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  const view = createPagedView(container, toolbar);
  const styles = h('div', { class: 'docx-styles' });
  container.append(styles);
  view.pages.classList.add('docx-pages');

  progress('Rendering document …');
  await renderAsync(file, view.pages, styles, {
    className: 'docx',
    inWrapper: true,
    breakPages: true,
    ignoreLastRenderedPageBreak: true,
    renderHeaders: true,
    renderFooters: true,
    renderFootnotes: true,
    renderEndnotes: true,
    renderComments: false,
    // Embedded HTML chunks are rendered in frames; not worth the risk for a viewer.
    renderAltChunks: false,
    useBase64URL: false,
  });

  const sections = view.pages.querySelectorAll<HTMLElement>('section.docx');
  if (sections.length === 0) throw new Error('The document contains no content that can be displayed.');
  toolbar.prepend(h('span', { class: 'meta' }, `${sections.length} ${sections.length === 1 ? 'page' : 'pages'}`));
  view.setNaturalWidth(Math.max(...[...sections].map((s) => s.offsetWidth)));
  view.fitWidth();

  // docx-preview hands out blob: URLs for images; they belong to this document only.
  const urls = [...view.pages.querySelectorAll('img')].map((img) => img.src).filter((src) => src.startsWith('blob:'));
  return { destroy: () => urls.forEach((url) => URL.revokeObjectURL(url)) };
}
