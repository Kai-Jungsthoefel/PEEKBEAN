// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionOf } from '../core/bytes';
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';
import type { SheetData, SheetResponse } from '../workers/sheet-types';
import { createGrid, type Grid } from './grid';

function readWorkbook(buffer: ArrayBuffer, csv: boolean, styled: boolean): Promise<{ sheets: SheetData[]; formatted: boolean }> {
  const worker = new Worker(new URL('../workers/sheet.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<SheetResponse>) => {
      worker.terminate();
      if (event.data.ok) resolve({ sheets: event.data.sheets, formatted: event.data.formatted });
      else reject(new Error(event.data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The spreadsheet could not be read.'));
    };
    worker.postMessage({ buffer, csv, styled }, [buffer]);
  });
}

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  const ext = extensionOf(file.name);
  const csv = ['csv', 'tsv', 'txt'].includes(ext);
  // Formatting is read from the Office Open XML package; for huge files only the values are shown.
  const styled = ['xlsx', 'xlsm', 'xltx', 'xltm'].includes(ext) && file.size < 25 * 1024 * 1024;
  progress(styled ? 'Reading spreadsheet and formatting …' : 'Reading spreadsheet …');
  const { sheets, formatted } = await readWorkbook(await file.arrayBuffer(), csv, styled);
  if (sheets.length === 0) throw new Error('The file contains no worksheets.');

  const address = h('span', { class: 'fx-address' });
  const content = h('span', { class: 'fx-content' });
  const formulaBar = h('div', { class: 'fx-bar' }, address, h('span', { class: 'fx-sep' }, 'fx'), content);
  const gridHost = h('div', { class: 'grid-host' });
  const tabs = h('div', { class: 'sheet-tabs' });
  container.classList.add('spreadsheet');
  container.append(formulaBar, gridHost, tabs);
  const size = h('span', { class: 'meta' });
  toolbar.append(size);
  if (['xlsx', 'xlsm', 'xltx', 'xltm'].includes(ext) && !formatted) {
    container.prepend(h('div', { class: 'banner' }, styled ? 'The formatting could not be read; only the values are shown.' : 'Large file: only the values are shown, without formatting.'));
  }

  let grid: Grid | null = null;
  function show(index: number): void {
    grid?.destroy();
    const sheet = sheets[index];
    grid = createGrid(
      {
        rows: sheet.rows,
        columnCount: sheet.columnCount,
        columnWidths: sheet.columnWidths,
        firstRowNumber: sheet.firstRow + 1,
        rowHeights: sheet.rowHeights,
        styles: sheet.styles,
        merges: sheet.merges,
        gridlines: sheet.gridlines,
        baseStyle: sheet.baseStyle,
      },
      (cellAddress, cell) => {
        address.textContent = cellAddress;
        content.textContent = cell === undefined ? '' : typeof cell === 'string' ? cell : (cell.formula ?? cell.text);
      },
    );
    gridHost.replaceChildren(grid.element);
    address.textContent = '';
    content.textContent = '';
    size.textContent = `${sheet.rows.length.toLocaleString('en-US')} rows × ${sheet.columnCount} columns`;
    for (const [i, tab] of [...tabs.children].entries()) tab.classList.toggle('on', i === index);
  }

  tabs.append(...sheets.map((sheet, i) => h('button', { type: 'button', class: 'sheet-tab', onclick: () => show(i) }, sheet.name)));
  tabs.hidden = sheets.length < 2;
  show(0);

  return { destroy: () => grid?.destroy() };
}
