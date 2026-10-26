// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionOf, formatBytes } from './core/bytes';
import { h, setPressed } from './core/dom';
import { icon, type IconName } from './core/icons';
import { detectViewer, hexViewer, textViewer, viewers } from './core/registry';
import { onThemeChange, setThemePreference, themePreference, type ThemePreference } from './core/theme';
import type { Viewer, ViewerDefinition } from './core/types';
import { InfoPanel } from './info-panel';
import { startPage } from './start-page';

interface OpenFile {
  id: number;
  file: File;
  /** Viewer chosen by the user; undefined means automatic detection. */
  chosenViewer?: string;
  /** Kind of file once detected, e.g. "DWG drawing". */
  kind?: string;
}

const THEMES: { value: ThemePreference; icon: IconName; label: string }[] = [
  { value: 'system', icon: 'monitor', label: 'Follow system setting' },
  { value: 'light', icon: 'sun', label: 'Light' },
  { value: 'dark', icon: 'moon', label: 'Dark' },
];

/** 2D drawings bake the background into their WebGL scene, so they are drawn again when the theme changes. */
const REDRAW_ON_THEME = new Set(['dxf', 'dwg']);

const SOURCE_URL = __SOURCE_URL__ ? `${__SOURCE_URL__}/tree/${__GIT_COMMIT__}` : '';

/** Icon for a tab, from the extension; the content check only happens when the file is shown. */
function iconFor(file: File): IconName {
  const ext = extensionOf(file.name);
  return [...viewers, textViewer].find((v) => v.extensions.includes(ext))?.icon ?? 'file';
}

/** Card over the viewer while it loads: what is happening, a progress bar and the time so far. */
class LoadingScreen {
  private readonly text = h('span', { class: 'lc-text' }, 'Loading …');
  private readonly bar = h('div', { class: 'lc-bar indet' }, h('div'));
  private readonly time = h('span', { class: 'lc-time' });
  private readonly started = performance.now();
  private readonly timer: number;
  readonly element: HTMLElement;

  constructor(file: File, kind: string) {
    this.element = h(
      'div',
      { class: 'loading', role: 'status', 'aria-live': 'polite' },
      h('div', { class: 'loading-card' }, h('div', { class: 'lc-hd' }, h('span', { class: 'spinner' }), h('b', { title: file.name }, file.name)), h('div', { class: 'lc-sub' }, this.text, this.time), this.bar, h('div', { class: 'lc-kind' }, `${kind} · ${formatBytes(file.size)}`)),
    );
    // Seconds appear once loading takes noticeably long, so a slow file never looks stuck.
    this.timer = window.setInterval(() => {
      const seconds = Math.round((performance.now() - this.started) / 1000);
      this.time.textContent = seconds >= 2 ? `${seconds} s` : '';
    }, 500);
  }

  update(message: string, fraction?: number): void {
    this.text.textContent = message;
    const determinate = fraction !== undefined && Number.isFinite(fraction);
    this.bar.classList.toggle('indet', !determinate);
    (this.bar.firstChild as HTMLElement).style.width = determinate ? `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%` : '';
  }

  close(): void {
    window.clearInterval(this.timer);
    this.element.remove();
  }
}

export class App {
  private files: OpenFile[] = [];
  private active: OpenFile | null = null;
  private viewer: Viewer | null = null;
  /** Viewer id of the file on screen, once known. */
  private shownViewerId: string | null = null;
  private mountToken = 0;
  private nextId = 1;
  /** The info panel stays open across files until it is closed. */
  private infoOpen = false;
  private readonly info = new InfoPanel(() => this.setInfo(false));
  /** Dims the file behind the info panel where the panel is a bottom sheet (phones). */
  private readonly infoBackdrop = h('div', { class: 'info-backdrop', onclick: () => this.setInfo(false) });
  private infoButton: HTMLButtonElement | null = null;
  private infoHost: HTMLElement | null = null;

