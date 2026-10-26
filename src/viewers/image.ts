// SPDX-License-Identifier: GPL-3.0-or-later
import { h, toolButton } from '../core/dom';
import type { ViewerContext } from '../core/types';

const MIN_SCALE = 0.02;
const MAX_SCALE = 64;

export async function mount({ file, container, toolbar }: ViewerContext) {
  const url = URL.createObjectURL(file);
  const img = h('img', { class: 'image', alt: file.name, draggable: false });
  img.src = url;
  try {
    // SVGs open through <img> run no scripts, so untrusted SVG files are safe to show.
    await img.decode();
  } catch {
    URL.revokeObjectURL(url);
    throw new Error('Dieses Bildformat wird von diesem Browser nicht unterstützt oder die Datei ist beschädigt.');
  }

  const stage = h('div', { class: 'image-viewer checkerboard' }, img);
  container.append(stage);

  // SVGs without intrinsic size report 0×0.
  const width = img.naturalWidth || 1024;
  const height = img.naturalHeight || 768;
  img.style.width = `${width}px`;
  img.style.height = `${height}px`;

  let scale = 1;
  let x = 0;
  let y = 0;
  let fitted = true;
  const zoomLabel = h('span', { class: 'meta zoom-label' });

  function apply(): void {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    // Show individual pixels when zoomed in, like image editors do.
    img.classList.toggle('pixelated', scale >= 3);
    zoomLabel.textContent = `${Math.round(scale * 100)} %`;
  }

  function fit(): void {
    const { clientWidth: w, clientHeight: hgt } = stage;
    scale = Math.min(1, w / width, hgt / height);
    x = (w - width * scale) / 2;
    y = (hgt - height * scale) / 2;
    fitted = true;
    apply();
  }

  function zoomAt(factor: number, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2): void {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    x = cx - ((cx - x) * next) / scale;
    y = cy - ((cy - y) * next) / scale;
    scale = next;
    fitted = false;
    apply();
  }

  function actualSize(): void {
    zoomAt(1 / scale);
  }

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    },
    { passive: false },
  );

  let drag: { id: number; startX: number; startY: number; x: number; y: number } | null = null;
  stage.addEventListener('pointerdown', (e) => {
    drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, x, y };
    stage.setPointerCapture(e.pointerId);
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    x = drag.x + e.clientX - drag.startX;
    y = drag.y + e.clientY - drag.startY;
    fitted = false;
    apply();
  });
  const endDrag = () => {
    drag = null;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', () => (fitted ? actualSize() : fit()));

  const resizeObserver = new ResizeObserver(() => {
    if (fitted) fit();
  });
  resizeObserver.observe(stage);

  toolbar.append(
    h('span', { class: 'meta' }, img.naturalWidth ? `${width} × ${height} px` : 'Vektorgrafik'),
    toolButton('−', 'Verkleinern', () => zoomAt(1 / 1.25)),
    zoomLabel,
    toolButton('+', 'Vergrößern', () => zoomAt(1.25)),
    toolButton('Einpassen', 'An Fenster anpassen', fit),
    toolButton('100 %', 'Originalgröße', actualSize),
  );
  fit();

  return {
    destroy: () => {
      resizeObserver.disconnect();
      URL.revokeObjectURL(url);
    },
  };
}
