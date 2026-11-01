// SPDX-License-Identifier: GPL-3.0-or-later
// LaTeX: the source, and the document typeset with TeX Live in the browser (latex/typeset.ts), shown by the PDF
// viewer. A switch in the toolbar changes between the two; each keeps its own controls. Typesetting starts at once,
// so the PDF is usually ready by the time someone switches to it. Archives of a project open here via "Open as"; when
// one holds several documents (an article and its slides), a list picks the one to typeset.
import { h } from '../core/dom';
import { icon } from '../core/icons';
import type { Viewer, ViewerContext } from '../core/types';
import { errorSummary, readProject, typeset, type Typeset } from '../latex/typeset';

type Mode = 'source' | 'pdf';
/** Files of a project worth reading as text */
const SOURCES = /\.(tex|ltx|latex|bib|sty|cls|bst|bbx|cbx|def|cfg|txt|md)$/i;

const stemOf = (path: string) => path.replace(/^.*\//, '').replace(/\.[^.]+$/, '');

export async function mount({ file, container, toolbar, openFile, progress }: ViewerContext): Promise<Viewer> {
  progress('Reading LaTeX …');
  const project = await readProject(file);
  const typesettable = project.documents.length > 0;
  container.classList.add('latex-viewer');

  const panes: Record<Mode, HTMLElement> = { source: h('div', { class: 'latex-pane' }), pdf: h('div', { class: 'latex-pane' }) };
  const bars: Record<Mode, HTMLElement> = { source: h('span', { class: 'latex-bar' }), pdf: h('span', { class: 'latex-bar' }) };
  const buttons: Record<Mode, HTMLButtonElement> = {
    source: h('button', { type: 'button', role: 'radio', onclick: () => show('source') }, 'Source'),
    pdf: h('button', {
      type: 'button',
      role: 'radio',
      disabled: !typesettable,
      title: typesettable ? 'The document typeset by LaTeX' : 'This file has no \\documentclass: it is part of a document, which typesets from its main file.',
      onclick: () => show('pdf'),
    }, 'PDF'),
  };
  // pin: the switch stays in the phone's bottom bar instead of folding into the menu
  toolbar.append(h('div', { class: 'seg pin', role: 'radiogroup', 'aria-label': 'View' }, buttons.source, buttons.pdf), bars.source, bars.pdf);
  container.append(panes.source, panes.pdf);

  // ---- Source: the text viewer, with a choice of the project's files ----
  const sourceFiles = Object.keys(project.files).filter((path) => SOURCES.test(path)).sort((a, b) => (a === project.main ? -1 : b === project.main ? 1 : a.localeCompare(b)));
  const sourceControls = h('span', { class: 'latex-bar' });
  let sourceViewer: Viewer | null = null;
  const showSource = async (path: string) => {
    const text = await import('./text');
    sourceViewer?.destroy();
    const host = h('div', { class: 'latex-source' });
    panes.source.replaceChildren(host);
    sourceControls.replaceChildren();
    sourceViewer = await text.mount({ file: new File([project.files[path] as BlobPart], path.replace(/^.*\//, '')), container: host, toolbar: sourceControls, openFile, progress: () => {} });
  };
  if (sourceFiles.length > 1) {
    const select = h('select', { title: 'File of the project', onchange: () => void showSource(select.value) }, ...sourceFiles.map((path) => h('option', { value: path }, path)));
    bars.source.append(select);
  }
  bars.source.append(sourceControls);
  await showSource(project.main);

  // ---- PDF: typeset a document, then the PDF viewer ----
  const pdfControls = h('span', { class: 'latex-bar' });
  if (project.documents.length > 1) {
    const select = h('select', { title: 'Document to typeset', onchange: () => void typesetDocument(select.value) }, ...project.documents.map((path) => h('option', { value: path }, path)));
    bars.pdf.append(select);
  }
  bars.pdf.append(pdfControls);
  let typesetting: string | null = null;
  let job: AbortController | null = null;
  let timer = 0;
  let pdfViewer: Viewer | null = null;

  const typesetDocument = async (main: string) => {
    if (typesetting === main) return;
    typesetting = main;
    job?.abort();
    const signal = (job = new AbortController()).signal;
    window.clearInterval(timer);
    pdfViewer?.destroy();
    pdfViewer = null;
    pdfControls.replaceChildren();

    const status = h('span', { class: 'lc-text' }, 'Starting TeX …');
    const bar = h('div', { class: 'lc-bar indet' }, h('div'));
    const time = h('span', { class: 'lc-time' });
    const begun = performance.now();
    timer = window.setInterval(() => {
      const seconds = Math.round((performance.now() - begun) / 1000);
      time.textContent = seconds >= 2 ? `${seconds} s` : '';
    }, 500);
    panes.pdf.replaceChildren(h('div', { class: 'status', role: 'status', 'aria-live': 'polite' }, h('div', { class: 'loading-card' },
      h('div', { class: 'lc-hd' }, h('span', { class: 'spinner' }), h('b', { title: main }, `Typesetting ${main.replace(/^.*\//, '')}`)),
      h('div', { class: 'lc-sub' }, status, time),
      bar,
      h('div', { class: 'lc-kind' }, 'With TeX Live, in this browser. The packages a document needs are loaded once.'),
    )));

    let result: Typeset;
    try {
      result = await typeset({ files: project.files, main }, (message, fraction) => {
        status.textContent = message;
        bar.classList.toggle('indet', fraction === undefined);
        (bar.firstChild as HTMLElement).style.width = fraction === undefined ? '' : `${Math.round(fraction * 100)}%`;
      }, signal);
    } catch (error) {
      if (signal.aborted) return;
      panes.pdf.replaceChildren(failure('The document could not be typeset.', [error instanceof Error ? error.message : String(error)]));
      return;
    } finally {
      if (!signal.aborted) window.clearInterval(timer);
    }
    if (signal.aborted) return;
    const logButton = h('button', { type: 'button', class: 'btn sm', title: 'The log of the last LaTeX run', onclick: () => openFile(new File([result.log], `${stemOf(main)}.log`, { type: 'text/plain' })) }, icon('text', 14), 'Log');
    if (!result.pdf) {
      panes.pdf.replaceChildren(failure('LaTeX stopped without a PDF.', [...errorSummary(result.log), ...result.notes], logButton));
      return;
    }
    const host = h('div', { class: 'latex-pdf' });
    panes.pdf.replaceChildren(host);
    const errors = errorSummary(result.log, 50);
    const remarks = [...result.notes, ...(errors.length ? [`LaTeX reported ${errors.length === 50 ? 'many' : errors.length} ${errors.length === 1 ? 'error' : 'errors'}; the PDF may be incomplete. ${errors[0]}`] : [])];
    if (remarks.length) panes.pdf.prepend(h('div', { class: 'banner banner-row' }, h('span', {}, remarks.join(' ')), logButton));
    const viewerBar = h('span', { class: 'latex-bar' });
    pdfControls.append(viewerBar);
    if (!remarks.length) pdfControls.append(logButton);
    const pdf = await import('./pdf');
    const mounted = await pdf.mount({ file: new File([result.pdf as BlobPart], `${stemOf(main)}.pdf`, { type: 'application/pdf' }), container: host, toolbar: viewerBar, openFile, progress: () => {} });
    if (signal.aborted) mounted.destroy();
    else pdfViewer = mounted;
  };

  const failure = (title: string, lines: string[], ...actions: HTMLElement[]) =>
    h('div', { class: 'status' }, h('div', { class: 'error-card' },
      h('div', { class: 'error-hd' }, icon('alert', 18, 1.8), h('b', {}, title)),
      ...lines.map((line) => h('p', { class: 'c2' }, line)),
      h('div', { class: 'actions' }, ...actions, h('button', { type: 'button', class: 'btn sm', onclick: () => show('source') }, 'Show source')),
    ));

  function show(mode: Mode) {
    for (const m of ['source', 'pdf'] as Mode[]) {
      panes[m].hidden = m !== mode;
      bars[m].hidden = m !== mode;
      buttons[m].setAttribute('aria-checked', String(m === mode));
    }
    container.dataset.mode = mode;
    if (mode === 'pdf' && typesetting === null) void typesetDocument(project.main);
  }
  show(typesettable ? 'pdf' : 'source');

  return {
    destroy: () => {
      job?.abort();
      window.clearInterval(timer);
      sourceViewer?.destroy();
      pdfViewer?.destroy();
    },
  };
}
