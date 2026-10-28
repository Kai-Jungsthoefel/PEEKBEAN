// SPDX-License-Identifier: GPL-3.0-or-later
// Start page: what the site does, where files go in, and which formats it reads (grouped, details on demand). The page
// of a single format (dwg-viewer.html …) names that format in its hero and says what the viewer shows of it.
import { pairPage } from './convert/catalog';
import { h } from './core/dom';
import { icon, type IconName } from './core/icons';
import { textViewer, viewers } from './core/registry';
import type { FormatCategory } from './core/types';
import { CATEGORY_TITLES, FORMAT_PAGES, formatConversions, formatPageName, formatPagePath, type FormatPage } from './format-pages';
import { issueLink, REPO_URL } from './github';

/** Every extension a viewer is registered for; the format list counts them to show the range. */
const ALL_EXTENSIONS = new Set([...viewers, textViewer].flatMap((v) => v.extensions));

const CATEGORIES: { id: FormatCategory; summary: string; icon: IconName }[] = [
  { id: 'documents', summary: 'PDF, Word, PowerPoint, Excel', icon: 'doc' },
  { id: 'cad', summary: 'DWG, DXF, STEP, IFC, STL, glTF', icon: 'cube' },
  { id: 'media', summary: 'Images, audio, video, fonts', icon: 'image' },
  { id: 'data', summary: 'Archives, SQLite, e-mail, HTML', icon: 'archive' },
];

export interface StartPageOptions {
  /** The format of the page, or null on the general start page. */
  format: FormatPage | null;
  openFiles(): void;
  /** Opens the explanation of why files never leave the device. */
  explainLocal(): void;
  footer: HTMLElement;
}

export function startPage({ format, openFiles, explainLocal, footer }: StartPageOptions): HTMLElement {
  const hero = h(
    'div',
    { class: 'hero' },
    h(
      'div',
      { class: 'hero-text' },
      h('span', { class: 'eyebrow' }, 'CLIENT-SIDE FILE VIEWER'),
      format ? h('h1', {}, 'View ', h('em', { class: 'any' }, format.label), ' files.') : h('h1', {}, 'View ', h('em', { class: 'any' }, 'ANY'), ' file.'),
      h('p', { class: 'lead' }, h('b', {}, 'Private and secure.'), format ? ` Your ${format.noun} open on your computer and are never uploaded.` : ' Everything stays on your computer.'),
      format?.limits && h('p', { class: 'lead-note' }, format.limits),
      h('button', { type: 'button', class: 'text-link', 'aria-haspopup': 'dialog', onclick: explainLocal }, 'How your files stay local', icon('chevRight', 16, 2)),
      format && h('a', { class: 'text-link', href: './' }, 'All formats', icon('chevRight', 16, 2)),
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
      h('b', { class: 'drop-title' }, format ? `Drop ${format.label} files here` : 'Drop any file here'),
      h('span', { class: 'drop-sub' }, 'or choose files from your computer'),
      h('button', { type: 'button', class: 'btn primary xl', onclick: openFiles }, icon('open', 20, 1.9), 'Open files'),
      h('span', { class: 'local-line' }, h('span', { class: 'dot' }), 'Opened locally on your device. Nothing is uploaded.'),
    ),
  );

  return h(
    'section',
    { class: 'start-body' },
    h('div', { class: 'start' }, hero, format && about(format), formats(), formatLinks(format), footer),
  );
}

/** What the format is next to what the viewer shows of it, and the conversions of its files. */
function about(format: FormatPage): HTMLElement {
  const conversions = formatConversions(format);
  return h(
    'section',
    { class: 'formats', 'aria-labelledby': 'about-title' },
    h('div', { class: 'formats-head' }, h('h2', { id: 'about-title' }, `About ${format.label} files`)),
    h(
      'div',
      { class: 'fp-about' },
      h('p', { class: 'fp-text' }, format.about),
      h('ul', { class: 'fp-features', 'aria-label': 'In the viewer' }, ...format.features.map((feature) => h('li', {}, icon('check', 16, 2), h('span', {}, feature)))),
    ),
    conversions.length > 0 &&
      h(
        'div',
        { class: 'fp-chips' },
        h('span', { class: 'c3' }, 'Convert:'),
        ...conversions.map((pair) => h('a', { class: 'cv-pair', href: pairPage(pair) }, pair.source.label, h('span', { class: 'c3' }, '→'), pair.target.label)),
      ),
  );
}

/** One card per category; a card opens the list of its formats below the cards (on phones right below the card). */
function formats(): HTMLElement {
  const grid = h('div', { class: 'fmt-grid' });
  const toggles: ((open: boolean) => void)[] = [];

  for (const category of CATEGORIES) {
    const title = CATEGORY_TITLES[category.id];
    const members = viewers.filter((v) => v.category === category.id);
    const panelId = `formats-${category.id}`;
    const panel = h(
      'div',
      { class: 'fmt-panel', id: panelId, role: 'region', 'aria-label': `${title} formats`, hidden: true },
      ...members.map((v) =>
        h('div', { class: 'fmt-item' }, h('span', { class: 'fmt-ico' }, icon(v.icon, 16)), h('div', {}, h('b', {}, v.label), h('span', { class: 'ext' }, v.extensions.map((e) => `.${e}`).join(' ')))),
      ),
    );
    const card = h(
      'button',
      { type: 'button', class: 'fmt-card', 'aria-expanded': 'false', 'aria-controls': panelId },
      h('span', { class: 'ico' }, icon(category.icon, 18)),
      h('span', { class: 'fmt-txt' }, h('b', {}, title), h('span', {}, category.summary)),
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

/** The pages of single formats, one row per category; they are also how search engines find those pages. */
function formatLinks(current: FormatPage | null): HTMLElement {
  return h(
    'section',
    { class: 'formats', 'aria-labelledby': 'pages-title' },
    h('div', { class: 'formats-head' }, h('h2', { id: 'pages-title' }, 'Viewers by format'), h('span', { class: 'c3' }, 'What each format is and what the viewer shows of it.')),
    h(
      'div',
      { class: 'fp-groups' },
      ...CATEGORIES.map((category) =>
        h(
          'div',
          { class: 'fp-group' },
          h('span', { class: 'fp-group-lbl' }, CATEGORY_TITLES[category.id]),
          h(
            'div',
            { class: 'fp-chips' },
            ...FORMAT_PAGES.filter((page) => page.category === category.id).map((page) =>
              h('a', { class: 'fp-link', href: formatPagePath(page), title: formatPageName(page), 'aria-current': page === current ? 'page' : undefined }, page.label),
            ),
          ),
        ),
      ),
    ),
  );
}