  private readonly tabs = h('nav', { class: 'tabs', 'aria-label': 'Open files' });
  /** Stands in for the tabs on phones: the current file, opening the list of all open files. */
  private readonly switcher = h('button', { type: 'button', class: 'switcher', 'aria-haspopup': 'dialog', onclick: () => this.openFilesSheet() });
  private readonly localButton = h(
    'button',
    { type: 'button', class: 'local-status', 'aria-haspopup': 'dialog', title: 'How your files stay on this device', onclick: () => this.explainLocal() },
    h('span', { class: 'dot' }),
    h('span', { class: 'ls-text' }, 'Local only'),
  );
  private readonly themeGroup = h('div', { class: 'theme-seg', role: 'radiogroup', 'aria-label': 'Color theme' });
  private readonly themeCycle = h('button', { type: 'button', class: 'ibtn theme-cycle', onclick: () => this.cycleTheme() });
  private readonly header = this.buildHeader();
  private readonly stage = h('main', { class: 'stage' });
  private readonly picker = h('input', { type: 'file', multiple: true, hidden: true });
  private readonly localDialog = this.buildLocalDialog();
  private readonly filesDialog = h('dialog', { class: 'sheet files-sheet', 'aria-labelledby': 'files-title' });
  private readonly dropOverlay = h(
    'div',
    { class: 'drop-overlay', 'aria-hidden': 'true' },
    h('div', { class: 'drop-card' }, icon('drop', 28, 1.6), h('b', {}, 'Drop to open')),
  );

  constructor(root: HTMLElement) {
    root.append(this.header, this.stage, this.dropOverlay, this.picker, this.localDialog, this.filesDialog);
    this.picker.addEventListener('change', () => {
      this.open([...(this.picker.files ?? [])]);
      this.picker.value = '';
    });
    for (const dialog of [this.localDialog, this.filesDialog]) {
      // A click on the backdrop lands on the dialog element itself.
      dialog.addEventListener('click', (event) => {
        if (event.target === dialog) dialog.close();
      });
    }
    this.renderThemeControls();
    onThemeChange(() => {
      this.renderThemeControls();
      if (this.shownViewerId && REDRAW_ON_THEME.has(this.shownViewerId)) this.render();
    });
    this.installDragAndDrop();
    this.render();
  }

  open(newFiles: File[]): void {
    if (newFiles.length === 0) return;
    const entries = newFiles.map((file) => ({ id: this.nextId++, file }));
    this.files.push(...entries);
    this.activate(entries[0]);
  }

  private activate(entry: OpenFile | null): void {
    this.active = entry;
    this.render();
  }

  private close(entry: OpenFile): void {
    const index = this.files.indexOf(entry);
    this.files.splice(index, 1);
    if (this.active === entry) {
      this.activate(this.files[Math.min(index, this.files.length - 1)] ?? null);
    } else {
      this.renderTabs();
    }
  }

  private render(): void {
    this.renderTabs();
    this.unmount();
    this.stage.replaceChildren();
    if (this.active) {
      void this.show(this.active);
    } else {
      if (this.filesDialog.open) this.filesDialog.close();
      this.stage.append(startPage({ openFiles: () => this.picker.click(), explainLocal: () => this.explainLocal(), footer: this.footer() }));
    }
  }

  // ---- Header ------------------------------------------------------------------------------------------------------

  private buildHeader(): HTMLElement {
    return h(
      'header',
      { class: 'top' },
      h('span', { class: 'brand' }, h('span', { class: 'logo-tile' }, icon('logo', 18, 1.8)), h('b', { class: 'brand-name' }, 'Everything Viewer')),
      this.tabs,
      this.switcher,
      h('span', { class: 'grow' }),
      this.localButton,
      this.themeGroup,
      this.themeCycle,
      SOURCE_URL && h('a', { class: 'btn source-link', href: SOURCE_URL, target: '_blank', rel: 'noopener noreferrer' }, icon('code', 16, 1.8), 'Source code'),
    );
  }

  private renderTabs(): void {
    const count = this.files.length;
    this.header.classList.toggle('has-files', count > 0);
    this.tabs.hidden = count === 0;
    this.switcher.hidden = count === 0;
    this.tabs.replaceChildren(
      ...this.files.map((entry) => {
        const on = entry === this.active;
        return h(
          'div',
          { class: on ? 'tab on' : 'tab' },
          h('button', { type: 'button', class: 't', title: entry.file.name, 'aria-current': on ? 'page' : undefined, onclick: () => this.activate(entry) }, icon(iconFor(entry.file), 15), h('span', {}, entry.file.name)),
          h('button', { type: 'button', class: 'x', title: 'Close', 'aria-label': `Close ${entry.file.name}`, onclick: () => this.close(entry) }, icon('close', 13, 2.2)),
        );
      }),
      h('button', { type: 'button', class: 'tab-add', title: 'Open files', 'aria-label': 'Open files', onclick: () => this.picker.click() }, icon('plus', 16, 2)),
    );
    if (this.active) {
      const name = this.active.file.name;
      this.switcher.setAttribute('aria-label', `${name}, ${count} open ${count === 1 ? 'file' : 'files'}. Switch file`);
      this.switcher.replaceChildren(
        icon(iconFor(this.active.file), 18),
        h('span', { class: 'sw-name' }, name),
        h('span', { class: 'count' }, String(count)),
        icon('chevDown', 16, 2),
      );
    }
    if (this.filesDialog.open) this.renderFilesSheet();
  }

