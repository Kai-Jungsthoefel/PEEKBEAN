// SPDX-License-Identifier: GPL-3.0-or-later
// Layer list for flat views (DXF/DWG layers, PDF optional content): a floating panel with a checkbox per layer,
// "all"/"none", and a toolbar button that shows or hides the panel.
import { h, setPressed, toolButton } from '../core/dom';
import { icon } from '../core/icons';

export interface LayerEntry {
  /** Missing for a heading that only groups the layers below it (PDF layer groups). */
  id?: string;
  name: string;
  /** CSS color of the swatch; DXF layers have one, PDF layers do not. */
  color?: string;
  /** Nesting level, for PDF layer groups. */
  depth?: number;
}

export interface LayerAccess {
  isVisible(id: string): boolean;
  /** Changes the visibility of the given layers; the caller redraws. */
  setVisible(ids: string[], visible: boolean): void;
}

export interface LayerPanel {
  panel: HTMLElement;
  /** Toolbar button that shows or hides the panel. */
  button: HTMLButtonElement;
}

/** The panel, or null when there are fewer than two layers to switch. */
export function createLayerPanel(entries: LayerEntry[], access: LayerAccess): LayerPanel | null {
  const ids = entries.flatMap((e) => (e.id ? [e.id] : []));
  if (ids.length < 2) return null;
  const boxes = new Map<string, HTMLInputElement>();
  // One layer can switch others (PDF radio-button groups), so all boxes are refreshed after each change.
  const sync = () => {
    for (const [id, box] of boxes) box.checked = access.isVisible(id);
  };
  const rows = entries.map((entry) => {
    const indent = `--depth:${entry.depth ?? 0}`;
    if (!entry.id) return h('div', { class: 'part part-group', style: indent, title: entry.name }, h('span', {}, entry.name));
    const id = entry.id;
    const box = h('input', { type: 'checkbox', checked: access.isVisible(id), onchange: () => {
      access.setVisible([id], box.checked);
      sync();
    } });
    boxes.set(id, box);
    return h(
      'label',
      { class: 'part', style: indent, title: entry.name },
      box,
      entry.color ? h('span', { class: 'swatch', style: `background:${entry.color}` }) : null,
      h('span', {}, entry.name),
    );
  });
  const setAll = (visible: boolean) => {
    access.setVisible(ids, visible);
    sync();
  };
  const panel = h(
    'div',
    { class: 'float parts' },
    h(
      'div',
      { class: 'float-hd' },
      icon('layers', 14),
      h('b', {}, 'Layers'),
      h('span', { class: 'c3' }, String(ids.length)),
      h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'link', onclick: () => setAll(true) }, 'all'),
      h('button', { type: 'button', class: 'link', onclick: () => setAll(false) }, 'none'),
    ),
    h('div', { class: 'parts-list' }, ...rows),
  );
  const button: HTMLButtonElement = toolButton('Layers', 'Show or hide the layer list', () => {
    panel.hidden = !panel.hidden;
    setPressed(button, !panel.hidden);
  });
  setPressed(button, true);
  return { panel, button };
}
