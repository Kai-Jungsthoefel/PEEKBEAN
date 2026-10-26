// SPDX-License-Identifier: GPL-3.0-or-later
import { h } from '../core/dom';
import { hasRemoteResources, sandboxedFrame } from '../core/sandbox';
import { readText } from '../core/text';
import type { ViewerContext } from '../core/types';

export async function mount({ file, container, toolbar }: ViewerContext) {
  const { text, encoding } = await readText(file);
  container.classList.add('html-view');
  if (hasRemoteResources(text)) {
    container.append(h('div', { class: 'banner' }, 'External images, fonts and scripts were blocked, so the page may look incomplete.'));
  }
  container.append(sandboxedFrame(text, file.name));
  toolbar.append(h('span', { class: 'meta', title: 'The page runs isolated: without scripts and without network access.' }, `Scripts off · ${encoding}`));
  return { destroy: () => {} };
}
