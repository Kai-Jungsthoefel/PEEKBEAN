// SPDX-License-Identifier: GPL-3.0-or-later
// Structure tree after SOMA's (github.com/Kai-Jungsthoefel/SOMA, app/src/renderer/tree.ts, GPL-3.0): no background,
// only text, branch lines and symbols with a halo, so it stays readable over any part. Collapsed at the start;
// assemblies open one level at a time.
import * as THREE from 'three';
import { h } from '../../core/dom';
import { icon } from '../../core/icons';

export interface TreeNode {
  key: string;
  name: string;
  object: THREE.Object3D;
  children: TreeNode[];
  /** Every mesh, point cloud or line in this subtree. */
  renderables: THREE.Object3D[];
}

export interface TreeHooks {
  /** Visibility or transparency changed: render again. */
  changed(): void;
  setGhost(objects: THREE.Object3D[], on: boolean): void;
  isGhost(object: THREE.Object3D): boolean;
  select(node: TreeNode | null): void;
  /** Double click: frame this part in the view. */
  focus(node: TreeNode): void;
}

const isRenderable = (o: THREE.Object3D) => !o.userData.helper && (o instanceof THREE.Mesh || o instanceof THREE.Points || o instanceof THREE.Line);

/** Mirrors the object hierarchy; unnamed wrappers with a single child and helpers (edge lines) are skipped. */
export function buildTree(object: THREE.Object3D, key = 'root', index = 0): TreeNode | null {
  if (object.userData.helper) return null;
  const children = object.children.map((c, i) => buildTree(c, `${key}/${i}`, i)).filter((n): n is TreeNode => n !== null);
  const own = isRenderable(object) ? [object] : [];
  if (own.length === 0 && children.length === 0) return null;
  if (own.length === 0 && children.length === 1 && !object.name) return children[0];
  return {
    key,
    // Unnamed parts are numbered in file order, so they can still be told apart.
    name: object.name || `${children.length ? 'Assembly' : 'Part'} ${index + 1}`,
    object,
    children,
    renderables: [...own, ...children.flatMap((c) => c.renderables)],
  };
}

function visibleChain(o: THREE.Object3D, stop: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = o; n && n !== stop.parent; n = n.parent) if (!n.visible) return false;
  return true;
}

export class PartsTree {
  private open = false;
  private expanded = new Set<string>();
  private filter = '';
  private selected: TreeNode | null = null;
  private readonly head = h('div', { class: 'tr-hd' });
  private readonly search = h('div', { class: 'tr-search', hidden: true });
  private readonly input = h('input', { type: 'search', placeholder: 'Search parts', spellcheck: false, 'aria-label': 'Search parts' });
  private readonly rowsEl = h('div', { class: 'tr-rows', role: 'tree' });
  private readonly foot = h('div', { class: 'tr-ft', hidden: true });
  readonly element = h('div', { class: 'ptree' });

  constructor(
    private readonly root: TreeNode,
    private readonly title: string,
    private readonly hooks: TreeHooks,
  ) {
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
    this.element.append(this.head, this.search, this.rowsEl, this.foot);
    this.render();
  }

  setSelected(node: TreeNode | null): void {
    this.selected = node;
    this.render();
  }

  /** Path from the root to the deepest node containing `object`. */
  private pathTo(object: THREE.Object3D, node = this.root): TreeNode[] | null {
    if (!node.renderables.includes(object)) return null;
    for (const child of node.children) {
      const path = this.pathTo(object, child);
      if (path) return [node, ...path];
    }
    return [node];
  }

  /** Selects the part an object belongs to, as after a click in the 3D view: opens the tree and its groups. */
  reveal(object: THREE.Object3D | null): TreeNode | null {
    const path = object ? this.pathTo(object) : null;
    const node = path ? path[path.length - 1] : null;
    if (path) {
      this.open = true;
      for (const n of path.slice(0, -1)) this.expanded.add(n.key);
    }
    this.setSelected(node);
    this.rowsEl.querySelector<HTMLElement>('.tr-row.sel')?.scrollIntoView({ block: 'nearest' });
    return node;
  }

