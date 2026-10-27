// SPDX-License-Identifier: GPL-3.0-or-later
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { h, toolButton } from '../core/dom';
import { createLayerPanel, type LayerEntry } from './layers';
import { Measure2D } from './measure2d';
import type { ViewerContext } from '../core/types';

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
// pdf_viewer.mjs takes the core library from this global instead of importing it.
(globalThis as { pdfjsLib?: unknown }).pdfjsLib = pdfjsLib;
const { EventBus, FindState, LinkTarget, PDFFindController, PDFLinkService, PDFViewer } = await import(
  'pdfjs-dist/web/pdf_viewer.mjs'
);

// Copied into the build by vite.config.ts, so pdf.js never reaches out to a CDN.
const assetUrl = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;

const ZOOM_PRESETS: [string, string][] = [
  ['auto', 'Automatic'],
  ['page-width', 'Page width'],
  ['page-fit', 'Whole page'],
  ['0.5', '50 %'],
  ['1', '100 %'],
  ['1.5', '150 %'],
  ['2', '200 %'],
  ['4', '400 %'],
];

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'),
  });
  loadingTask.onProgress = ({ loaded, total }: { loaded: number; total: number }) => progress('Reading PDF …', total ? loaded / total : undefined);
  let passwordCancelled = false;
  loadingTask.onPassword = (update: (password: string) => void, reason: number) => {
    const password = window.prompt(
      reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
        ? 'Wrong password. Please try again:'
        : 'This PDF is password protected. Password:',
    );
    if (password === null) {
      passwordCancelled = true;
      void loadingTask.destroy();
    } else {
      update(password);
    }
  };

  let pdf: pdfjsLib.PDFDocumentProxy;
  try {
    pdf = await loadingTask.promise;
  } catch (error) {
    if (passwordCancelled) throw new Error('The file cannot be opened without a password.');
    if ((error as Error).name === 'InvalidPDFException') {
      throw new Error('The file is not a valid PDF, or it is damaged.');
    }
    throw error;
  }

  const viewerEl = h('div', { class: 'pdfViewer' });
  const scroller = h('div', { class: 'pdf-container' }, viewerEl);
  container.append(scroller);

  const eventBus = new EventBus();
  const linkService = new PDFLinkService({
    eventBus,
    externalLinkTarget: LinkTarget.BLANK,
    externalLinkRel: 'noopener noreferrer nofollow',
  });
  const findController = new PDFFindController({ eventBus, linkService });
  const pdfViewer = new PDFViewer({ container: scroller, viewer: viewerEl, eventBus, linkService, findController });
  linkService.setViewer(pdfViewer);
  pdfViewer.setDocument(pdf);
  linkService.setDocument(pdf, null);

  const pageInput = h('input', {
    class: 'page-input',
    value: '1',
    inputMode: 'numeric',
    title: 'Page',
    onkeydown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const page = Number(pageInput.value);
      if (Number.isInteger(page) && page >= 1 && page <= pdf.numPages) pdfViewer.currentPageNumber = page;
      else pageInput.value = String(pdfViewer.currentPageNumber);
    },
  });
  const zoomSelect = h(
    'select',
    { title: 'Zoom', onchange: () => (pdfViewer.currentScaleValue = zoomSelect.value) },
    ...ZOOM_PRESETS.map(([value, label]) => h('option', { value }, label)),
    h('option', { value: 'custom', hidden: true }),
  );

  const findInput = h('input', { class: 'find-input', type: 'search', placeholder: 'Search …', title: 'Search the document' });
  const findStatus = h('span', { class: 'meta' });
  const find = (type: '' | 'again', findPrevious = false) => {
    eventBus.dispatch('find', {
      source: null,
      type,
      query: findInput.value,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    });
  };
  findInput.addEventListener('input', () => find(''));
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') find('again', e.shiftKey);
  });

  eventBus.on('pagesinit', () => {
    pdfViewer.currentScaleValue = 'auto';
  });
  eventBus.on('pagechanging', ({ pageNumber }: { pageNumber: number }) => {
    pageInput.value = String(pageNumber);
  });
  eventBus.on('scalechanging', ({ scale, presetValue }: { scale: number; presetValue?: string }) => {
    const custom = zoomSelect.querySelector<HTMLOptionElement>('option[value="custom"]')!;
    if (presetValue && ZOOM_PRESETS.some(([value]) => value === presetValue)) {
      zoomSelect.value = presetValue;
    } else {
      custom.textContent = `${Math.round(scale * 100)} %`;
      zoomSelect.value = 'custom';
    }
  });
  eventBus.on('updatefindmatchescount', ({ matchesCount }: { matchesCount: { current: number; total: number } }) => {
    findStatus.textContent = matchesCount.total ? `${matchesCount.current} / ${matchesCount.total}` : '';
  });
  eventBus.on('updatefindcontrolstate', ({ state }: { state: number }) => {
    findInput.classList.toggle('not-found', state === FindState.NOT_FOUND && findInput.value !== '');
  });

  toolbar.append(
    pageInput,
    h('span', { class: 'meta' }, `/ ${pdf.numPages}`),
    toolButton('−', 'Zoom out', () => pdfViewer.decreaseScale()),
    zoomSelect,
    toolButton('+', 'Zoom in', () => pdfViewer.increaseScale()),
    findInput,
    toolButton('↑', 'Previous match (Shift+Enter)', () => find('again', true)),
    toolButton('↓', 'Next match (Enter)', () => find('again')),
    findStatus,
  );

  const measure = pdfMeasure(pdfViewer, scroller, viewerEl);
  container.append(h('div', { class: 'cards' }, measure.card));
  for (const event of ['pagerendered', 'scalechanging', 'rotationchanging', 'updateviewarea']) eventBus.on(event, () => measure.update());
  toolbar.append(measure.button);

  // Layers (optional content): the viewer has its configuration once the pages are set up. Layers are switched on
  // that configuration, which is then handed back to redraw the pages.
  eventBus.on('pagesinit', async () => {
    const optional = await pdfViewer.optionalContentConfigPromise;
    const layers = optional
      ? createLayerPanel(layerEntries(optional), {
          isVisible: (id) => optional.getGroup(id)?.visible ?? true,
          setVisible: (ids, visible) => {
            for (const id of ids) optional.setVisibility(id, visible);
            pdfViewer.optionalContentConfigPromise = Promise.resolve(optional);
          },
        })
      : null;
    if (!layers) return;
    container.append(layers.panel);
    measure.button.before(layers.button);
  }, { once: true });

  return {
    destroy: () => {
      measure.dispose();
      pdfViewer.cleanup();
      void loadingTask.destroy();
    },
  };
}

