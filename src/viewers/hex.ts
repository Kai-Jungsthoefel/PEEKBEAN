// SPDX-License-Identifier: GPL-3.0-or-later
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';

const BYTES_PER_ROW = 16;
const CHUNK_SIZE = 64 * 1024;
const MAX_CACHED_CHUNKS = 64;
// Browsers cap element heights (~17M px in Firefox), so huge files scroll proportionally instead of per row.
const MAX_SCROLL_HEIGHT = 10_000_000;

export async function mount({ file, container, toolbar }: ViewerContext) {
  const totalRows = Math.max(1, Math.ceil(file.size / BYTES_PER_ROW));
  const offsetDigits = Math.max(8, file.size.toString(16).length);
  const chunks = new Map<number, Uint8Array>();
  const pending = new Set<number>();
  let destroyed = false;

  const pre = h('pre', { class: 'hex-rows' });
  const spacer = h('div', { class: 'hex-spacer' });
  const scroller = h('div', { class: 'hex-viewer', tabIndex: 0 }, h('div', { class: 'hex-sticky' }, pre), spacer);
  container.append(scroller);

  // Measure a row instead of hard-coding it, the font size comes from CSS.
  pre.textContent = '0';
  const rowHeight = pre.getBoundingClientRect().height || 18;
  let firstRow = 0;

  function visibleRows(): number {
    return Math.max(1, Math.floor(scroller.clientHeight / rowHeight));
  }

  function layout(): void {
    const contentHeight = totalRows * rowHeight;
    spacer.style.height = `${Math.max(0, Math.min(contentHeight, MAX_SCROLL_HEIGHT) - scroller.clientHeight)}px`;
    render();
  }

  function loadChunk(index: number): void {
    if (pending.has(index)) return;
    pending.add(index);
    const start = index * CHUNK_SIZE;
    void file
      .slice(start, start + CHUNK_SIZE)
      .arrayBuffer()
      .then((buffer) => {
        pending.delete(index);
        if (destroyed) return;
        chunks.set(index, new Uint8Array(buffer));
        if (chunks.size > MAX_CACHED_CHUNKS) chunks.delete(chunks.keys().next().value!);
        render();
      });
  }

  function byteAt(offset: number): number | undefined {
    const index = Math.floor(offset / CHUNK_SIZE);
    const chunk = chunks.get(index);
    if (!chunk) {
      loadChunk(index);
      return undefined;
    }
    return chunk[offset - index * CHUNK_SIZE];
  }

  function render(): void {
    const rows = visibleRows();
    const maxFirstRow = Math.max(0, totalRows - rows);
    const maxScroll = scroller.scrollHeight - scroller.clientHeight;
    firstRow = maxScroll > 0 ? Math.round((scroller.scrollTop / maxScroll) * maxFirstRow) : 0;

    const lines: string[] = [];
    for (let row = firstRow; row < Math.min(totalRows, firstRow + rows + 1); row++) {
      const offset = row * BYTES_PER_ROW;
      let hex = '';
      let ascii = '';
      for (let i = 0; i < BYTES_PER_ROW; i++) {
        if (i === 8) hex += ' ';
        if (offset + i >= file.size) {
          hex += '   ';
          continue;
        }
        const b = byteAt(offset + i);
        hex += b === undefined ? '·· ' : b.toString(16).padStart(2, '0') + ' ';
        ascii += b === undefined ? ' ' : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
      }
      lines.push(`${offset.toString(16).padStart(offsetDigits, '0')}  ${hex} ${ascii}`);
    }
    pre.textContent = lines.join('\n');
  }

  function goTo(offset: number): void {
    const row = Math.min(totalRows - 1, Math.floor(offset / BYTES_PER_ROW));
    const maxFirstRow = Math.max(1, totalRows - visibleRows());
    scroller.scrollTop = (row / maxFirstRow) * (scroller.scrollHeight - scroller.clientHeight);
  }

  const offsetInput = h('input', {
    class: 'offset-input',
    placeholder: 'Offset, e.g. 0x1F40',
    title: 'Jump to offset (decimal, or hexadecimal with 0x); Enter confirms',
    onkeydown: (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const raw = offsetInput.value.trim();
      const value = /^0x/i.test(raw) ? parseInt(raw.slice(2), 16) : Number(raw);
      if (Number.isFinite(value) && value >= 0) goTo(value);
    },
  });
  toolbar.append(offsetInput);

  let frame = 0;
  const onScroll = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(render);
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  const resizeObserver = new ResizeObserver(layout);
  resizeObserver.observe(scroller);
  layout();

  return {
    destroy: () => {
      destroyed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
    },
  };
}