  private leaves(node: TreeNode): TreeNode[] {
    return node.children.length ? node.children.flatMap((c) => this.leaves(c)) : [node];
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

  render(): void {
    const leaves = this.leaves(this.root);
    const hidden = leaves.filter((l) => !visibleChain(l.object, this.root.object)).length;
    this.element.classList.toggle('open', this.open);

    const toggle = h(
      'button',
      { type: 'button', class: 'tr-toggle', title: this.open ? 'Collapse the parts tree' : 'Show the parts of the model', 'aria-expanded': String(this.open), onclick: () => {
        this.open = !this.open;
        if (!this.open) this.setSearching(false);
        else this.render();
      } },
      h('span', { class: 'chev' }, icon(this.open ? 'chevDown' : 'chevRight', 13, 2)),
      h('span', { class: 'ico' }, icon('tree', 15, 1.8)),
      h('b', {}, this.title),
      h('span', { class: 'n' }, `${leaves.length} ${leaves.length === 1 ? 'part' : 'parts'}${hidden ? ` · ${hidden} hidden` : ''}`),
    );
    const find = h('button', { type: 'button', class: 'hb', title: 'Search parts', 'aria-label': 'Search parts', onclick: () => this.setSearching(true) }, icon('search', 14, 1.9));
    this.head.replaceChildren(toggle, ...(this.open ? [h('span', { class: 'sp' }), find] : []));

    this.rowsEl.hidden = !this.open;
    this.foot.hidden = !this.open || hidden === 0;
    if (!this.open) return;
    this.foot.replaceChildren(
      icon('eyeoff', 13, 1.8),
      h('span', {}, `${hidden} hidden`),
      h('button', { type: 'button', onclick: () => {
        this.root.object.traverse((o) => (o.visible = true));
        this.hooks.changed();
        this.render();
      } }, 'Show all'),
    );
    const rows = this.rows(this.root.children.length ? this.root.children : [this.root], []);
    this.rowsEl.replaceChildren(...(rows.length ? rows : [h('div', { class: 'tr-hint' }, 'No part matches the search.')]));
  }

  private matches(node: TreeNode): boolean {
    return !this.filter || node.name.toLowerCase().includes(this.filter) || node.children.some((c) => this.matches(c));
  }

  /** `anc`: per level above, whether more items follow there (then the vertical line continues). */
  private rows(nodes: TreeNode[], anc: boolean[]): HTMLElement[] {
    const shown = nodes.filter((n) => this.matches(n));
    return shown.flatMap((node, i) => {
      const last = i === shown.length - 1;
      if (!node.children.length) return [this.row(node, anc, last, false, false)];
      // While searching, groups open so the hits are visible.
      const open = Boolean(this.filter) || this.expanded.has(node.key);
      return [this.row(node, anc, last, true, open), ...(open ? this.rows(node.children, [...anc, !last]) : [])];
    });
  }

  private row(node: TreeNode, anc: boolean[], last: boolean, group: boolean, open: boolean): HTMLElement {
    const visible = node.object.visible;
    const ghosts = node.renderables.filter((o) => this.hooks.isGhost(o)).length;
    const ghost = ghosts > 0 && ghosts === node.renderables.length;
    const branches = h('span', { class: 'br' }, ...anc.map((more) => h('i', { class: more ? 'v' : '' })), h('i', { class: last ? 'l' : 't' }), group ? null : h('i', { class: 'h' }));
    const toggleOpen = () => {
      if (open) this.expanded.delete(node.key);
      else this.expanded.add(node.key);
      this.render();
    };
    const chev = group
      ? h('button', { type: 'button', class: 'chev', title: open ? 'Collapse' : 'Expand', 'aria-expanded': String(open), onclick: toggleOpen }, icon(open ? 'chevDown' : 'chevRight', 12, 2))
      : null;
    const eye = h(
      'button',
      { type: 'button', class: `tg eye${visible ? '' : ' on'}`, title: visible ? 'Hide' : 'Show', 'aria-label': `${visible ? 'Hide' : 'Show'} ${node.name}`, onclick: () => {
        node.object.visible = !visible;
        this.hooks.changed();
        this.render();
      } },
      icon(visible ? 'eye' : 'eyeoff', 14, 1.8),
    );
    const gh = h(
      'button',
      { type: 'button', class: `tg gh${ghost ? ' on' : ghosts ? ' partly' : ''}`, title: ghost ? 'Make opaque' : 'Make transparent', 'aria-pressed': String(ghost), onclick: () => {
        this.hooks.setGhost(node.renderables, !ghost);
        this.hooks.changed();
        this.render();
      } },
      icon('ghost', 14, 1.8),
    );
    const name = h('button', { type: 'button', class: 'nm', title: group ? `${node.name}: expand; double-click shows the assembly` : `${node.name}: select; double-click shows the part` }, node.name);
    let clickTimer = 0;
    name.addEventListener('click', () => {
      // Wait briefly so a double click does not also toggle or select.
      window.clearTimeout(clickTimer);
      clickTimer = window.setTimeout(() => {
        if (group) toggleOpen();
        else {
          const next = this.selected === node ? null : node;
          this.hooks.select(next);
          this.setSelected(next);
        }
      }, 220);
    });
    name.addEventListener('dblclick', () => {
      window.clearTimeout(clickTimer);
      this.hooks.focus(node);
    });
    const classes = ['tr-row', group ? 'gr' : '', visible ? '' : 'off', this.selected === node ? 'sel' : ''].filter(Boolean).join(' ');
    return h('div', { class: classes, role: 'treeitem' }, branches, chev, eye, gh, name, group ? h('span', { class: 'cnt' }, String(this.leaves(node).length)) : null);
  }
}