type OptionalContent = NonNullable<Awaited<ReturnType<pdfjsLib.PDFDocumentProxy['getOptionalContentConfig']>>>;

/**
 * Layers in the order the file gives for its layer panel. Entries of the order are layer ids or nested lists:
 * a named list is a heading over its layers, an unnamed one holds the sub-layers of the layer before it.
 */
function layerEntries(config: OptionalContent): LayerEntry[] {
  const entries: LayerEntry[] = [];
  const seen = new Set<string>();
  const walk = (order: unknown[], depth: number) => {
    for (const item of order) {
      if (typeof item === 'string') {
        const group = config.getGroup(item);
        if (!group || seen.has(item)) continue;
        seen.add(item);
        entries.push({ id: item, name: group.name || 'Unnamed layer', depth });
      } else if (item && typeof item === 'object' && Array.isArray((item as { order?: unknown }).order)) {
        const { name, order: inner } = item as { name: string | null; order: unknown[] };
        if (name) entries.push({ name, depth });
        walk(inner, depth + 1);
      }
    }
  };
  walk(config.getOrder() ?? [], 0);
  return entries;
}

// PDF user space unit: 1/72 inch.
const MM_PER_POINT = 25.4 / 72;
const CSS_PX_PER_POINT = 96 / 72;
const UNITS: [string, number][] = [['mm', 1], ['cm', 10], ['m', 1000], ['in', 25.4]];

/** Measuring on PDF pages: lengths on paper, times the drawing scale the user enters (e.g. 1:50). */
function pdfMeasure(pdfViewer: InstanceType<typeof PDFViewer>, scroller: HTMLElement, viewerEl: HTMLElement): Measure2D {
  const scaleInput = h('input', { type: 'number', min: '0', step: 'any', value: '1', title: 'Drawing scale: 50 for 1:50, 1 for lengths on paper' });
  const unitSelect = h('select', { title: 'Unit' }, ...UNITS.map(([unit]) => h('option', { value: unit }, unit)));
  const settings = h('label', { class: 'mc-scale' }, h('span', {}, 'Scale 1 :'), scaleInput, unitSelect);
  const mmPer = (unit: string) => UNITS.find(([u]) => u === unit)?.[1] ?? 1;
  const factor = () => (Number(scaleInput.value) > 0 ? Number(scaleInput.value) : 1) / mmPer(unitSelect.value);
  const num = (v: number) => v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return new Measure2D({
    surface: scroller,
    overlay: viewerEl,
    toWorld: (clientX, clientY) => {
      const page = (document.elementFromPoint(clientX, clientY) as HTMLElement | null)?.closest<HTMLElement>('.page');
      const pageNumber = Number(page?.dataset.pageNumber);
      const view = pageNumber ? pdfViewer.getPageView(pageNumber - 1) : null;
      if (!page || !view) return null;
      const rect = page.getBoundingClientRect();
      const [x, y] = view.viewport.convertToPdfPoint(clientX - rect.left - page.clientLeft, clientY - rect.top - page.clientTop);
      return { x, y, page: pageNumber };
    },
    toScreen: (p) => {
      const view = p.page ? pdfViewer.getPageView(p.page - 1) : null;
      if (!view?.div) return null;
      const [vx, vy] = view.viewport.convertToViewportPoint(p.x, p.y);
      const page = view.div.getBoundingClientRect();
      const origin = viewerEl.getBoundingClientRect();
      return { x: page.left - origin.left + view.div.clientLeft + vx, y: page.top - origin.top + view.div.clientTop + vy };
    },
    unitsPerPixel: () => 1 / (pdfViewer.currentScale * CSS_PX_PER_POINT),
    convert: (length) => length * MM_PER_POINT * factor(),
    unit: () => unitSelect.value,
    settings,
    // The known length over the length on paper gives the drawing scale, e.g. 2.5 m measured as 50 mm → 1:50.
    calibrate: {
      units: UNITS.map(([unit]) => unit),
      apply: (length, value, unit) => {
        scaleInput.value = String(Number(((value * mmPer(unit)) / (length * MM_PER_POINT)).toPrecision(8)));
        unitSelect.value = unit;
      },
    },
    describe: (p) => `Page ${p.page} · ${num(p.x * MM_PER_POINT)} / ${num(p.y * MM_PER_POINT)} mm from the sheet edge`,
  });
}
