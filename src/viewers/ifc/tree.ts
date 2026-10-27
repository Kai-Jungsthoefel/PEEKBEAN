// SPDX-License-Identifier: GPL-3.0-or-later
// Spatial structure of an IFC model: project, site, building, storeys, the elements of each IFC class, their parts.
// Looks like the parts tree of the 3D view (parts-tree.ts, after SOMA): text, branch lines and symbols with a halo.
// Real models have tens of thousands of elements, so only the rows in sight are in the page.
import { h } from '../../core/dom';
import { icon } from '../../core/icons';
import type { IfcTreeNode } from '../../workers/ifc-types';

export interface IfcTreeHooks {
  /** Elements with geometry in a range, and how many of them are hidden. */
  visibility(first: number, count: number): { shown: number; hidden: number };
  setVisible(node: IfcTreeNode, visible: boolean): void;
  showAll(): void;
  /** Click: show properties (and highlight elements). */
  select(node: IfcTreeNode | null): void;
  /** Double click: frame the node in the view. */
  focus(node: IfcTreeNode): void;
}

interface Row {
  node: IfcTreeNode;
  /** Per level above, whether more items follow there (then the vertical line continues). */
  anc: boolean[];
  last: boolean;
  open: boolean;
}

const ROW_HEIGHT = 24;
/** Rows drawn beyond the visible ones, so fast scrolling does not show gaps. */
const OVERSCAN = 12;
const WIDE = window.matchMedia('(min-width: 640px)');

export class IfcTree {
  private open = WIDE.matches;
  private readonly expanded = new Set<IfcTreeNode>();
  private filter = '';
  private selected: IfcTreeNode | null = null;
  private rows: Row[] = [];
  private readonly parent = new Map<IfcTreeNode, IfcTreeNode>();
  /** Lower-case name and class for searching. */
  private readonly searchText = new Map<IfcTreeNode, string>();
  private readonly elementCount: number;
  private frame = 0;
  private clickTimer = 0;
  private readonly head = h('div', { class: 'tr-hd' });
  private readonly search = h('div', { class: 'tr-search', hidden: true });
  private readonly input = h('input', { type: 'search', placeholder: 'Search name or IFC class', spellcheck: false, 'aria-label': 'Search elements' });
  private readonly spacer = h('div', { class: 'ifc-spacer' });
  private readonly rowsEl = h('div', { class: 'tr-rows', role: 'tree' }, this.spacer);
  private readonly foot = h('div', { class: 'tr-ft', hidden: true });
  readonly element = h('div', { class: 'ptree ifc-tree' });

