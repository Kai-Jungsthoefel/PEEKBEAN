// SPDX-License-Identifier: GPL-3.0-or-later
// Jupyter notebooks (.ipynb): Markdown cells via marked, code with syntax colors, and the saved outputs (text,
// pictures, HTML tables, error tracebacks). Nothing is executed; HTML and Markdown are sanitized with DOMPurify.
import { LanguageDescription } from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { highlightCode } from '@lezer/highlight';
import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { StyleModule } from 'style-mod';
import { h } from '../core/dom';
import { hasRemoteResources } from '../core/sandbox';
import { syntax } from '../core/syntax';
import type { ViewerContext } from '../core/types';
import { guardLinks } from './paged';

type Source = string | string[];

interface Output {
  output_type: 'stream' | 'execute_result' | 'display_data' | 'error';
  name?: string;
  text?: Source;
  data?: Record<string, Source>;
  ename?: string;
  evalue?: string;
  traceback?: string[];
}

interface Cell {
  cell_type: 'code' | 'markdown' | 'raw';
  source: Source;
  execution_count?: number | null;
  outputs?: Output[];
}

interface Notebook {
  cells?: Cell[];
  /** nbformat 3 kept the cells in worksheets. */
  worksheets?: { cells: (Cell & { input?: Source; prompt_number?: number })[] }[];
  metadata?: { kernelspec?: { display_name?: string; language?: string }; language_info?: { name?: string } };
  nbformat?: number;
}

const join = (s: Source | undefined) => (Array.isArray(s) ? s.join('') : (s ?? ''));
// Tracebacks carry terminal color codes.
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');

function markdown(text: string): HTMLElement {
  const article = h('div', { class: 'markdown-body nb-md' });
  article.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }));
  return article;
}

type Parser = { parse(code: string): Parameters<typeof highlightCode>[1] };

function codeBlock(code: string, parser: Parser | null): HTMLElement {
  const pre = h('pre', { class: 'nb-code' });
  if (!parser) {
    pre.textContent = code;
    return pre;
  }
  highlightCode(code, parser.parse(code), syntax, (text, classes) => pre.append(classes ? h('span', { class: classes }, text) : text), () => pre.append('\n'));
  return pre;
}

function output(out: Output): HTMLElement | null {
  if (out.output_type === 'stream') {
    return h('pre', { class: `nb-stream${out.name === 'stderr' ? ' nb-error' : ''}` }, stripAnsi(join(out.text)));
  }
  if (out.output_type === 'error') {
    return h('pre', { class: 'nb-stream nb-error' }, stripAnsi((out.traceback ?? []).join('\n') || `${out.ename}: ${out.evalue}`));
  }
  const data = out.data ?? {};
  // The richest representation the viewer can show safely.
  for (const type of ['image/png', 'image/jpeg', 'image/gif', 'image/webp']) {
    if (data[type]) return h('img', { class: 'nb-image', src: `data:${type};base64,${join(data[type]).replace(/\s/g, '')}`, alt: 'Output' });
  }
  if (data['image/svg+xml']) {
    // As an <img>, an SVG runs no scripts.
    const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(join(data['image/svg+xml']))}`;
    return h('img', { class: 'nb-image', src: url, alt: 'Output' });
  }
  if (data['text/html']) {
    const div = h('div', { class: 'nb-html' });
    div.innerHTML = DOMPurify.sanitize(join(data['text/html']));
    return div;
  }
  if (data['text/markdown']) return markdown(join(data['text/markdown']));
  if (data['text/latex']) return h('pre', { class: 'nb-stream' }, join(data['text/latex']));
  if (data['text/plain']) return h('pre', { class: 'nb-stream' }, stripAnsi(join(data['text/plain'])));
  return null;
}

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  progress('Reading notebook …');
  let notebook: Notebook;
  try {
    notebook = JSON.parse(await file.text()) as Notebook;
  } catch {
    throw new Error('The notebook is not valid JSON.');
  }
  const cells: Cell[] =
    notebook.cells ??
    (notebook.worksheets ?? []).flatMap((w) => w.cells.map((c) => ({ ...c, source: c.source ?? c.input ?? '', execution_count: c.execution_count ?? c.prompt_number })));
  if (!Array.isArray(cells)) throw new Error('This file is not a Jupyter notebook.');

  const languageName = notebook.metadata?.language_info?.name ?? notebook.metadata?.kernelspec?.language ?? 'python';
  const description = LanguageDescription.matchLanguageName(languages, languageName, true);
  const parser = description ? ((await description.load()).language.parser as Parser) : null;
  if (syntax.module) StyleModule.mount(document, syntax.module);

  const list = h('div', { class: 'nb-cells' });
  for (const cell of cells) {
    const source = join(cell.source);
    if (cell.cell_type === 'markdown') {
      list.append(h('div', { class: 'nb-cell' }, h('div', { class: 'nb-prompt' }), markdown(source)));
      continue;
    }
    if (cell.cell_type === 'raw') {
      list.append(h('div', { class: 'nb-cell' }, h('div', { class: 'nb-prompt' }), h('pre', { class: 'nb-code' }, source)));
      continue;
    }
    const count = cell.execution_count ?? ' ';
    list.append(h('div', { class: 'nb-cell' }, h('div', { class: 'nb-prompt' }, `In [${count}]:`), codeBlock(source, parser)));
    const outputs = (cell.outputs ?? []).map(output).filter((o): o is HTMLElement => o !== null);
    if (outputs.length) {
      const result = cell.outputs?.some((o) => o.output_type === 'execute_result');
      list.append(h('div', { class: 'nb-cell nb-out' }, h('div', { class: 'nb-prompt' }, result ? `Out[${count}]:` : ''), h('div', { class: 'nb-outputs' }, ...outputs)));
    }
  }
  guardLinks(list);
  if (hasRemoteResources(list.innerHTML)) container.append(h('div', { class: 'banner' }, 'Images from the internet are not loaded.'));
  container.append(h('div', { class: 'notebook' }, list));

  const codeCells = cells.filter((c) => c.cell_type === 'code').length;
  const kernel = notebook.metadata?.kernelspec?.display_name ?? description?.name ?? languageName;
  toolbar.append(h('span', { class: 'meta' }, `${kernel} · ${cells.length} cells, ${codeCells} with code`));
  return { destroy: () => {} };
}
