// SPDX-License-Identifier: GPL-3.0-or-later
// The converter's preview of one file, opened from its row: input and output in the site's own viewers, one at a time
// or side by side, pictures as a slider over both. Below them what the conversion changes. The page decides what to
// show (PreviewItem); this only remounts the viewers when the file, the view or the result changes, not on every
// progress message. The viewers' own tools stay folded away until asked for; looking is the point here.
import { formatBytes } from '../core/bytes';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { detectViewer, viewers } from '../core/registry';
import type { Viewer } from '../core/types';

export type PreviewMode = 'input' | 'output' | 'compare';

export interface PreviewItem {
  /** Another key is another file; its viewers are mounted anew. */
  key: number;
  file: File;
  /** Viewer the format detection chose for the input; empty while it runs. */
  viewer: string;
  sourceLabel: string;
  /** Empty for files no converter takes. */
  targetLabel: string;
  kindLabel: string;
  /** Pictures compare with a slider; everything else side by side. */
  picture: boolean;
  /** The converted files, once there are any. */
  outputs: File[] | null;
  /** Progress, error or a hint, below the header. */
  status: (Node | string)[];
  facts: { label: string; input: string; output: string }[];
  notes: { text: string; warn: boolean }[];
}

const MODES: { id: PreviewMode; label: string }[] = [
  { id: 'input', label: 'Input' },
  { id: 'output', label: 'Output' },
  { id: 'compare', label: 'Compare' },
];

export class Preview {
  readonly element: HTMLElement;
  private readonly header = h('div', { class: 'cv-pv-hd' });
  private readonly status = h('div', { class: 'cv-pv-status', 'aria-live': 'polite' });
  private readonly stage = h('div', { class: 'cv-stage' });
  private readonly details = h('div', { class: 'cv-pv-details' });
  /** The view the user picked; files without a result show their input until they have one. */
  private mode: PreviewMode = 'compare';
  /** Which of several results is shown, e.g. the page of a PDF. */
  private output = 0;
  private item: PreviewItem | null = null;
  private shown = '';
  private shownOutputs: File[] | null = null;
  private parts: { destroy(): void }[] = [];

  constructor(private readonly actions: { close(): void; download(files: File[], button: HTMLButtonElement): void }) {
    this.element = h('section', { class: 'cv-preview', 'aria-label': 'Preview' }, this.header, this.status, this.stage, this.details);
  }

  /** Opened from a row, the preview starts with the comparison. */
  reset(): void {
    this.mode = 'compare';
  }

  show(item: PreviewItem | null): void {
    if (item?.key !== this.item?.key) this.output = 0;
    this.item = item;
    if (!item) {
      this.clearStage();
      this.header.replaceChildren();
      this.status.replaceChildren();
      this.details.replaceChildren();
      return;
    }
    const mode = this.effectiveMode(item);
    this.drawHeader(item, mode);
    this.status.replaceChildren(...item.status);
    this.status.hidden = item.status.length === 0;
    this.drawDetails(item);
    // The input alone does not depend on the result, so it stays mounted while the file converts.
    const key = mode === 'input' ? `${item.key}|input` : `${item.key}|${mode}|${this.output}`;
    if (key !== this.shown || (mode !== 'input' && item.outputs !== this.shownOutputs)) {
      this.shown = key;
      this.shownOutputs = item.outputs;
      this.drawStage(item, mode);
    }
  }

  destroy(): void {
    this.clearStage();
  }

  private effectiveMode(item: PreviewItem): PreviewMode {
    return item.outputs ? this.mode : 'input';
  }

  private drawHeader(item: PreviewItem, mode: PreviewMode): void {
    const outputs = item.outputs;
    const download = h(
      'button',
      {
        type: 'button',
        class: 'btn cv-pv-download',
        disabled: !outputs,
        onclick: (event: MouseEvent) => outputs && this.actions.download(outputs, event.currentTarget as HTMLButtonElement),
      },
      icon('download', 16),
      h('span', {}, outputs && outputs.length > 1 ? 'Download ZIP' : item.targetLabel ? `Download ${item.targetLabel}` : 'Download'),
    );
    this.header.replaceChildren(
      // Phones show the list and the preview one at a time: back instead of close.
      h('button', { type: 'button', class: 'ibtn cv-back', 'aria-label': 'Back to the list of files', onclick: () => this.actions.close() }, icon('chevRight', 22, 2)),
      h(
        'div',
        { class: 'cv-pv-title' },
        h('b', { title: item.file.name }, item.file.name),
        h(
          'span',
          { class: 'cv-pv-sub' },
          h('span', { class: 'cv-fmt' }, item.sourceLabel),
          item.targetLabel && h('span', { class: 'c3', 'aria-label': 'to' }, '→'),
          item.targetLabel && h('span', { class: 'cv-fmt to' }, item.targetLabel),
          h('span', { class: 'c3' }, `· ${item.kindLabel}`),
        ),
      ),
      h(
        'div',
        { class: 'cv-seg cv-modes', role: 'radiogroup', 'aria-label': 'Preview' },
        ...MODES.map((m) =>
          h(
            'button',
            {
              type: 'button',
              role: 'radio',
              'aria-checked': String(m.id === mode),
              disabled: m.id !== 'input' && !outputs,
              title: m.id !== 'input' && !outputs ? 'Available once the file is converted' : undefined,
              onclick: () => {
                this.mode = m.id;
                this.show(this.item);
              },
            },
            m.label,
          ),
        ),
      ),
      download,
      h('button', { type: 'button', class: 'ibtn cv-close', 'aria-label': 'Close the preview', title: 'Close', onclick: () => this.actions.close() }, icon('close', 18, 2)),
    );
  }

