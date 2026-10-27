// SPDX-License-Identifier: GPL-3.0-or-later
// Virtualized table: only the cells in view exist in the DOM, so sheets with a million rows stay fast.
// Supports Excel formatting: cell styles, row heights, column widths, merged cells and text running into empty neighbors.
import { h } from '../core/dom';

/** A plain string, or an object for cells that need alignment, carry a formula or have a style. */
export type GridCell = string | { text: string; numeric?: boolean; formula?: string; style?: number };

export interface Merge {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface GridData {
  rows: GridCell[][];
  columnCount: number;
  /** Width in pixels per column; missing entries use the default, 0 hides the column. */
  columnWidths?: number[];
  /** Height in pixels per row; missing entries use the default, 0 hides the row. */
  rowHeights?: number[];
  /** Column titles; defaults to A, B, C … */
  columnTitles?: string[];
  /** Tooltips of the column headers, e.g. the column's type; default the title. */
  columnTips?: string[];
  /** Total rows when `rows` is filled on demand (a sparse array); `onView` says which rows are in view. */
  rowCount?: number;
  onView?: (firstRow: number, lastRow: number) => void;
  /** Number of the first row as shown in the row header (Excel rows start at 1). */
  firstRowNumber?: number;
  /** CSS declarations referenced by `GridCell.style`. */
  styles?: string[];
  merges?: Merge[];
  /** Light lines between cells, as in Excel; off when the sheet hides them. */
  gridlines?: boolean;
  /** CSS for the whole grid, e.g. the workbook's default font. */
  baseStyle?: string;
}

const DEFAULT_ROW = 24;
const DEFAULT_WIDTH = 96;
const ROW_HEADER_WIDTH = 56;
const HEAD_HEIGHT = 24;
const MAX_COLUMNS = 1024;
/** How many empty cells a text may run into. */
const MAX_OVERFLOW = 30;

export function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

const cellText = (cell: GridCell | undefined) => (cell === undefined ? '' : typeof cell === 'string' ? cell : cell.text);
const cellStyle = (cell: GridCell | undefined) => (typeof cell === 'object' ? cell.style : undefined);

/** Index of the last offset that is <= value (offsets ascending). */
function floorIndex(offsets: number[], value: number): number {
  let lo = 0;
  let hi = offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= value) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export interface Grid {
  element: HTMLElement;
  /** Draws again, e.g. after rows arrived for `GridData.onView`. */
  refresh(): void;
  destroy(): void;
}

/** Renders `data`; `onSelect` receives the clicked cell's address, content and position. */
export function createGrid(data: GridData, onSelect?: (address: string, cell: GridCell | undefined, row: number, column: number) => void): Grid {
  const columns = Math.min(data.columnCount, MAX_COLUMNS);
  const rowCount = data.rowCount ?? data.rows.length;
  const widths = Array.from({ length: columns }, (_, i) => data.columnWidths?.[i] ?? DEFAULT_WIDTH);
  const heights = Array.from({ length: rowCount }, (_, i) => data.rowHeights?.[i] ?? DEFAULT_ROW);
  const lefts = [0];
  for (const w of widths) lefts.push(lefts[lefts.length - 1] + w);
  const tops = [0];
  for (const ht of heights) tops.push(tops[tops.length - 1] + ht);
  const totalWidth = lefts[columns];
  const totalHeight = tops[rowCount];
  const firstRowNumber = data.firstRowNumber ?? 1;
  const title = (i: number) => data.columnTitles?.[i] ?? columnName(i);

  // Cells hidden under a merge, and merges by their top left cell.
  const covered = new Set<string>();
  const mergeAt = new Map<string, Merge>();
  for (const m of data.merges ?? []) {
    mergeAt.set(`${m.r0},${m.c0}`, m);
    for (let r = m.r0; r <= m.r1; r++) for (let c = m.c0; c <= m.c1; c++) if (r !== m.r0 || c !== m.c0) covered.add(`${r},${c}`);
  }

  const head = h(
    'div',
    { class: 'grid-head', style: `width:${ROW_HEADER_WIDTH + totalWidth}px` },
    h('div', { class: 'grid-corner', style: `width:${ROW_HEADER_WIDTH}px` }),
    ...widths.map((w, i) => (w > 0 ? h('div', { class: 'grid-ch', style: `left:${ROW_HEADER_WIDTH + lefts[i]}px;width:${w}px`, title: data.columnTips?.[i] ?? title(i) }, title(i)) : null)),
  );
  const rowHeaders = h('div', { class: 'grid-rhs', style: `width:${ROW_HEADER_WIDTH}px;height:${totalHeight}px` });
  const cells = h('div', { class: `grid-cells${data.gridlines === false ? '' : ' lines'}`, style: `left:${ROW_HEADER_WIDTH}px;width:${totalWidth}px;height:${totalHeight}px` });
  const spacer = h('div', { class: 'grid-spacer', style: `width:${ROW_HEADER_WIDTH + totalWidth}px;height:${totalHeight}px` }, rowHeaders, cells);
  const scroller = h('div', { class: 'grid-scroll', tabIndex: 0, style: data.baseStyle ?? '' }, head, spacer);
  const element = h('div', { class: 'grid' }, scroller);
  if (data.columnCount > MAX_COLUMNS) {
    element.prepend(h('div', { class: 'banner' }, `Showing the first ${MAX_COLUMNS} of ${data.columnCount} columns.`));
  }

  const isEmpty = (r: number, c: number) => {
    const cell = data.rows[r]?.[c];
    return !cellText(cell) && cellStyle(cell) === undefined && !covered.has(`${r},${c}`) && !mergeAt.has(`${r},${c}`);
  };

  function cellElement(r: number, c: number, cell: GridCell | undefined, merge?: Merge): HTMLElement {
    const text = cellText(cell);
    const style = cellStyle(cell);
    const numeric = typeof cell === 'object' && cell.numeric;
    let width = merge ? lefts[merge.c1 + 1] - lefts[c] : widths[c];
    const height = merge ? tops[merge.r1 + 1] - tops[r] : heights[r];
    const css = style !== undefined ? data.styles?.[style] ?? '' : '';
    const wrap = css.includes('--wrap:1');
    // Plain left-aligned text runs into the empty cells to its right, as in Excel.
    let overflow = false;
    if (text && !numeric && !merge && !wrap) {
      let next = c + 1;
      while (next < columns && next - c <= MAX_OVERFLOW && isEmpty(r, next)) next++;
      const extended = lefts[next] - lefts[c];
      if (extended > width) {
        width = extended;
        overflow = true;
      }
    }
    const el = h(
      'div',
      { class: `grid-c${numeric ? ' num' : ''}${overflow ? ' over' : ''}${merge ? ' merged' : ''}${wrap ? ' wrap' : ''}`, style: `left:${lefts[c]}px;top:${tops[r]}px;width:${width}px;height:${height}px;${css}`, title: text.length > 24 ? text : undefined },
      h('span', {}, text),
    );
    el.dataset.r = String(r);
    el.dataset.c = String(c);
    return el;
  }

  let selected: { r: number; c: number } | null = null;
  function render(): void {
    const viewTop = Math.max(0, scroller.scrollTop - HEAD_HEIGHT);
    const viewBottom = viewTop + scroller.clientHeight;
    const viewLeft = Math.max(0, scroller.scrollLeft - ROW_HEADER_WIDTH);
    const viewRight = scroller.scrollLeft + scroller.clientWidth;
    const firstRow = rowCount ? Math.max(0, floorIndex(tops, viewTop) - 2) : 0;
    const lastRow = rowCount ? Math.min(rowCount - 1, floorIndex(tops, viewBottom) + 2) : -1;
    // Text may run in from cells left of the view, so start a little earlier.
    const firstCol = columns ? Math.max(0, floorIndex(lefts, viewLeft) - MAX_OVERFLOW) : 0;
    const lastCol = columns ? Math.min(columns - 1, floorIndex(lefts, viewRight) + 1) : -1;

    const fragment = document.createDocumentFragment();
    const headers = document.createDocumentFragment();
    const drawn = new Set<string>();
    // Grid lines as one element per visible row and column; filled cells cover them, as in Excel.
    if (data.gridlines !== false && lastRow >= firstRow && lastCol >= firstCol) {
      const y0 = tops[firstRow];
      const y1 = tops[lastRow + 1];
      const x0 = lefts[firstCol];
      const x1 = lefts[lastCol + 1];
      for (let c = firstCol; c <= lastCol; c++) if (widths[c]) fragment.append(h('div', { class: 'grid-vl', style: `left:${lefts[c + 1] - 1}px;top:${y0}px;height:${y1 - y0}px` }));
      for (let r = firstRow; r <= lastRow; r++) if (heights[r]) fragment.append(h('div', { class: 'grid-hl', style: `top:${tops[r + 1] - 1}px;left:${x0}px;width:${x1 - x0}px` }));
    }
    for (let r = firstRow; r <= lastRow; r++) {
      if (heights[r] === 0) continue;
      headers.append(h('div', { class: 'grid-rh', style: `top:${tops[r]}px;height:${heights[r]}px;line-height:${Math.min(heights[r], DEFAULT_ROW)}px` }, String(r + firstRowNumber)));
      const row = data.rows[r] ?? [];
      for (let c = firstCol; c <= lastCol; c++) {
        if (widths[c] === 0 || covered.has(`${r},${c}`)) continue;
        const cell = row[c];
        const merge = mergeAt.get(`${r},${c}`);
        if (!cellText(cell) && cellStyle(cell) === undefined && !merge) continue;
        fragment.append(cellElement(r, c, cell, merge));
        if (merge) drawn.add(`${r},${c}`);
      }
    }
    // Merges that start above or left of the view but reach into it.
    for (const m of data.merges ?? []) {
      if (drawn.has(`${m.r0},${m.c0}`) || m.r1 < firstRow || m.r0 > lastRow || m.c1 < firstCol || m.c0 > lastCol) continue;
      fragment.append(cellElement(m.r0, m.c0, data.rows[m.r0]?.[m.c0], m));
    }
    if (selected) {
      const m = mergeAt.get(`${selected.r},${selected.c}`);
      const w = m ? lefts[m.c1 + 1] - lefts[selected.c] : widths[selected.c];
      const ht = m ? tops[m.r1 + 1] - tops[selected.r] : heights[selected.r];
      fragment.append(h('div', { class: 'grid-sel', style: `left:${lefts[selected.c]}px;top:${tops[selected.r]}px;width:${w}px;height:${ht}px` }));
    }
    cells.replaceChildren(fragment);
    rowHeaders.replaceChildren(headers);
    if (lastRow >= firstRow) data.onView?.(firstRow, lastRow);
  }

  cells.addEventListener('click', (event) => {
    const rect = cells.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (!rowCount || !columns) return;
    let r = floorIndex(tops, y);
    let c = floorIndex(lefts, x);
    // A click on a hidden cell under a merge selects the merge.
    for (const m of data.merges ?? []) {
      if (r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) {
        r = m.r0;
        c = m.c0;
        break;
      }
    }
    if (r >= rowCount || c >= columns) return;
    selected = { r, c };
    render();
    onSelect?.(`${title(c)}${r + firstRowNumber}`, data.rows[r]?.[c], r, c);
  });

  let frame = 0;
  const schedule = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  };
  scroller.addEventListener('scroll', schedule, { passive: true });
  const resizeObserver = new ResizeObserver(schedule);
  resizeObserver.observe(scroller);

  return {
    element,
    refresh: schedule,
    destroy: () => {
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    },
  };
}
