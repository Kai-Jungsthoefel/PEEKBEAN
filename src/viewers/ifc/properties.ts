// SPDX-License-Identifier: GPL-3.0-or-later
// Card with the properties of the selected IFC product: attributes, property sets, quantities, materials.
import { h } from '../../core/dom';
import { icon } from '../../core/icons';
import type { IfcProperties } from '../../workers/ifc-types';

export interface PropertiesHooks {
  close(): void;
  /** Frame the selection in the view. */
  fit(): void;
}

export class PropertiesCard {
  readonly element = h('div', { class: 'float ifc-props', hidden: true, role: 'region', 'aria-label': 'Properties' });
  private readonly title = h('b', {});
  private readonly sub = h('div', { class: 'ifc-props-sub' });
  private readonly body = h('div', { class: 'ifc-props-body' });
  /** Sections the user folded stay folded for the next element. */
  private readonly folded = new Set<string>();

  constructor(hooks: PropertiesHooks) {
    const fit = h('button', { type: 'button', class: 'hb', title: 'Show the selection in the view', 'aria-label': 'Show the selection in the view', onclick: () => hooks.fit() }, icon('fit', 14, 1.9));
    const close = h('button', { type: 'button', class: 'hb', title: 'Close (deselects)', 'aria-label': 'Close properties', onclick: () => hooks.close() }, icon('close', 13, 2));
    this.element.append(h('div', { class: 'float-hd' }, icon('info', 14), this.title, h('span', { class: 'grow' }), fit, close), this.sub, this.body);
  }

  private head(name: string, detail: string): void {
    this.element.hidden = false;
    this.title.textContent = name;
    this.title.title = name;
    this.sub.textContent = detail;
  }

  loading(name: string, ifcClass: string): void {
    this.head(name, ifcClass);
    this.body.replaceChildren(h('p', { class: 'ifc-props-note' }, 'Reading properties …'));
  }

  failed(message: string): void {
    this.body.replaceChildren(h('p', { class: 'ifc-props-note error' }, `The properties could not be read: ${message}`));
  }

  show(properties: IfcProperties, detail = properties.ifcClass): void {
    this.head(properties.name, detail);
    const sections = properties.sections.map((section) => {
      const details = h(
        'details',
        { open: !this.folded.has(section.title) },
        h('summary', {}, h('span', {}, section.title), h('span', { class: 'c3' }, String(section.rows.length))),
        h('dl', {}, ...section.rows.flatMap(([label, value]) => [h('dt', { title: label }, label), h('dd', {}, value || '—')])),
      );
      details.addEventListener('toggle', () => {
        if (details.open) this.folded.delete(section.title);
        else this.folded.add(section.title);
      });
      return details;
    });
    this.body.replaceChildren(...(sections.length ? sections : [h('p', { class: 'ifc-props-note' }, 'No properties.')]));
  }

  hide(): void {
    this.element.hidden = true;
  }
}
