// SPDX-License-Identifier: GPL-3.0-or-later
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { h, toolButton } from '../core/dom';
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
  ['auto', 'Automatisch'],
  ['page-width', 'Seitenbreite'],
  ['page-fit', 'Ganze Seite'],
  ['0.5', '50 %'],
  ['1', '100 %'],
  ['1.5', '150 %'],
  ['2', '200 %'],
  ['4', '400 %'],
];

export async function mount({ file, container, toolbar }: ViewerContext) {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    cMapUrl: assetUrl('cmaps'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('standard_fonts'),
    wasmUrl: assetUrl('wasm'),
    iccUrl: assetUrl('iccs'),
  });
  let passwordCancelled = false;
  loadingTask.onPassword = (update: (password: string) => void, reason: number) => {
    const password = window.prompt(
      reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD
        ? 'Falsches Passwort. Bitte erneut eingeben:'
        : 'Diese PDF ist passwortgeschützt. Passwort:',
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
    if (passwordCancelled) throw new Error('Ohne Passwort kann die Datei nicht geöffnet werden.');
    if ((error as Error).name === 'InvalidPDFException') {
      throw new Error('Die Datei ist keine gültige PDF oder sie ist beschädigt.');
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
    title: 'Seite',
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

  const findInput = h('input', { class: 'find-input', type: 'search', placeholder: 'Suchen …', title: 'Im Dokument suchen' });
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
    toolButton('−', 'Verkleinern', () => pdfViewer.decreaseScale()),
    zoomSelect,
    toolButton('+', 'Vergrößern', () => pdfViewer.increaseScale()),
    findInput,
    toolButton('↑', 'Vorheriger Treffer (Umschalt+Enter)', () => find('again', true)),
    toolButton('↓', 'Nächster Treffer (Enter)', () => find('again')),
    findStatus,
  );

  return {
    destroy: () => {
      pdfViewer.cleanup();
      void loadingTask.destroy();
    },
  };
}
