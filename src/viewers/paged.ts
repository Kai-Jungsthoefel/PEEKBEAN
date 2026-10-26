// SPDX-License-Identifier: GPL-3.0-or-later
// Scrollable, zoomable page area shared by the Word and PowerPoint viewers.
import { h, toolButton } from '../core/dom';

export interface PagedView {
  scroller: HTMLElement;
  pages: HTMLElement;
  /** Width of the content at 100 %, used by "Seitenbreite". */
  setNaturalWidth(width: number): void;
  fitWidth(): void;
}

/** Links in documents open in a new tab; they must never navigate the viewer away. */
export function guardLinks(root: HTMLElement): void {
  root.addEventListener('click', (event) => {
    const link = (event.target as HTMLElement).closest('a[href]');
    if (!link) return;
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) return;
    event.preventDefault();
    if (/^(https?|mailto):/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
  });
}

export function createPagedView(container: HTMLElement, toolbar: HTMLElement): PagedView {
  const pages = h('div', { class: 'paged-pages' });
  const scroller = h('div', { class: 'paged-scroll' }, pages);
  container.append(scroller);
  guardLinks(pages);

  let zoom = 1;
  let naturalWidth = 0;
  const label = h('span', { class: 'meta zoom-label' }, '100 %');
  const apply = () => {
    pages.style.zoom = String(zoom);
    label.textContent = `${Math.round(zoom * 100)} %`;
  };
  const setZoom = (value: number) => {
    zoom = Math.min(4, Math.max(0.25, value));
    apply();
  };
  const fitWidth = () => {
    // Wide windows would blow small pages up; 125 % is plenty.
    if (naturalWidth > 0) setZoom(Math.min(1.25, (scroller.clientWidth - 48) / naturalWidth));
  };
  toolbar.append(
    toolButton('−', 'Zoom out', () => setZoom(zoom / 1.2)),
    label,
    toolButton('+', 'Zoom in', () => setZoom(zoom * 1.2)),
    toolButton('Page width', 'Fit to the window width', fitWidth),
    toolButton('100 %', 'Actual size', () => setZoom(1)),
  );
  return {
    scroller,
    pages,
    setNaturalWidth: (width) => (naturalWidth = width),
    fitWidth,
  };
}
