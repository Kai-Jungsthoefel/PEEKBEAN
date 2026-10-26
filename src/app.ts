// SPDX-License-Identifier: GPL-3.0-or-later
import { formatBytes } from './core/bytes';
import { h } from './core/dom';
import { icon } from './core/icons';
import { detectViewer, hexViewer, textViewer, viewers } from './core/registry';
import type { Viewer, ViewerDefinition } from './core/types';

interface OpenFile {
  id: number;
  file: File;
  /** Viewer chosen by the user; undefined means automatic detection. */
  chosenViewer?: string;
}

const PLANNED_FORMATS = 'Word, Excel, PowerPoint, STEP/IGES, DXF, DWG, Archive, E-Mails und mehr';

export class App {
  private files: OpenFile[] = [];
  private active: OpenFile | null = null;
  private viewer: Viewer | null = null;
  private mountToken = 0;
  private nextId = 1;

  private readonly tabs = h('nav', { class: 'tabs', 'aria-label': 'Geöffnete Dateien' });
  private readonly stage = h('main', { class: 'stage' });
  private readonly picker = h('input', { type: 'file', multiple: true, hidden: true });
  private readonly openInHeader = this.openButton();
  private readonly dropOverlay = h(
    'div',
    { class: 'drop-overlay', 'aria-hidden': 'true' },
    h('div', { class: 'drop-card' }, icon('drop', 28, 1.6), h('b', {}, 'Zum Öffnen loslassen')),
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
            { type: 'button', class: 'x', title: 'Schließen', 'aria-label': `${entry.file.name} schließen`, onclick: () => this.close(entry) },
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
    const host = h('div', { class: 'viewer-host' }, h('div', { class: 'status' }, h('span', { class: 'spinner' }), 'Wird geladen …'));
    const select = h('select', {
      class: 'select',
      title: 'Anzeigen als',
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
          h('label', { class: 'view-as' }, h('span', { class: 'c3' }, 'Anzeigen als'), select),
        ),
        host,
      ),
    );

    const detected = await detectViewer(entry.file);
    if (token !== this.mountToken) return;
    const definition = viewers.find((v) => v.id === entry.chosenViewer) ?? detected;
    select.append(
      h('option', { value: '' }, `Automatisch (${detected.label})`),
      ...viewers.map((v) => h('option', { value: v.id }, v.label)),
    );
    select.value = entry.chosenViewer ?? '';

    const container = h('div', { class: `viewer-root viewer-${definition.id}` });
    try {
      const module = await definition.load();
      if (token !== this.mountToken) return;
      host.replaceChildren(container);
      const viewer = await module.mount({ file: entry.file, container, toolbar: tools });
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
        h('div', { class: 'error-hd' }, icon('alert', 18, 1.8), h('b', {}, `Die Datei konnte nicht als „${failed.label}“ angezeigt werden.`)),
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
              `Als ${v.label} anzeigen`,
            ),
          ),
        ),
      ),
    );
  }

  private openButton(): HTMLButtonElement {
    return h('button', { type: 'button', class: 'btn primary', onclick: () => this.picker.click() }, icon('open', 15, 1.8), 'Dateien öffnen');
  }

  private header(): HTMLElement {
    return h(
      'header',
      { class: 'top' },
      h('span', { class: 'logo' }, icon('logo', 22, 1.6)),
      h('b', { class: 'brand' }, 'Everything Viewer'),
      h('span', { class: 'local-pill', title: 'Dateien werden ausschließlich in diesem Browser gelesen.' }, icon('lock', 13, 2), 'Lokal · kein Upload'),
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
          h('div', { class: 'start-head' }, h('h1', {}, 'Dateien ansehen'), h('span', { class: 'grow' }), this.openButton()),
          h(
            'button',
            { type: 'button', class: 'dropcard', onclick: () => this.picker.click() },
            h('span', { class: 'ico acc' }, icon('drop', 22, 1.8)),
            h('b', {}, 'Dateien hierher ziehen'),
            h('span', { class: 'c2' }, 'oder klicken, um sie auszuwählen. Mehrere Dateien öffnen sich als Reiter.'),
          ),
          h('div', { class: 'start-bar' }, h('span', { class: 'cap' }, 'UNTERSTÜTZTE FORMATE')),
          h(
            'div',
            { class: 'format-grid' },
            ...formats.map((v) =>
              h('div', { class: 'fcard' }, h('span', { class: 'ico' }, icon(v.icon, 18)), h('b', {}, v.label), h('span', { class: 'ext' }, v.extensions.map((e) => `.${e}`).join(' '))),
            ),
            h('div', { class: 'fcard' }, h('span', { class: 'ico' }, icon(textViewer.icon, 18)), h('b', {}, textViewer.label), h('span', { class: 'ext' }, 'alle Textdateien, mit Syntaxhervorhebung')),
            h('div', { class: 'fcard' }, h('span', { class: 'ico' }, icon(hexViewer.icon, 18)), h('b', {}, 'Alles andere'), h('span', { class: 'ext' }, 'als Hex-Ansicht')),
          ),
          h('p', { class: 'ehint' }, `Geplant: ${PLANNED_FORMATS}.`),
        ),
        h(
          'aside',
          { class: 'start-side' },
          h(
            'div',
            { class: 'panel-card' },
            h('div', { class: 'ph' }, h('b', {}, 'Dateien bleiben auf dem eigenen Rechner')),
            fact('lock', 'Kein Upload', 'Dateien werden ausschließlich im Browser gelesen. Es gibt keinen Server, der sie empfangen könnte.'),
            fact('shield', 'Technisch abgesichert', 'Eine Content Security Policy verbietet der Seite jede Verbindung zu fremden Servern.'),
            fact('code', 'Open Source', 'GPL-3.0. Der Quellcode ist offen und überprüfbar.'),
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
      source && h('a', { href: source, target: '_blank', rel: 'noopener noreferrer' }, 'Quellcode'),
      h('a', { href: 'third-party-licenses.txt', target: '_blank' }, 'Drittanbieter-Lizenzen'),
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