  private drawDetails(item: PreviewItem): void {
    const fact = (label: string, input: string, output: string, head = false) =>
      h('div', { class: head ? 'cv-fact hd' : 'cv-fact' }, h('span', { class: 'c3' }, label), h('span', {}, input), h('span', {}, output));
    const facts = h('div', { class: 'cv-facts', hidden: item.facts.length === 0 }, fact('What changes', 'Input', 'Output', true), ...item.facts.map((f) => fact(f.label, f.input, f.output)));
    const notes = h(
      'ul',
      { class: 'cv-notes', hidden: item.notes.length === 0 },
      ...item.notes.map((n) => h('li', { class: n.warn ? 'warn' : undefined }, icon(n.warn ? 'alert' : 'info', 15, 1.8), h('span', {}, n.text))),
    );
    this.details.replaceChildren(facts, notes);
  }

  private clearStage(): void {
    for (const part of this.parts) part.destroy();
    this.parts = [];
    this.stage.replaceChildren();
    this.shown = '';
    this.shownOutputs = null;
  }

  private drawStage(item: PreviewItem, mode: PreviewMode): void {
    this.clearStage();
    this.shown = mode === 'input' ? `${item.key}|input` : `${item.key}|${mode}|${this.output}`;
    this.shownOutputs = item.outputs;
    const outputs = item.outputs ?? [];
    const output = outputs[Math.min(this.output, outputs.length - 1)];
    const inputTag = tag('Input', item.sourceLabel, item.file.size, false);
    const outputTag = () => [tag('Output', item.targetLabel, output.size, true), this.outputPicker(outputs)];

    if (mode === 'input' || !output) {
      this.add(new Pane(item.file, item.viewer, [inputTag]));
    } else if (mode === 'output') {
      this.add(new Pane(output, '', outputTag()));
    } else if (item.picture) {
      this.add(new Slider(item.file, output, inputTag, outputTag()));
    } else {
      const split = h('div', { class: 'cv-split' });
      this.stage.append(split);
      const input = new Pane(item.file, item.viewer, [inputTag]);
      const result = new Pane(output, '', outputTag());
      this.parts.push(input, result);
      split.append(input.element, result.element);
    }
  }

  private add(part: { element: HTMLElement; destroy(): void }): void {
    this.parts.push(part);
    this.stage.append(part.element);
  }

  /** Several results (pages, sheets) get a picker; one is shown at a time. */
  private outputPicker(outputs: File[]): HTMLElement | null {
    if (outputs.length < 2) return null;
    const select = h(
      'select',
      {
        class: 'select',
        'aria-label': 'Converted file',
        onchange: () => {
          this.output = Number(select.value);
          this.show(this.item);
        },
      },
      ...outputs.map((file, i) => h('option', { value: String(i) }, `${i + 1} of ${outputs.length}: ${file.name}`)),
    );
    select.value = String(Math.min(this.output, outputs.length - 1));
    return h('span', { class: 'select-wrap cv-pick' }, select, icon('chevDown', 14, 2));
  }
}

function tag(side: string, format: string, size: number, output: boolean): HTMLElement {
  return h('span', { class: output ? 'cv-side out' : 'cv-side' }, `${side} · ${format} · ${formatBytes(size)}`);
}

/** One file in the viewer the site would open it with. */
class Pane {
  readonly element: HTMLElement;
  private viewer: Viewer | null = null;
  private disposed = false;

  constructor(file: File, viewer: string, label: (Node | null)[]) {
    const tools = h('div', { class: 'viewer-tools' });
    const text = h('span', {}, 'Loading viewer …');
    const loading = h('div', { class: 'status' }, h('span', { class: 'spinner' }), text);
    const host = h('div', { class: 'viewer-host' }, loading);
    // Zoom, measuring and the like are a click away; the pane opens with just the file.
    const toggle = h('button', {
      type: 'button',
      class: 'btn sm cv-tools-btn',
      'aria-pressed': 'false',
      hidden: true,
      onclick: () => {
        const open = !this.element.classList.contains('tools');
        this.element.classList.toggle('tools', open);
        toggle.setAttribute('aria-pressed', String(open));
      },
    }, icon('ruler', 14), h('span', {}, 'Tools'));
    this.element = h('div', { class: 'cv-pane' }, h('div', { class: 'cv-pane-bar' }, ...label, h('span', { class: 'grow' }), toggle, tools), h('div', { class: 'viewer-body' }, host));
    void this.mount(file, viewer, host, tools, loading, text).then(() => {
      toggle.hidden = tools.childElementCount === 0;
    });
  }

