// SPDX-License-Identifier: GPL-3.0-or-later
import { h } from './core/dom';
import { icon } from './core/icons';

/** Same breakpoint as the phone layout in styles.css. */
const PHONE = window.matchMedia('(max-width: 639px)');

/**
 * On phones the file bar sits at the bottom and must not scroll sideways: the viewer's tools fold into a menu
 * behind a "⋯" button, and only tools marked with the class `pin` (Measure, Section) stay in the bar.
 * On wider screens the menu and the pinned slot are transparent to the layout (display: contents).
 */
export class MoreMenu {
  readonly panel: HTMLElement;
  /** Where pinned tools go on phones; empty otherwise. */
  readonly pinned = h('div', { class: 'pinned-tools' });
  readonly button = h(
    'button',
    { type: 'button', class: 'ibtn more-btn', title: 'More tools', 'aria-label': 'More tools', 'aria-haspopup': 'true', 'aria-expanded': 'false', onclick: () => this.setOpen(!this.isOpen) },
    icon('more', 20),
  );
  /** Pinned tool → placeholder at its original spot in the toolbar, to put it back when the screen widens. */
  private readonly markers = new Map<HTMLElement, Comment>();
  private readonly observer = new MutationObserver(() => this.sync());

  constructor(private readonly tools: HTMLElement, ...rest: HTMLElement[]) {
    this.panel = h('div', { class: 'more-menu' }, tools, ...rest);
    // Viewers fill their toolbar while and after they load, so pinned tools are picked up as they appear.
    this.observer.observe(tools, { childList: true, subtree: true });
    PHONE.addEventListener('change', this.sync);
    document.addEventListener('pointerdown', this.closeOutside);
    document.addEventListener('keydown', this.closeOnEscape);
  }

  private get isOpen(): boolean {
    return this.panel.classList.contains('open');
  }

  private setOpen(open: boolean): void {
    this.panel.classList.toggle('open', open);
    this.button.setAttribute('aria-expanded', String(open));
  }

  private readonly sync = () => {
    // A viewer that rebuilds its toolbar removes the placeholder; the moved tool belongs to the old toolbar.
    for (const [tool, marker] of this.markers) {
      if (!this.tools.contains(marker)) {
        tool.remove();
        this.markers.delete(tool);
      }
    }
    if (PHONE.matches) {
      for (const tool of this.tools.querySelectorAll<HTMLElement>('.pin')) {
        const marker = new Comment('pinned');
        tool.before(marker);
        this.markers.set(tool, marker);
        this.pinned.append(tool);
      }
    } else {
      for (const [tool, marker] of this.markers) marker.replaceWith(tool);
      this.markers.clear();
      this.setOpen(false);
    }
  };

  private readonly closeOutside = (e: PointerEvent) => {
    if (this.isOpen && !this.panel.contains(e.target as Node) && !this.button.contains(e.target as Node)) this.setOpen(false);
  };

  private readonly closeOnEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') this.setOpen(false);
  };

  dispose(): void {
    this.observer.disconnect();
    PHONE.removeEventListener('change', this.sync);
    document.removeEventListener('pointerdown', this.closeOutside);
    document.removeEventListener('keydown', this.closeOnEscape);
  }
}
