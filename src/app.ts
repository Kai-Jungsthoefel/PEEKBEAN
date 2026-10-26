// SPDX-License-Identifier: GPL-3.0-or-later
import { formatBytes } from './core/bytes';
import { h, setPressed } from './core/dom';
import { icon } from './core/icons';
import { detectViewer, hexViewer, textViewer, viewers } from './core/registry';
import type { Viewer, ViewerDefinition } from './core/types';
import { InfoPanel } from './info-panel';

interface OpenFile {
  id: number;
  file: File;
  /** Viewer chosen by the user; undefined means automatic detection. */
  chosenViewer?: string;
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

const PLANNED_FORMATS ='older Office formats (DOC, PPT), IFC (BIM), EPUB and camera raw files';

export class App {
  private files: OpenFile[] = [];
  private active: OpenFile | null = null;
  private viewer: Viewer | null = null;
  private mountToken = 0;
  private nextId = 1;
  /** The info panel stays open across files until it is closed. */
  private infoOpen = false;
  private readonly info = new InfoPanel(() => this.setInfo(false));
  private infoButton: HTMLButtonElement | null = null;
  private infoHost: HTMLElement | null = null;

  private readonly tabs = h('nav', { class: 'tabs', 'aria-label': 'Open files' });
  private readonly stage = h('main', { class: 'stage' });
  private readonly picker = h('input', { type: 'file', multiple: true, hidden: true });
  private readonly openInHeader = this.openButton();
  private readonly dropOverlay = h(
    'div',
    { class: 'drop-overlay', 'aria-hidden': 'true' },
    h('div', { class: 'drop-card' }, icon('drop', 28, 1.6), h('b', {}, 'Drop to open')),
  );

  constructor(root: HTMLElement) {
    root.append(this.header(), this.tabs, this.stage, this.footer(), this.dropOverlay, this.picker);
    this.picker.addEventListener('change', () => {
      this.open([...(this.picker.files ?? [])]);
      this.picker.value = '';
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
    // The start page has its own open button.
    this.openInHeader.hidden = !this.active;
    this.renderTabs();
    this.unmount();
    this.stage.replaceChildren();
    if (this.active) {
      void this.show(this.active);
    } else {
      this.stage.append(this.startScreen());
    }
  }

  private renderTabs(): void {
    this.tabs.hidden = this.files.length === 0;
    this.tabs.replaceChildren(
      ...this.files.map((entry) =>
        h(
          'div',
          { class: entry === this.active ? 'tab on' : 'tab' },
          h('button', { type: 'button', class: 't', title: entry.file.name, onclick: () => this.activate(entry) }, h('span', {}, entry.file.name)),
          h(
            'button',
            { type: 'button', class: 'x', title: 'Close', 'aria-label': `Close ${entry.file.name}`, onclick: () => this.close(entry) },
            icon('close', 14, 2),
          ),
        ),
      ),
    );
  }

  private unmount(): void {
    this.mountToken++;
    this.viewer?.destroy();
    this.viewer = null;
  }

  private async show(entry: OpenFile): Promise<void> {
    const token = this.mountToken;
    const tools = h('div', { class: 'viewer-tools' });
    const host = h('div', { class: 'viewer-host' });
    const body = h('div', { class: 'viewer-body' }, host);
    const infoButton = h('button', { type: 'button', class: 'btn sm', title: 'Properties and metadata, e.g. when and where a photo was taken', onclick: () => this.setInfo(!this.infoOpen) }, icon('info', 14), 'Info');
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
          h('div', { class: 'fileinfo' }, h('b', { title: entry.file.name }, entry.file.name), h('span', { class: 'c3' }, formatBytes(entry.file.size))),
          h('span', { class: 'vsep' }),
          tools,
          infoButton,
          h('label', { class: 'view-as' }, h('span', { class: 'c3' }, 'View as'), select),
        ),
        body,
      ),
    );
    this.setInfo(this.infoOpen);

