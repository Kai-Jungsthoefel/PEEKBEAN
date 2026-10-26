// SPDX-License-Identifier: GPL-3.0-or-later
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { h } from '../core/dom';
import { hasRemoteResources } from '../core/sandbox';
import { readText } from '../core/text';
import type { ViewerContext } from '../core/types';
import { guardLinks } from './paged';

export async function mount({ file, container, toolbar }: ViewerContext) {
  const { text } = await readText(file);
  const html = DOMPurify.sanitize(await marked.parse(text, { gfm: true }));
  const article = h('article', { class: 'markdown-body' });
  article.innerHTML = html;
  guardLinks(article);

  const scroller = h('div', { class: 'markdown-scroll' }, article);
  if (hasRemoteResources(html)) {
    container.append(h('div', { class: 'banner' }, 'Images from the internet are not loaded.'));
  }
  container.append(scroller);
  const words = text.split(/\s+/).filter(Boolean).length;
  toolbar.append(h('span', { class: 'meta' }, `${words.toLocaleString('en-US')} words`));
  return { destroy: () => {} };
}