  private async mount(file: File, id: string, host: HTMLElement, tools: HTMLElement, loading: HTMLElement, text: HTMLElement): Promise<void> {
    try {
      const definition = viewers.find((v) => v.id === id) ?? (await detectViewer(file));
      const module = await definition.load();
      if (this.disposed) return;
      const container = h('div', { class: `viewer-root viewer-${definition.id}` });
      // The viewer builds up underneath; the loading message stays on top until it is done.
      host.replaceChildren(container, loading);
      text.textContent = 'Reading file …';
      const viewer = await module.mount({
        file,
        container,
        toolbar: tools,
        // Archive entries and attachments open in the viewer, not here.
        openFile: () => {},
        progress: (message) => {
          text.textContent = message;
        },
      });
      if (this.disposed) {
        viewer.destroy();
        return;
      }
      this.viewer = viewer;
      loading.remove();
    } catch (error) {
      if (this.disposed) return;
      console.error(error);
      tools.replaceChildren();
      host.replaceChildren(
        h(
          'div',
          { class: 'status' },
          h(
            'div',
            { class: 'error-card' },
            h('div', { class: 'error-hd' }, icon('alert', 18, 1.8), h('b', {}, 'No preview for this file')),
            h('p', { class: 'c2' }, error instanceof Error ? error.message : String(error)),
          ),
        ),
      );
    }
  }

  destroy(): void {
    this.disposed = true;
    this.viewer?.destroy();
    this.viewer = null;
  }
}

/** The slider in a pane of the preview, with the formats and sizes above it. */
class Slider {
  readonly element: HTMLElement;
  private readonly compare: PictureCompare;

  constructor(input: File, output: File, inputTag: HTMLElement, outputTag: (Node | null)[]) {
    this.compare = new PictureCompare(input, output);
    this.element = h('div', { class: 'cv-pane' }, h('div', { class: 'cv-pane-bar' }, inputTag, h('span', { class: 'grow' }), ...outputTag), this.compare.element);
  }

  destroy(): void {
    this.compare.destroy();
  }
}

/**
 * Input and output picture on top of each other; the handle shows the output to its right. Used by the preview and,
 * as a strip with the two formats in its corners, by the card of a single converted file.
 */
export class PictureCompare {
  readonly element: HTMLElement;
  private readonly urls: string[] = [];
  private disposed = false;

  constructor(input: File, output: File, labels?: [string, string]) {
    const before = h('img', { alt: 'Input' });
    const after = h('img', { alt: 'Output' });
    const range = h('input', { type: 'range', min: '0', max: '100', value: '50', class: 'cv-sl-range', 'aria-label': 'Compare input and output' });
    const flipped = icon('chevRight', 18, 2.2);
    flipped.classList.add('flip');
    // Each layer has its own checkerboard, so transparent parts of the output do not show the input below.
    this.element = h(
      'div',
      { class: 'cv-sl-area' },
      h('div', { class: 'cv-sl-layer checkerboard' }, before),
      h('div', { class: 'cv-sl-layer out checkerboard' }, after),
      ...(labels ? [h('span', { class: 'cv-sl-tag', 'aria-hidden': 'true' }, labels[0]), h('span', { class: 'cv-sl-tag out', 'aria-hidden': 'true' }, labels[1])] : []),
      range,
      h('div', { class: 'cv-sl-handle', 'aria-hidden': 'true' }, h('span', { class: 'cv-sl-knob' }, flipped, icon('chevRight', 18, 2.2))),
    );
    const move = () => this.element.style.setProperty('--pos', `${range.value}%`);
    range.addEventListener('input', move);
    move();
    void this.load(input, output, before, after);
  }

  private async load(input: File, output: File, before: HTMLImageElement, after: HTMLImageElement): Promise<void> {
    const url = URL.createObjectURL(output);
    this.urls.push(url);
    after.src = url;
    try {
      // The input may be HEIC, camera raw or another format the browser cannot show; the image viewer decodes it.
      const { openImage } = await import('../viewers/image');
      const { source } = await openImage(input, () => {});
      if (this.disposed) {
        URL.revokeObjectURL(source.url);
        return;
      }
      this.urls.push(source.url);
      before.src = source.url;
    } catch (error) {
      console.error(error);
      before.alt = 'The input could not be shown.';
    }
  }

  destroy(): void {
    this.disposed = true;
    for (const url of this.urls) URL.revokeObjectURL(url);
  }
}
