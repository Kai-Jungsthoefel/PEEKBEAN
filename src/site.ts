// SPDX-License-Identifier: GPL-3.0-or-later
// Parts the viewer and the converter page share: switching between the two, the "Local only" status with its
// explanation, the color theme, the GitHub link, the footer and dropping files anywhere on the page.
import { h } from './core/dom';
import { icon, type IconName } from './core/icons';
import { onThemeChange, setThemePreference, themePreference, type ThemePreference } from './core/theme';
import { REPO_URL, SOURCE_URL } from './github';

const THEMES: { value: ThemePreference; icon: IconName; label: string }[] = [
  { value: 'system', icon: 'monitor', label: 'Follow system setting' },
  { value: 'light', icon: 'sun', label: 'Light' },
  { value: 'dark', icon: 'moon', label: 'Dark' },
];

export function brand(): HTMLElement {
  return h('span', { class: 'brand' }, h('span', { class: 'logo-tile' }, icon('logo', 18, 1.8)), h('b', { class: 'brand-name' }, 'OPSIS'));
}

/** Viewer and converter as a segmented control; links, so each part has its own address. */
export function siteNav(current: 'view' | 'convert'): HTMLElement {
  const link = (id: 'view' | 'convert', href: string, label: string) =>
    h('a', { href, 'aria-current': id === current ? 'page' : undefined }, label);
  return h('nav', { class: 'site-nav', 'aria-label': 'Site' }, link('view', './', 'View'), link('convert', 'convert.html', 'Convert'));
}

/** The light, dark or system theme as a segmented control, and as one button that cycles through them on phones. */
export function themeControls(): HTMLElement[] {
  const group = h('div', { class: 'theme-seg', role: 'radiogroup', 'aria-label': 'Color theme' });
  const cycle = h('button', {
    type: 'button',
    class: 'ibtn theme-cycle',
    onclick: () => {
      const index = THEMES.findIndex((t) => t.value === themePreference());
      setThemePreference(THEMES[(index + 1) % THEMES.length].value);
    },
  });
  const render = () => {
    const current = themePreference();
    group.replaceChildren(
      ...THEMES.map((t) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(t.value === current), 'aria-label': t.label, title: t.label, onclick: () => setThemePreference(t.value) }, icon(t.icon, 15, 1.8)),
      ),
    );
    const theme = THEMES.find((t) => t.value === current)!;
    cycle.replaceChildren(icon(theme.icon, 20, 1.8));
    cycle.setAttribute('aria-label', `Color theme: ${theme.label}. Change theme`);
    cycle.title = `Color theme: ${theme.label}`;
  };
  render();
  onThemeChange(render);
  return [group, cycle];
}

/** Repository link with its star count, like on SOMA's website. The count is from the build (vite.config.ts). */
export function githubLink(): HTMLElement | null {
  if (!REPO_URL) return null;
  const stars = __GITHUB_STARS__ === null ? '' : new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(__GITHUB_STARS__);
  return h(
    'a',
    { class: 'btn gh-link', href: REPO_URL, target: '_blank', rel: 'noopener noreferrer', title: 'Source code and issues on GitHub', 'aria-label': stars ? `GitHub, ${stars} stars` : 'GitHub' },
    icon('github', 16, 1.8),
    h('span', { class: 'gh-lbl' }, 'GitHub'),
    stars && h('span', { class: 'gh-stars' }, icon('star', 13, 2), stars),
  );
}

/** "Local only" in the header; it opens why files never leave the device (a bottom sheet on phones). */
export class LocalStatus {
  readonly button = h(
    'button',
    { type: 'button', class: 'local-status', 'aria-haspopup': 'dialog', title: 'How your files stay on this device', onclick: () => this.explain() },
    h('span', { class: 'dot' }),
    h('span', { class: 'ls-text' }, 'Local only'),
  );
  readonly dialog = this.buildDialog();

  /** Opens the explanation below the header status. */
  explain(): void {
    const anchor = this.button.getBoundingClientRect();
    this.dialog.style.setProperty('--pop-top', `${anchor.bottom + 6}px`);
    this.dialog.style.setProperty('--pop-right', `${Math.max(8, window.innerWidth - anchor.right)}px`);
    this.dialog.showModal();
  }

  private buildDialog(): HTMLDialogElement {
    const fact = (num: string, title: string, text: string) => h('li', {}, h('span', { class: 'num' }, num), h('div', {}, h('b', {}, title), h('span', {}, text)));
    const dialog = h(
      'dialog',
      { class: 'pop local-pop', 'aria-labelledby': 'local-title' },
      h(
        'div',
        // Focus starts on the text, not on the close button, so opening shows no focus ring.
        { class: 'dialog-body', tabindex: '-1', autofocus: true },
        h('div', { class: 'dialog-hd' }, h('b', { id: 'local-title' }, 'Your files stay on this device'), h('span', { class: 'grow' }), h('button', { type: 'button', class: 'hb', 'aria-label': 'Close', onclick: () => dialog.close() }, icon('close', 14, 2.2))),
        h(
          'ol',
          { class: 'local-facts' },
          fact('01', 'No upload', 'Files are read and processed locally on your device. The server only sees which parts of the viewer your browser downloads, such as the PDF viewer, never your files or their names.'),
          fact('02', 'Protected by your browser', 'Your browser itself makes sure this page cannot send data to other websites.'),
          fact('03', 'Open source', 'GPL-3.0. Anyone can check the code.'),
        ),
        SOURCE_URL && h('a', { class: 'link', href: SOURCE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'View source code'),
      ),
    );
    // A click on the backdrop lands on the dialog element itself.
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    });
    return dialog;
  }
}

export function siteFooter(): HTMLElement {
  return h(
    'footer',
    { class: 'foot' },
    h('span', {}, `Version ${__APP_VERSION__} (${__GIT_COMMIT__})`),
    h('a', { href: 'https://www.gnu.org/licenses/gpl-3.0.html', target: '_blank', rel: 'noopener noreferrer' }, 'GPL-3.0-or-later'),
    SOURCE_URL && h('a', { href: SOURCE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Source code'),
    h('a', { href: 'third-party-licenses.txt', target: '_blank' }, 'Third-party licenses'),
  );
}

/** Takes files dropped anywhere on the page; returns the overlay shown while they are dragged over it. */
export function fileDrop(label: string, onFiles: (files: File[]) => void): HTMLElement {
  const overlay = h('div', { class: 'drop-overlay', 'aria-hidden': 'true' }, h('div', { class: 'drop-card' }, icon('drop', 28, 1.6), h('b', {}, label)));
  let depth = 0;
  const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    overlay.classList.add('visible');
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove('visible');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('visible');
    onFiles([...(e.dataTransfer?.files ?? [])]);
  });
  return overlay;
}
