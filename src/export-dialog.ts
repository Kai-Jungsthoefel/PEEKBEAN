// SPDX-License-Identifier: GPL-3.0-or-later
// "Export" in the viewer's file bar: saves the open file in another format with the converter's modules
// (src/convert/), the same code the converter page runs. Target and options are kept per kind of file.
import { formatBytes } from './core/bytes';
import { h } from './core/dom';
import { icon } from './core/icons';
import { defaultTarget, initialOptions, optionsFor, sourceFor, type ConverterInfo } from './convert/catalog';
import { baseName, download, zipFiles } from './convert/files';
import { loadConverter } from './convert/modules';

interface Settings {
  target: string;
  options: Record<string, string>;
}

type State =
  | { kind: 'idle' }
  | { kind: 'working'; message: string; fraction?: number }
  | { kind: 'done'; files: File[]; notes: string[] }
  | { kind: 'failed'; message: string };

export class ExportDialog {
  readonly dialog = h('dialog', { class: 'pop export-pop', 'aria-labelledby': 'export-title' });
  private readonly settings = new Map<string, Settings>();
  private file: File | null = null;
  private viewer = '';
  private converter: ConverterInfo | null = null;
  private state: State = { kind: 'idle' };

  constructor() {
    // A click on the backdrop lands on the dialog element itself.
    this.dialog.addEventListener('click', (event) => {
      if (event.target === this.dialog && !this.running) this.dialog.close();
    });
    // Closed while converting, the result would still download a moment later, unasked.
    this.dialog.addEventListener('cancel', (event) => {
      if (this.running) event.preventDefault();
    });
  }

  private get running(): boolean {
    return this.state.kind === 'working';
  }

  /** Opens below `anchor` (a bottom sheet on phones) for a file the viewer `viewer` shows. */
  open(file: File, viewer: string, converter: ConverterInfo, anchor: HTMLElement): void {
    this.file = file;
    this.viewer = viewer;
    this.converter = converter;
    this.state = { kind: 'idle' };
    if (!this.settings.has(converter.id)) {
      this.settings.set(converter.id, { target: defaultTarget(converter, file.name).id, options: initialOptions(converter) });
    }
    this.render();
    const box = anchor.getBoundingClientRect();
    this.dialog.style.setProperty('--pop-top', `${box.bottom + 6}px`);
    this.dialog.style.setProperty('--pop-right', `${Math.max(8, window.innerWidth - box.right)}px`);
    this.dialog.showModal();
  }

  private render(): void {
    const converter = this.converter!;
    const file = this.file!;
    const settings = this.settings.get(converter.id)!;
    const target = converter.targets.find((t) => t.id === settings.target)!;
    const change = (update: (s: Settings) => void) => {
      update(settings);
      this.state = { kind: 'idle' };
      this.render();
    };
    const targets = h(
      'div',
      { class: 'seg export-targets', role: 'radiogroup', 'aria-label': 'Format' },
      ...converter.targets.map((t) =>
        h('button', { type: 'button', role: 'radio', 'aria-checked': String(t.id === settings.target), disabled: this.running, onclick: () => change((s) => (s.target = t.id)) }, t.label),
      ),
    );
    const fields = optionsFor(converter, settings.target).map((option) => {
      const select = h(
        'select',
        { class: 'select', disabled: this.running, onchange: () => change((s) => (s.options[option.id] = select.value)) },
        ...option.choices.map((c) => h('option', { value: c.value }, c.label)),
      );
      select.value = settings.options[option.id];
      return h('label', { class: 'cv-field' }, h('span', { class: 'c3' }, option.label), h('span', { class: 'select-wrap' }, select, icon('chevDown', 14, 2)));
    });
    // After an export its own notes say what was read; the general note about the format would repeat them.
    const told = this.state.kind === 'done' && this.state.notes.length > 0;
    const notes = [told ? undefined : sourceFor(converter, file.name)?.note, target.loss].filter(Boolean);
    this.dialog.replaceChildren(
      h(
        'div',
        { class: 'dialog-body' },
        h(
          'div',
          { class: 'dialog-hd' },
          h('b', { id: 'export-title' }, 'Export as'),
          h('span', { class: 'grow' }),
          h('button', { type: 'button', class: 'hb', 'aria-label': 'Close', disabled: this.running, onclick: () => this.dialog.close() }, icon('close', 14, 2.2)),
        ),
        h('span', { class: 'export-file', title: file.name }, file.name),
        targets,
        fields.length > 0 && h('div', { class: 'export-fields' }, ...fields),
        notes.length > 0 && h('p', { class: 'export-note' }, notes.join(' ')),
        this.status(),
        h(
          'div',
          { class: 'dialog-ft export-ft' },
          h('button', { type: 'button', class: 'btn primary', disabled: this.running, onclick: () => void this.run() }, icon('download', 16, 2), `Export as ${target.label}`),
          // A new tab, so the files open here stay open.
          h('a', { class: 'text-link', href: 'convert.html', target: '_blank', rel: 'noopener' }, 'Convert several files', icon('chevRight', 16, 2)),
        ),
      ),
    );
  }

  private status(): HTMLElement | null {
    const state = this.state;
    switch (state.kind) {
      case 'idle':
        return null;
      case 'working': {
        const determinate = state.fraction !== undefined && Number.isFinite(state.fraction);
        const bar = h('div', { class: determinate ? 'lc-bar' : 'lc-bar indet' }, h('div'));
        if (determinate) (bar.firstChild as HTMLElement).style.width = `${Math.round(Math.min(1, Math.max(0, state.fraction!)) * 100)}%`;
        return h('div', { class: 'cv-progress', role: 'status' }, h('span', { class: 'cv-progress-text' }, h('span', { class: 'spinner' }), state.message), bar);
      }
      case 'failed':
        return h('span', { class: 'cv-err', role: 'alert' }, icon('alert', 15, 1.8), h('span', {}, state.message));
      case 'done': {
        const size = formatBytes(state.files.reduce((sum, f) => sum + f.size, 0));
        const name = state.files.length === 1 ? state.files[0].name : `${state.files.length} files as ZIP`;
        return h(
          'div',
          { class: 'export-done', role: 'status' },
          h('span', { class: 'cv-out' }, h('span', { class: 'dot' }), h('span', {}, `Downloaded ${name} · ${size}`)),
          ...state.notes.map((note) => h('span', { class: 'cv-file-note' }, note)),
        );
      }
    }
  }

  private async run(): Promise<void> {
    const converter = this.converter!;
    const file = this.file!;
    const { target, options } = this.settings.get(converter.id)!;
    this.state = { kind: 'working', message: 'Starting …' };
    this.render();
    try {
      const module = await loadConverter(converter.id);
      const result = await module.convert({
        file,
        viewer: this.viewer,
        target,
        options,
        progress: (message, fraction) => {
          if (!this.running) return;
          this.state = { kind: 'working', message, fraction };
          this.render();
        },
      });
      // Several results (pages, sheets) come as one ZIP.
      download(result.files.length === 1 ? result.files[0] : await zipFiles(result.files, `${baseName(file.name)}.zip`));
      this.state = { kind: 'done', files: result.files, notes: result.notes };
    } catch (error) {
      console.error(error);
      this.state = { kind: 'failed', message: error instanceof Error ? error.message : String(error) };
    }
    this.render();
  }
}