  constructor(
    private readonly root: IfcTreeNode,
    private readonly hooks: IfcTreeHooks,
  ) {
    let elements = 0;
    const walk = (node: IfcTreeNode) => {
      if (node.kind === 'element') elements++;
      // Project, site, building and storeys start open; groups of elements closed.
      if (node.kind === 'spatial') this.expanded.add(node);
      for (const child of node.children) {
        this.parent.set(child, node);
        walk(child);
      }
    };
    walk(root);
    this.elementCount = elements;

    const close = h('button', { type: 'button', class: 'hb', title: 'Close search (Escape)', 'aria-label': 'Close search' }, icon('close', 13, 2));
    close.addEventListener('click', () => this.setSearching(false));
    this.search.append(icon('search', 14, 1.9), this.input, close);
    this.input.addEventListener('input', () => {
      this.filter = this.input.value.trim().toLowerCase();
      this.render();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        this.setSearching(false);
      }
    });
    this.rowsEl.addEventListener('scroll', () => this.scheduleRows());
    this.element.append(this.head, this.search, this.rowsEl, this.foot);
    this.render();
  }

  get count(): number {
    return this.elementCount;
  }

  /** Marks a node as selected, opening its branch, as after a click in the 3D view. */
  reveal(node: IfcTreeNode | null): void {
    this.selected = node;
    if (node) {
      if (WIDE.matches) this.open = true;
      for (let n = this.parent.get(node); n; n = this.parent.get(n)) this.expanded.add(n);
    }
    this.render();
    const index = node ? this.rows.findIndex((r) => r.node === node) : -1;
    if (index >= 0) {
      const top = index * ROW_HEIGHT;
      const { scrollTop, clientHeight } = this.rowsEl;
      if (top < scrollTop || top + ROW_HEIGHT > scrollTop + clientHeight) this.rowsEl.scrollTop = top - clientHeight / 2;
      this.renderRows();
    }
  }

  private setSearching(on: boolean): void {
    this.search.hidden = !on;
    this.head.hidden = on;
    if (!on) {
      this.input.value = '';
      this.filter = '';
    }
    this.render();
    if (on) this.input.focus();
  }

  private matches(node: IfcTreeNode): boolean {
    let text = this.searchText.get(node);
    if (text === undefined) {
      text = `${node.name}\n${node.ifcClass}`.toLowerCase();
      this.searchText.set(node, text);
    }
    return text.includes(this.filter);
  }

  /** The rows to show: open branches, or while searching every hit with the branches leading to it. */
  private flatten(): Row[] {
    const rows: Row[] = [];
    const filtering = Boolean(this.filter);
    // While searching, a node is listed if it or something below it matches.
    const hits = new Set<IfcTreeNode>();
    if (filtering) {
      const mark = (node: IfcTreeNode): boolean => {
        let hit = this.matches(node);
        for (const child of node.children) if (mark(child)) hit = true;
        if (hit) hits.add(node);
        return hit;
      };
      mark(this.root);
    }
    const add = (nodes: IfcTreeNode[], anc: boolean[]) => {
      const shown = filtering ? nodes.filter((n) => hits.has(n)) : nodes;
      shown.forEach((node, i) => {
        const last = i === shown.length - 1;
        const open = node.children.length > 0 && (filtering ? node.children.some((c) => hits.has(c)) : this.expanded.has(node));
        rows.push({ node, anc, last, open });
        if (open) add(node.children, [...anc, !last]);
      });
    };
    add(this.root.children.length ? this.root.children : [this.root], []);
    return rows;
  }

  render(): void {
    const { hidden } = this.hooks.visibility(this.root.first, this.root.count);
    this.element.classList.toggle('open', this.open);
    const toggle = h(
      'button',
      { type: 'button', class: 'tr-toggle', title: this.open ? 'Collapse the model structure' : 'Show the structure of the model', 'aria-expanded': String(this.open), onclick: () => {
        this.open = !this.open;
        if (!this.open) this.setSearching(false);
        else this.render();
      } },
      h('span', { class: 'chev' }, icon(this.open ? 'chevDown' : 'chevRight', 13, 2)),
      h('span', { class: 'ico' }, icon('building', 15, 1.8)),
      h('b', {}, this.root.name),
      h('span', { class: 'n' }, `${this.elementCount.toLocaleString('en-US')} ${this.elementCount === 1 ? 'element' : 'elements'}${hidden ? ` · ${hidden.toLocaleString('en-US')} hidden` : ''}`),
    );
    const find = h('button', { type: 'button', class: 'hb', title: 'Search elements', 'aria-label': 'Search elements', onclick: () => this.setSearching(true) }, icon('search', 14, 1.9));
    this.head.replaceChildren(toggle, ...(this.open ? [h('span', { class: 'sp' }), find] : []));

    this.rowsEl.hidden = !this.open;
    this.foot.hidden = !this.open || hidden === 0;
    if (!this.open) return;
    this.foot.replaceChildren(
      icon('eyeoff', 13, 1.8),
      h('span', {}, `${hidden.toLocaleString('en-US')} hidden`),
      h('button', { type: 'button', title: 'Show every element, rooms and openings included', onclick: () => {
        this.hooks.showAll();
        this.render();
      } }, 'Show all'),
    );
    this.rows = this.flatten();
    this.spacer.style.height = `${this.rows.length * ROW_HEIGHT}px`;
    this.renderRows();
  }

  private scheduleRows(): void {
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.renderRows();
    });
  }

  /** Puts the rows in sight (and a few around them) into the page. */
  private renderRows(): void {
    if (!this.rows.length) {
      this.spacer.replaceChildren(h('div', { class: 'tr-hint' }, this.filter ? 'Nothing matches the search.' : 'The model has no elements.'));
      this.spacer.style.height = '';
      return;
    }
    const height = this.rowsEl.clientHeight || 600;
    const from = Math.max(0, Math.floor(this.rowsEl.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const to = Math.min(this.rows.length, Math.ceil((this.rowsEl.scrollTop + height) / ROW_HEIGHT) + OVERSCAN);
    const elements: HTMLElement[] = [];
    for (let i = from; i < to; i++) {
      const row = this.row(this.rows[i]);
      row.style.top = `${i * ROW_HEIGHT}px`;
      elements.push(row);
    }
    this.spacer.replaceChildren(...elements);
  }

  private row({ node, anc, last, open }: Row): HTMLElement {
    const group = node.children.length > 0;
    const { shown, hidden } = this.hooks.visibility(node.first, node.count);
    const allHidden = shown > 0 && hidden === shown;
    const branches = h('span', { class: 'br' }, ...anc.map((more) => h('i', { class: more ? 'v' : '' })), h('i', { class: last ? 'l' : 't' }), group ? null : h('i', { class: 'h' }));
    const toggleOpen = () => {
      if (this.expanded.has(node)) this.expanded.delete(node);
      else this.expanded.add(node);
      this.render();
    };
    const chev = group
      ? h('button', { type: 'button', class: 'chev', title: open ? 'Collapse' : 'Expand', 'aria-expanded': String(open), onclick: toggleOpen }, icon(open ? 'chevDown' : 'chevRight', 12, 2))
      : null;
    const eye = h(
      'button',
      {
        type: 'button',
        class: `tg eye${allHidden ? ' on' : hidden ? ' partly' : ''}`,
        title: allHidden ? 'Show' : 'Hide',
        'aria-label': `${allHidden ? 'Show' : 'Hide'} ${node.name}`,
        disabled: shown === 0,
        onclick: () => {
          this.hooks.setVisible(node, allHidden);
          this.render();
        },
      },
      icon(allHidden ? 'eyeoff' : 'eye', 14, 1.8),
    );
    const what = node.kind === 'group' ? 'group' : node.kind === 'spatial' ? node.ifcClass.replace(/^Ifc/, '').toLowerCase() : 'element';
    const name = h(
      'button',
      { type: 'button', class: 'nm', title: `${node.name}${node.kind === 'element' ? ` (${node.ifcClass})` : ''}: ${node.kind === 'group' ? 'expand' : 'select'}; double-click shows the ${what}` },
      node.name,
    );
    name.addEventListener('click', () => {
      // Wait briefly so a double click does not also toggle or select.
      window.clearTimeout(this.clickTimer);
      this.clickTimer = window.setTimeout(() => {
        if (node.kind === 'group') {
          toggleOpen();
          return;
        }
        const next = this.selected === node ? null : node;
        this.selected = next;
        if (next && node.kind === 'spatial' && group) this.expanded.add(node);
        this.hooks.select(next);
        this.render();
      }, 220);
    });
    name.addEventListener('dblclick', () => {
      window.clearTimeout(this.clickTimer);
      this.hooks.focus(node);
    });
    const classes = ['tr-row', group ? 'gr' : '', allHidden ? 'off' : '', this.selected === node ? 'sel' : '', `k-${node.kind}`].filter(Boolean).join(' ');
    return h(
      'div',
      { class: classes, role: 'treeitem', 'aria-selected': String(this.selected === node) },
      branches,
      chev,
      eye,
      name,
      group && node.kind !== 'spatial' ? h('span', { class: 'cnt' }, node.children.length.toLocaleString('en-US')) : null,
    );
  }

  dispose(): void {
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.clickTimer);
  }
}