  private renderThemeControls(): void {
    const current = themePreference();
    this.themeGroup.replaceChildren(
      ...THEMES.map((t) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(t.value === current), 'aria-label': t.label, title: t.label, onclick: () => setThemePreference(t.value) }, icon(t.icon, 15, 1.8)),
      ),
    );
    const theme = THEMES.find((t) => t.value === current)!;
    this.themeCycle.replaceChildren(icon(theme.icon, 20, 1.8));
    this.themeCycle.setAttribute('aria-label', `Color theme: ${theme.label}. Change theme`);
    this.themeCycle.title = `Color theme: ${theme.label}`;
  }

  private cycleTheme(): void {
    const index = THEMES.findIndex((t) => t.value === themePreference());
    setThemePreference(THEMES[(index + 1) % THEMES.length].value);
  }

  // ---- Dialogs -----------------------------------------------------------------------------------------------------

  private buildLocalDialog(): HTMLDialogElement {
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
          fact('01', 'No upload', 'Files are read and processed locally on your device.'),
          fact('02', 'Protected by your browser', 'Your browser itself makes sure this page cannot send data to other websites.'),
          fact('03', 'Open source', 'GPL-3.0. Anyone can check the code.'),
        ),
        SOURCE_URL && h('a', { class: 'link', href: SOURCE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'View source code'),
      ),
    );
    return dialog;
  }

  /** Opens the explanation below the header status (a bottom sheet on phones). */
  private explainLocal(): void {
    const anchor = this.localButton.getBoundingClientRect();
    this.localDialog.style.setProperty('--pop-top', `${anchor.bottom + 6}px`);
    this.localDialog.style.setProperty('--pop-right', `${Math.max(8, window.innerWidth - anchor.right)}px`);
    this.localDialog.showModal();
  }

  private openFilesSheet(): void {
    this.renderFilesSheet();
    this.filesDialog.showModal();
  }

  private renderFilesSheet(): void {
    const count = this.files.length;
    this.filesDialog.replaceChildren(
      h(
        'div',
        { class: 'dialog-body' },
        h('div', { class: 'dialog-hd' }, h('b', { id: 'files-title' }, 'Open files'), h('span', { class: 'count' }, String(count)), h('span', { class: 'grow' }), h('button', { type: 'button', class: 'hb', 'aria-label': 'Close list', onclick: () => this.filesDialog.close() }, icon('close', 16, 2.2))),
        h(
          'ul',
          { class: 'file-list' },
          ...this.files.map((entry) => {
            const on = entry === this.active;
            return h(
              'li',
              { class: on ? 'on' : '' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'fl-main',
                  'aria-current': on ? 'true' : undefined,
                  onclick: () => {
                    this.filesDialog.close();
                    if (!on) this.activate(entry);
                  },
                },
                h('span', { class: 'ico' }, icon(iconFor(entry.file), 20)),
                h('span', { class: 'fl-txt' }, h('b', {}, entry.file.name), h('span', {}, [entry.kind, formatBytes(entry.file.size)].filter(Boolean).join(' · '))),
              ),
              h('button', { type: 'button', class: 'hb x', 'aria-label': `Close ${entry.file.name}`, onclick: () => this.close(entry) }, icon('close', 16, 2.2)),
            );
          }),
        ),
        h(
          'div',
          { class: 'dialog-ft' },
          h(
            'button',
            {
              type: 'button',
              class: 'btn primary xl',
              onclick: () => {
                this.filesDialog.close();
                this.picker.click();
              },
            },
            icon('plus', 20, 2),
            'Open more files',
          ),
        ),
      ),
    );
  }

  // ---- File view ---------------------------------------------------------------------------------------------------

  private unmount(): void {
    this.mountToken++;
    this.viewer?.destroy();
    this.viewer = null;
    this.shownViewerId = null;
  }

  private async show(entry: OpenFile): Promise<void> {
    const token = this.mountToken;
    const tools = h('div', { class: 'viewer-tools' });
    const host = h('div', { class: 'viewer-host' });
    const body = h('div', { class: 'viewer-body' }, host);
    const meta = h('span', { class: 'c3' }, formatBytes(entry.file.size));
    const infoButton = h(
      'button',
      { type: 'button', class: 'btn sm info-btn', title: 'Properties and metadata, e.g. when and where a photo was taken', 'aria-label': 'Info', onclick: () => this.setInfo(!this.infoOpen) },
      icon('info', 15),
      h('span', { class: 'lbl' }, 'Info'),
    );
    this.infoButton = infoButton;
    this.infoHost = body;
    const select = h('select', {
      class: 'select',
      title: 'View as',
      onchange: () => {
        entry.chosenViewer = select.value || undefined;
        this.render();
      },
    });
    this.stage.append(
      h(
        'div',
        { class: 'fileview' },
        h(
          'div',
          { class: 'filebar' },
          h('div', { class: 'fileinfo' }, h('b', { title: entry.file.name }, entry.file.name), meta),
          h('span', { class: 'vsep' }),
          tools,
          h('label', { class: 'view-as' }, h('span', { class: 'c3' }, 'View as'), h('span', { class: 'select-wrap' }, select, icon('chevDown', 14, 2))),
          infoButton,
        ),
        body,
      ),
    );
    this.setInfo(this.infoOpen);

    const detected = await detectViewer(entry.file);
    if (token !== this.mountToken) return;
    const definition = viewers.find((v) => v.id === entry.chosenViewer) ?? detected;
    this.shownViewerId = definition.id;
    entry.kind = detected.label;
    meta.textContent = `${definition.label} · ${formatBytes(entry.file.size)}`;
    select.append(
      h('option', { value: '' }, `Automatic (${detected.label})`),
      ...viewers.map((v) => h('option', { value: v.id }, v.label)),
    );
    select.value = entry.chosenViewer ?? '';

    const container = h('div', { class: `viewer-root viewer-${definition.id}` });
    const loading = new LoadingScreen(entry.file, definition.label);
    host.replaceChildren(loading.element);
    try {
      loading.update('Loading viewer …');
      const module = await definition.load();
      if (token !== this.mountToken) return;
      // The viewer builds up underneath; the loading screen stays on top until it is done.
      host.replaceChildren(container, loading.element);
      loading.update('Reading file …');
      const viewer = await module.mount({
        file: entry.file,
        container,
        toolbar: tools,
        openFile: (file) => this.open([file]),
        progress: (message, fraction) => {
          if (token === this.mountToken) loading.update(message, fraction);
        },
      });
      if (token !== this.mountToken) {
        viewer.destroy();
        return;
      }
      this.viewer = viewer;
    } catch (error) {
      if (token !== this.mountToken) return;
      console.error(error);
      tools.replaceChildren();
      host.replaceChildren(this.errorBox(entry, definition, error));
    } finally {
      loading.close();
    }
  }

  private setInfo(open: boolean): void {
    this.infoOpen = open;
    if (this.infoButton) setPressed(this.infoButton, open);
    if (open && this.active && this.infoHost) {
      this.infoHost.append(this.infoBackdrop, this.info.element);
      void this.info.show(this.active.file);
    } else {
      this.infoBackdrop.remove();
      this.info.element.remove();
    }
  }

  private errorBox(entry: OpenFile, failed: ViewerDefinition, error: unknown): HTMLElement {
    const message = error instanceof Error ? error.message : String(error);
    const fallbacks = [textViewer, hexViewer].filter((v) => v !== failed);
    return h(
      'div',
      { class: 'status' },
      h(
        'div',
        { class: 'error-card' },
        h('div', { class: 'error-hd' }, icon('alert', 18, 1.8), h('b', {}, `The file could not be shown as “${failed.label}”.`)),
        h('p', { class: 'c2' }, message),
        h(
          'div',
          { class: 'actions' },
          ...fallbacks.map((v) =>
            h(
              'button',
              { type: 'button', class: 'btn sm', onclick: () => {
                entry.chosenViewer = v.id;
                this.render();
              } },
              icon(v.icon, 14),
              `Show as ${v.label}`,
            ),
          ),
        ),
      ),
    );
  }

  private footer(): HTMLElement {
    return h(
      'footer',
      { class: 'foot' },
      h('span', {}, `Version ${__APP_VERSION__} (${__GIT_COMMIT__})`),
      h('a', { href: 'https://www.gnu.org/licenses/gpl-3.0.html', target: '_blank', rel: 'noopener noreferrer' }, 'GPL-3.0-or-later'),
      SOURCE_URL && h('a', { href: SOURCE_URL, target: '_blank', rel: 'noopener noreferrer' }, 'Source code'),
      h('a', { href: 'third-party-licenses.txt', target: '_blank' }, 'Third-party licenses'),
    );
  }

  private installDragAndDrop(): void {
    let depth = 0;
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false;
    window.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      depth++;
      this.dropOverlay.classList.add('visible');
    });
    window.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) this.dropOverlay.classList.remove('visible');
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
      this.dropOverlay.classList.remove('visible');
      this.open([...(e.dataTransfer?.files ?? [])]);
    });
  }
}
