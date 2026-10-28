// SPDX-License-Identifier: GPL-3.0-or-later
// Start page: what the site does, where files go in, and which formats it reads (grouped, details on demand).
import { h } from './core/dom';
import { icon, type IconName } from './core/icons';
import { textViewer, viewers } from './core/registry';
import type { FormatCategory } from './core/types';
import { issueLink, REPO_URL } from './github';

/** Every extension a viewer is registered for; the format list counts them to show the range. */
const ALL_EXTENSIONS = new Set([...viewers, textViewer].flatMap((v) => v.extensions));

const CATEGORIES: { id: FormatCategory; title: string; summary: string; icon: IconName }[] = [
  { id: 'documents', title: 'Documents', summary: 'PDF, Word, PowerPoint, Excel', icon: 'doc' },
  { id: 'cad', title: 'CAD and 3D', summary: 'DWG, DXF, STEP, IFC, STL, glTF', icon: 'cube' },
  { id: 'media', title: 'Media', summary: 'Images, audio, video, fonts', icon: 'image' },
  { id: 'data', title: 'Data and web', summary: 'Archives, SQLite, e-mail, HTML', icon: 'archive' },
];

export interface StartPageOptions {
  openFiles(): void;
  /** Opens the explanation of why files never leave the device. */
  explainLocal(): void;
  footer: HTMLElement;
}

export function startPage({ openFiles, explainLocal, footer }: StartPageOptions): HTMLElement {
  const hero = h(
    'div',
    { class: 'hero' },
    h(
      'div',
      { class: 'hero-text' },
      h('span', { class: 'eyebrow' }, 'CLIENT-SIDE FILE VIEWER'),
      h('h1', {}, 'View ', h('em', { class: 'any' }, 'ANY'), ' file.'),
      h('p', { class: 'lead' }, h('b', {}, 'Private and secure.'), ' Everything stays on your computer.'),
      h('button', { type: 'button', class: 'text-link', 'aria-haspopup': 'dialog', onclick: explainLocal }, 'How your files stay local', icon('chevRight', 16, 2)),
      // On phones the header has no room for the site navigation.
      h('a', { class: 'text-link site-switch', href: 'convert.html' }, 'Convert files instead', icon('chevRight', 16, 2)),
    ),
    h(
      'div',
      {
        class: 'dropzone',
        // A click anywhere in the zone opens the picker; the button inside handles its own click.
        onclick: (event: MouseEvent) => {
          if (!(event.target as Element).closest('button')) openFiles();
        },
      },
      h('span', { class: 'drop-ico' }, icon('drop', 26, 1.8)),
      h('b', { class: 'drop-title' }, 'Drop any file here'),
      h('span', { class: 'drop-sub' }, 'or choose files from your computer'),
      h('button', { type: 'button', class: 'btn primary xl', onclick: openFiles }, icon('open', 20, 1.9), 'Open files'),
      h('span', { class: 'local-line' }, h('span', { class: 'dot' }), 'Opened locally on your device. Nothing is uploaded.'),
    ),
  );

  return h(
    'section',
    { class: 'start-body' },
    h('div', { class: 'start' }, hero, formats(), footer),
  );
}

/** One card per category; a card opens the list of its formats below the cards (on phones right below the card). */
function formats(): HTMLElement {
  const grid = h('div', { class: 'fmt-grid' });
  const toggles: ((open: boolean) => void)[] = [];

  for (const category of CATEGORIES) {
    const members = viewers.filter((v) => v.category === category.id);
    const panelId = `formats-${category.id}`;
    const panel = h(
      'div',
      { class: 'fmt-panel', id: panelId, role: 'region', 'aria-label': `${category.title} formats`, hidden: true },
      ...members.map((v) =>
        h('div', { class: 'fmt-item' }, h('span', { class: 'fmt-ico' }, icon(v.icon, 16)), h('div', {}, h('b', {}, v.label), h('span', { class: 'ext' }, v.extensions.map((e) => `.${e}`).join(' ')))),
      ),
    );
    const card = h(
      'button',
      { type: 'button', class: 'fmt-card', 'aria-expanded': 'false', 'aria-controls': panelId },
      h('span', { class: 'ico' }, icon(category.icon, 18)),
      h('span', { class: 'fmt-txt' }, h('b', {}, category.title), h('span', {}, category.summary)),
      h('span', { class: 'chev' }, icon('chevDown', 18, 2)),
    );
    const toggle = (open: boolean) => {
      card.setAttribute('aria-expanded', String(open));
      panel.hidden = !open;
    };
    card.addEventListener('click', () => {
      const open = card.getAttribute('aria-expanded') !== 'true';
      // One list at a time keeps the page short.
      for (const other of toggles) other(false);
      toggle(open);
    });
    toggles.push(toggle);
    grid.append(card, panel);
  }

  return h(
    'section',
    { class: 'formats', 'aria-labelledby': 'formats-title' },
    h('div', { class: 'formats-head' }, h('h2', { id: 'formats-title' }, h('span', { class: 'format-count' }, String(ALL_EXTENSIONS.size)), ' supported formats')),
    grid,
    h(
      'div',
      { class: 'fmt-rest' },
      h('span', { class: 'fmt-ico' }, icon('binary', 18)),
      h('span', {}, h('b', {}, 'Everything else opens too: '), 'as text with syntax highlighting, or as hex view.'),
      REPO_URL && h('a', { class: 'text-link', target: '_blank', rel: 'noopener noreferrer', ...issueLink() }, 'Suggest a format', icon('chevRight', 16, 2)),
    ),
  );
}