    const detected = await detectViewer(entry.file);
    if (token !== this.mountToken) return;
    const definition = viewers.find((v) => v.id === entry.chosenViewer) ?? detected;
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
      this.infoHost.append(this.info.element);
      void this.info.show(this.active.file);
    } else {
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

  private openButton(): HTMLButtonElement {
    return h('button', { type: 'button', class: 'btn primary', onclick: () => this.picker.click() }, icon('open', 15, 1.8), 'Open files');
  }

  private header(): HTMLElement {
    return h(
      'header',
      { class: 'top' },
      h('span', { class: 'logo' }, icon('logo', 22, 1.6)),
      h('b', { class: 'brand' }, 'Everything Viewer'),
      h('span', { class: 'local-pill', title: 'Files are read only in this browser.' }, icon('lock', 13, 2), 'Local · no upload'),
      h('span', { class: 'grow' }),
      this.openInHeader,
    );
  }

  private startScreen(): HTMLElement {
    const formats = [...viewers.filter((v) => v.extensions.length > 0 && v !== textViewer)];
    const fact = (name: Parameters<typeof icon>[0], title: string, text: string) =>
      h('div', { class: 'fact' }, h('span', { class: 'fact-ico' }, icon(name, 16, 1.8)), h('div', {}, h('b', {}, title), h('span', { class: 'c2' }, text)));

    return h(
      'section',
      { class: 'start-body' },
      h(
        'div',
        { class: 'start-grid' },
        h(
          'div',
          {},
          h('div', { class: 'start-head' }, h('h1', {}, 'View files'), h('span', { class: 'grow' }), this.openButton()),
          h(
            'button',
            { type: 'button', class: 'dropcard', onclick: () => this.picker.click() },
            h('span', { class: 'ico acc' }, icon('drop', 22, 1.8)),
            h('b', {}, 'Drag files here'),
            h('span', { class: 'c2' }, 'or click to choose them. Several files open as tabs.'),
          ),
          h('div', { class: 'start-bar' }, h('span', { class: 'cap' }, 'SUPPORTED FORMATS')),
          h(
            'div',
            { class: 'format-grid' },
            ...formats.map((v) =>
              h('div', { class: 'fcard' }, h('span', { class: 'ico' }, icon(v.icon, 18)), h('b', {}, v.label), h('span', { class: 'ext' }, v.extensions.map((e) => `.${e}`).join(' '))),
            ),
            h('div', { class: 'fcard' }, h('span', { class: 'ico' }, icon(textViewer.icon, 18)), h('b', {}, textViewer.label), h('span', { class: 'ext' }, 'all text files, with syntax highlighting')),
            h('div', { class: 'fcard' }, h('span', { class: 'ico' }, icon(hexViewer.icon, 18)), h('b', {}, 'Everything else'), h('span', { class: 'ext' }, 'as hex view')),
          ),
          h('p', { class: 'ehint' }, `Planned: ${PLANNED_FORMATS}.`),
        ),
        h(
          'aside',
          { class: 'start-side' },
          h(
            'div',
            { class: 'panel-card' },
            h('div', { class: 'ph' }, h('b', {}, 'Files stay on your computer')),
            fact('lock', 'No upload', 'Files are read only in the browser. There is no server that could receive them.'),
            fact('shield', 'Enforced by the browser', 'A Content Security Policy forbids the page any connection to other servers.'),
            fact('code', 'Open Source', 'GPL-3.0. The source code is open for anyone to check.'),
          ),
        ),
      ),
    );
  }

  private footer(): HTMLElement {
    const source = __SOURCE_URL__ ? `${__SOURCE_URL__}/tree/${__GIT_COMMIT__}` : '';
    return h(
      'footer',
      { class: 'foot' },
      h('span', {}, `Version ${__APP_VERSION__} (${__GIT_COMMIT__})`),
      h('a', { href: 'https://www.gnu.org/licenses/gpl-3.0.html', target: '_blank', rel: 'noopener noreferrer' }, 'GPL-3.0-or-later'),
      source && h('a', { href: source, target: '_blank', rel: 'noopener noreferrer' }, 'Source code'),
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
