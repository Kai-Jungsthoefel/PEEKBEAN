// SPDX-License-Identifier: GPL-3.0-or-later
// Side panel with the file's properties and metadata (when and where a photo was taken, document author, CAD system …).
import { h } from './core/dom';
import { icon } from './core/icons';
import type { MetaSection } from './metadata';

export class InfoPanel {
  readonly element = h('aside', { class: 'info-panel', 'aria-label': 'Properties' });
  private readonly cache = new WeakMap<File, Promise<MetaSection[]>>();
  private token = 0;

  constructor(private readonly onClose: () => void) {}

  async show(file: File): Promise<void> {
    const mine = ++this.token;
    const body = h('div', { class: 'ip-body' }, h('div', { class: 'ip-wait' }, h('span', { class: 'spinner' }), 'Reading metadata …'));
    this.element.replaceChildren(
      h(
        'div',
        { class: 'ip-hd' },
        icon('info', 15),
        h('b', {}, 'Properties'),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'hb', title: 'Close', 'aria-label': 'Close properties', onclick: () => this.onClose() }, icon('close', 13, 2)),
      ),
      body,
      h('div', { class: 'ip-local' }, h('span', { class: 'dot' }), 'Read locally on your device. Nothing was uploaded.'),
    );
    let sections = this.cache.get(file);
    if (!sections) {
      sections = import('./metadata').then((m) => m.readMetadata(file));
      this.cache.set(file, sections);
    }
    let result: MetaSection[];
    try {
      result = await sections;
    } catch (error) {
      result = [{ title: 'Note', rows: [{ label: 'Error', value: error instanceof Error ? error.message : String(error) }] }];
    }
    if (mine !== this.token) return;
    const onlyFile = result.length === 1 && result[0].title === 'File';
    body.replaceChildren(
      ...result.map((s) =>
        h(
          'section',
          { class: 'ip-sec' },
          h('h3', {}, s.title),
          h(
            'dl',
            {},
            ...s.rows.flatMap((r) => [
              h('dt', {}, r.label),
              h(
                'dd',
                {},
                r.href
                  ? h('a', { href: r.href, target: '_blank', rel: 'noopener noreferrer', title: 'Opens an external website in a new tab and sends it the coordinates.' }, r.value, icon('external', 12))
                  : r.value,
              ),
            ]),
          ),
        ),
      ),
      ...(onlyFile ? [h('p', { class: 'ip-note' }, 'No further metadata for this format.')] : []),
    );
  }
}
