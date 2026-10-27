// SPDX-License-Identifier: GPL-3.0-or-later
// Circuit boards from Gerber and Excellon drill files. One file shows that layer; several (a ZIP of a board's
// fabrication files) show the finished board from the top or the bottom, or all layers in their colors. Reading and
// plotting run in a worker with tracespace (MIT), drawing on a 2D canvas; measuring snaps to pads, holes and edges.
import { extensionOf, startsWith } from '../core/bytes';
import { h, toolButton } from '../core/dom';
import { onThemeChange, tokenColor } from '../core/theme';
import type { Viewer, ViewerContext } from '../core/types';
import type { PcbRequest, PcbResponse } from '../workers/pcb.worker';
import { createLayerPanel } from './layers';
import { Measure2D, ShapeIndex, SnapIndex } from './measure2d';
import type { PcbLayer, PcbReadResult } from './pcb/read';
import { BOARD, boardShape, drawLayer, layerAlpha, layerColor, layerPaths, snapData, type Box, type Matrix } from './pcb/render';

type Mode = 'top' | 'bottom' | 'layers';

const ARCHIVE_EXTENSIONS = ['zip', '7z', 'rar', 'tar', 'gz', 'tgz'];
/** Files in a board's ZIP that are certainly not Gerber or drill data. */
const NOT_GERBER = /\.(?:pdf|png|jpe?g|gif|bmp|svg|webp|csv|xlsx?|ods|docx?|zip|7z|rar|gbrjob|json|md|html?|pos|rpt|xml|step|stp|wrl|kicad_\w+|sch|brd|lbr|exe|dll)$/i;
const MAX_ENTRY = 64 * 1024 * 1024;
const MIN_SCALE = 0.05;
const MAX_SCALE = 5000;

/** From the top of the stack down, as the layer list shows them; drawn in reverse. */
const STACK = ['silkscreen-top', 'solderpaste-top', 'soldermask-top', 'copper-top', 'copper-inner', 'copper-bottom', 'soldermask-bottom', 'solderpaste-bottom', 'silkscreen-bottom', 'drill', 'outline', 'drawing', 'other'];
const stackRank = (l: PcbLayer) => {
  const index = STACK.indexOf(l.type === 'drill' || l.type === 'outline' || l.type === 'drawing' || l.type === 'other' ? l.type : `${l.type}-${l.side}`);
  return index < 0 ? STACK.length : index;
};

const TYPE_NAMES: Record<string, string> = { copper: 'copper', soldermask: 'solder mask', silkscreen: 'silkscreen', solderpaste: 'paste' };
function layerLabel(l: PcbLayer): string {
  if (l.type === 'drill') return l.plated === false ? 'Drill, non-plated' : 'Drill';
  if (l.type === 'outline') return 'Board outline';
  if (l.type === 'drawing') return 'Drawing';
  if (l.type === 'other') return 'Unknown layer';
  const side = { top: 'Top', bottom: 'Bottom', inner: 'Inner', all: '' }[l.side];
  return `${side} ${TYPE_NAMES[l.type]}`.trim();
}

const baseName = (name: string) => name.replace(/\\/g, '/').replace(/^.*\//, '');

/** The files to read: the file itself, or the Gerber candidates inside an archive. */
async function inputFiles(file: File): Promise<{ files: PcbRequest['files']; archive: boolean; encrypted: number }> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const archive = startsWith(head, 'PK\x03\x04') || startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || startsWith(head, 'Rar!') || ARCHIVE_EXTENSIONS.includes(extensionOf(file.name));
  if (!archive) return { files: [{ name: file.name, blob: file }], archive, encrypted: 0 };
  const { openArchive } = await import('./archive');
  const opened = await openArchive(file);
  const files: PcbRequest['files'] = [];
  let encrypted = 0;
  try {
    for (const entry of opened.entries) {
      if (NOT_GERBER.test(entry.name) || entry.size > MAX_ENTRY || entry.name.startsWith('._') || entry.dir.startsWith('__MACOSX/')) continue;
      if (entry.encrypted) encrypted++;
      else files.push({ name: entry.dir + entry.name, blob: await entry.read() });
    }
  } finally {
    await opened.close();
  }
  return { files, archive, encrypted };
}

function readInWorker(files: PcbRequest['files']): Promise<PcbReadResult> {
  const worker = new Worker(new URL('../workers/pcb.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<PcbResponse>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<PcbResponse>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || 'The Gerber reader could not be loaded.'));
    worker.postMessage({ files } satisfies PcbRequest);
  })
    .finally(() => worker.terminate())
    .then((result) => {
      if (!result.ok) throw new Error(result.error);
      return result;
    });
}

const union = (boxes: (Box | null)[]): Box | null =>
  boxes.reduce<Box | null>((all, b) => (!b ? all : !all ? [...b] : [Math.min(all[0], b[0]), Math.min(all[1], b[1]), Math.max(all[2], b[2]), Math.max(all[3], b[3])]), null);

export async function mount({ file, container, toolbar, progress }: ViewerContext): Promise<Viewer> {
  progress('Reading files …');
  const input = await inputFiles(file);
  progress('Plotting layers …');
  const result = input.files.length ? await readInWorker(input.files) : { layers: [], warnings: [] };
  const layers = result.layers.sort((a, b) => stackRank(a) - stackRank(b) || a.name.localeCompare(b.name, 'en'));
  if (!layers.length) {
    throw new Error(input.archive
      ? 'The archive contains no Gerber or Excellon drill files.'
      : 'This file is neither a Gerber nor an Excellon drill file.');
  }
  const paths = layers.map(layerPaths);
  const outline = boardShape(layers.filter((l) => l.type === 'outline'));
  const sided = layers.some((l) => (l.side === 'top' || l.side === 'bottom') && ['copper', 'soldermask', 'silkscreen'].includes(l.type));
  const visible = layers.map((l) => layers.length === 1 || !['solderpaste', 'drawing', 'other'].includes(l.type));
  if (!visible.some(Boolean)) visible.fill(true);
  let mode: Mode = layers.length > 1 && sided ? 'top' : 'layers';

  // ---- Stage, canvases ----------------------------------------------------------------------------------------------
  container.classList.add('pcb-view');
  const canvas = h('canvas', { class: 'pcb-canvas' });
  const stage = h('div', { class: 'pcb-stage' }, canvas);
  container.append(stage);
  if (result.warnings.length || input.encrypted) {
    const notes = [...result.warnings];
    if (input.encrypted) notes.unshift(`${input.encrypted} encrypted ${input.encrypted === 1 ? 'file was' : 'files were'} skipped.`);
    container.prepend(h('div', { class: 'banner' }, `Not everything could be read: ${notes.join(' · ')}`));
  }
  const main = canvas.getContext('2d')!;
  const buffer = () => {
    const c = document.createElement('canvas');
    return { canvas: c, ctx: c.getContext('2d')! };
  };
  const frame = buffer();
  const work = buffer();
  const mask = buffer();
  const tint = buffer();
  const buffers = [frame, work, mask, tint];

  let width = 1;
  let height = 1;
  let dpr = 1;
  let background = '';
  let darkPaper = true;
  const readTheme = () => {
    background = tokenColor(container, '--drawing-bg');
    const [r, g, b] = (background.match(/\d+(\.\d+)?/g) ?? ['0', '0', '0']).map(Number);
    darkPaper = 0.2126 * r + 0.7152 * g + 0.0722 * b < 128;
  };
  readTheme();

  // ---- View: CSS pixels per mm and the drawing point in the middle ----------------------------------------------------
  const view = { scale: 1, cx: 0, cy: 0 };
  let fitted = true;
  const flip = () => (mode === 'bottom' ? -1 : 1);
  const matrix = (): Matrix => {
    const s = view.scale * dpr;
    return [s * flip(), 0, 0, -s, (width / 2) * dpr - s * flip() * view.cx, (height / 2) * dpr + s * view.cy];
  };
  const toScreen = (x: number, y: number) => ({ x: width / 2 + flip() * view.scale * (x - view.cx), y: height / 2 - view.scale * (y - view.cy) });
  const toWorld = (sx: number, sy: number) => ({ x: view.cx + (sx - width / 2) / (flip() * view.scale), y: view.cy - (sy - height / 2) / view.scale });

  const shownLayers = () => layers.filter((l, i) => visible[i] && (mode === 'layers' || l.side === mode || l.side === 'all'));
  const extents = () => (outline && mode !== 'layers' ? outline.box : null) ?? union(shownLayers().map((l) => l.bounds)) ?? union(layers.map((l) => l.bounds)) ?? [0, 0, 1, 1];

  function fit(): void {
    const [x1, y1, x2, y2] = extents();
    view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.min(width / ((x2 - x1) * 1.08 || 1), height / ((y2 - y1) * 1.08 || 1))));
    view.cx = (x1 + x2) / 2;
    view.cy = (y1 + y2) / 2;
    fitted = true;
    invalidate(true);
  }

  // ---- Drawing --------------------------------------------------------------------------------------------------------
  const clear = (b: { ctx: CanvasRenderingContext2D; canvas: HTMLCanvasElement }) => {
    b.ctx.setTransform(1, 0, 0, 1, 0, 0);
    b.ctx.globalCompositeOperation = 'source-over';
    b.ctx.globalAlpha = 1;
    b.ctx.clearRect(0, 0, b.canvas.width, b.canvas.height);
  };
  /** Draws the given layers into `target` in plain white, as a mask. */
  const drawMask = (target: typeof work, indices: number[]) => {
    clear(target);
    const m = matrix();
    for (const i of indices) drawLayer(target.ctx, paths[i], m, 1 / (view.scale * dpr), '#fff');
    target.ctx.setTransform(1, 0, 0, 1, 0, 0);
  };
  /** Paints `source` (a mask) in a color onto the frame. */
  const paint = (source: HTMLCanvasElement, color: string, cut?: { canvas: HTMLCanvasElement; keep: boolean }) => {
    clear(tint);
    tint.ctx.drawImage(source, 0, 0);
    if (cut) {
      tint.ctx.globalCompositeOperation = cut.keep ? 'destination-in' : 'destination-out';
      tint.ctx.drawImage(cut.canvas, 0, 0);
    }
    tint.ctx.globalCompositeOperation = 'source-in';
    tint.ctx.fillStyle = color;
    tint.ctx.fillRect(0, 0, tint.canvas.width, tint.canvas.height);
    frame.ctx.drawImage(tint.canvas, 0, 0);
  };
  const indicesOf = (test: (l: PcbLayer) => boolean) => layers.flatMap((l, i) => (visible[i] && test(l) ? [i] : []));

  function drawBoard(side: 'top' | 'bottom'): void {
    const f = frame.ctx;
    const copper = indicesOf((l) => l.type === 'copper' && l.side === side);
    const masks = indicesOf((l) => l.type === 'soldermask' && l.side === side);
    const silk = indicesOf((l) => l.type === 'silkscreen' && l.side === side);
    const paste = indicesOf((l) => l.type === 'solderpaste' && l.side === side);
    const drills = indicesOf((l) => l.type === 'drill');
    f.save();
    f.setTransform(...matrix());
    if (outline) {
      f.clip(outline.path, 'evenodd');
    } else {
      const [x1, y1, x2, y2] = extents();
      f.beginPath();
      f.rect(x1, y1, x2 - x1, y2 - y1);
      f.clip();
    }
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.fillStyle = BOARD.substrate;
    f.fillRect(0, 0, frame.canvas.width, frame.canvas.height);
    if (masks.length) drawMask(mask, masks);
    if (copper.length) {
      drawMask(work, copper);
      paint(work.canvas, BOARD.copper);
    }
    if (masks.length) {
      // The mask covers the board except for its openings, which the mask layer draws.
      clear(tint);
      tint.ctx.fillStyle = BOARD.mask;
      tint.ctx.fillRect(0, 0, tint.canvas.width, tint.canvas.height);
      tint.ctx.globalCompositeOperation = 'destination-out';
      tint.ctx.drawImage(mask.canvas, 0, 0);
      f.drawImage(tint.canvas, 0, 0);
    }
    if (copper.length) paint(work.canvas, BOARD.finish, masks.length ? { canvas: mask.canvas, keep: true } : undefined);
    if (silk.length) {
      drawMask(work, silk);
      paint(work.canvas, BOARD.silk, masks.length ? { canvas: mask.canvas, keep: false } : undefined);
    }
    if (paste.length) {
      drawMask(work, paste);
      paint(work.canvas, BOARD.paste);
    }
    f.restore();
    if (drills.length) {
      drawMask(work, drills);
      paint(work.canvas, background);
    }
  }

  /** Bottom layers first, top layers over them; holes and the outline over everything, as CAD programs show them. */
  const drawOrder = layers.map((_, i) => i).reverse().sort((a, b) => Number(['outline', 'drill'].includes(layers[a].type)) - Number(['outline', 'drill'].includes(layers[b].type)));
  function drawLayers(): void {
    const f = frame.ctx;
    for (const i of drawOrder) {
      if (!visible[i]) continue;
      clear(work);
      drawLayer(work.ctx, paths[i], matrix(), 1 / (view.scale * dpr), layerColor(layers[i], darkPaper));
      f.setTransform(1, 0, 0, 1, 0, 0);
      f.globalAlpha = layers.length === 1 ? 1 : layerAlpha(layers[i].type);
      f.drawImage(work.canvas, 0, 0);
      f.globalAlpha = 1;
    }
  }

  /** The view the frame was drawn with, to move it around until the next full drawing. */
  let drawn: { scale: number; cx: number; cy: number; mode: Mode } | null = null;
  let renderMs = 0;
  function renderFull(): void {
    const started = performance.now();
    clear(frame);
    frame.ctx.fillStyle = background;
    frame.ctx.fillRect(0, 0, frame.canvas.width, frame.canvas.height);
    if (mode === 'layers') drawLayers();
    else drawBoard(mode);
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.drawImage(frame.canvas, 0, 0);
    drawn = { ...view, mode };
    renderMs = performance.now() - started;
    measure.update();
  }

  /** Shifts and scales the last full frame; large boards are drawn in full once the view stops moving. */
  function renderPreview(): void {
    if (!drawn || drawn.mode !== mode) return renderFull();
    const k = view.scale / drawn.scale;
    const tx = width / 2 + flip() * view.scale * (drawn.cx - view.cx) - (k * width) / 2;
    const ty = height / 2 - view.scale * (drawn.cy - view.cy) - (k * height) / 2;
    main.setTransform(1, 0, 0, 1, 0, 0);
    main.fillStyle = background;
    main.fillRect(0, 0, canvas.width, canvas.height);
    main.setTransform(k, 0, 0, k, tx * dpr, ty * dpr);
    main.drawImage(frame.canvas, 0, 0);
    measure.update();
  }

  let frameRequest = 0;
  let fullTimer = 0;
  let needFull = false;
  function invalidate(full = false): void {
    needFull ||= full;
    if (frameRequest) return;
    frameRequest = requestAnimationFrame(() => {
      frameRequest = 0;
      window.clearTimeout(fullTimer);
      if (needFull || renderMs < 40) {
        needFull = false;
        renderFull();
      } else {
        renderPreview();
        fullTimer = window.setTimeout(renderFull, 160);
      }
    });
  }

  function resize(): void {
    width = Math.max(1, stage.clientWidth);
    height = Math.max(1, stage.clientHeight);
    dpr = Math.min(2, window.devicePixelRatio || 1);
    for (const c of [canvas, ...buffers.map((b) => b.canvas)]) {
      c.width = Math.round(width * dpr);
      c.height = Math.round(height * dpr);
    }
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    if (fitted) fit();
    else invalidate(true);
  }

  // ---- Pan and zoom: wheel, drag, pinch ------------------------------------------------------------------------------
  function zoomAt(factor: number, sx = width / 2, sy = height / 2): void {
    const before = toWorld(sx, sy);
    view.scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, view.scale * factor));
    const after = toWorld(sx, sy);
    view.cx += before.x - after.x;
    view.cy += before.y - after.y;
    fitted = false;
    invalidate();
  }
  const local = (e: { clientX: number; clientY: number }) => {
    const rect = stage.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };
  stage.addEventListener('wheel', (e) => {
    e.preventDefault();
    const p = local(e);
    zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y);
  }, { passive: false });
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { id: number; x: number; y: number } | null = null;
  let pinch = 0;
  const pinchState = () => {
    const [p, q] = [...pointers.values()];
    return { distance: Math.hypot(p.x - q.x, p.y - q.y), x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 };
  };
  stage.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, local(e));
    stage.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      drag = null;
      pinch = pinchState().distance;
      return;
    }
    drag = { id: e.pointerId, ...local(e) };
    stage.classList.add('dragging');
  });
  // The pointer position goes into a corner of the view; the toolbar is full enough.
  const coords = h('div', { class: 'pcb-coords', hidden: true });
  stage.append(coords);
  stage.addEventListener('pointermove', (e) => {
    const p = local(e);
    const w = toWorld(p.x, p.y);
    coords.textContent = `X ${w.x.toFixed(3)}  Y ${w.y.toFixed(3)} mm`;
    coords.hidden = false;
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size === 2) {
      const now = pinchState();
      if (now.distance > 0) zoomAt(now.distance / pinch, now.x, now.y);
      pinch = now.distance;
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    view.cx -= (p.x - drag.x) / (flip() * view.scale);
    view.cy += (p.y - drag.y) / view.scale;
    drag.x = p.x;
    drag.y = p.y;
    fitted = false;
    invalidate();
  });
  const endDrag = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    drag = null;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('pointerleave', () => (coords.hidden = true));
  stage.addEventListener('dblclick', fit);

  // ---- Measuring ------------------------------------------------------------------------------------------------------
  let snaps: { points: SnapIndex; shapes: ShapeIndex } | null = null;
  const snapIndex = () => {
    if (!snaps) {
      const [x1, y1, x2, y2] = extents();
      const cell = Math.max(x2 - x1, y2 - y1, 1) / 256;
      // Where centers coincide, the first one wins: a hole over the pad and mask opening around it.
      const priority = (l: PcbLayer) => ['drill', 'outline', 'copper'].indexOf(l.type) >>> 0;
      const data = snapData(shownLayers().sort((a, b) => priority(a) - priority(b)));
      snaps = { points: new SnapIndex(data.points, cell), shapes: new ShapeIndex(data.shapes, cell) };
    }
    return snaps;
  };
  const measure = new Measure2D({
    // The stage captures the pointer for panning, so it is the one that sees clicks end.
    surface: stage,
    overlay: stage,
    toWorld: (clientX, clientY) => {
      const p = local({ clientX, clientY });
      return toWorld(p.x, p.y);
    },
    toScreen: (p) => toScreen(p.x, p.y),
    unitsPerPixel: () => 1 / view.scale,
    snap: (p, tolerance) => {
      const index = snapIndex();
      return index.points.nearest(p, tolerance) ?? index.shapes.nearest(p, tolerance, tolerance * 8);
    },
    convert: (length) => length,
    unit: () => 'mm',
    describe: (p) => `X ${p.x.toFixed(3)} · Y ${p.y.toFixed(3)}`,
  });
  container.append(h('div', { class: 'cards' }, measure.card));

  // ---- Toolbar and layer list -----------------------------------------------------------------------------------------
  const modeButtons = (['top', 'bottom', 'layers'] as const).map((m) =>
    h('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(m === mode),
      title: m === 'top' ? 'The finished board seen from the top' : m === 'bottom' ? 'The finished board seen from the bottom (mirrored)' : 'All layers in their colors',
      onclick: () => setMode(m),
    }, m === 'top' ? 'Top' : m === 'bottom' ? 'Bottom' : 'Layers'),
  );
  function setMode(next: Mode): void {
    if (next === mode) return;
    // The same spot stays in the middle; the bottom view only mirrors the board around it.
    mode = next;
    modeButtons.forEach((b, i) => b.setAttribute('aria-checked', String(['top', 'bottom', 'layers'][i] === mode)));
    snaps = null;
    invalidate(true);
  }

  const entries = layers.map((l, i) => ({ id: String(i), name: `${layerLabel(l)} · ${baseName(l.name)}`, color: layerColor(l, darkPaper) }));
  const panel = createLayerPanel(entries, {
    isVisible: (id) => visible[Number(id)],
    setVisible: (ids, show) => {
      for (const id of ids) visible[Number(id)] = show;
      snaps = null;
      invalidate(true);
    },
  });
  if (panel) {
    container.append(panel.panel);
    // On phones the list would cover most of the board; it opens from the toolbar.
    if (window.matchMedia('(max-width: 639px)').matches) panel.button.click();
  }

  const [x1, y1, x2, y2] = outline?.box ?? union(layers.map((l) => l.bounds)) ?? [0, 0, 0, 0];
  const describe = layers.length > 1
    ? `${layers.length} layers`
    : layers[0].type === 'other' ? layers[0].format : `${layerLabel(layers[0])} · ${layers[0].format}`;
  toolbar.append(
    ...(layers.length > 1 && sided ? [h('div', { class: 'seg pcb-modes', role: 'radiogroup', 'aria-label': 'View' }, ...modeButtons)] : []),
    h('span', { class: 'meta', title: layers.map((l) => `${baseName(l.name)}: ${layerLabel(l)} (${l.format}, ${l.units === 'mm' ? 'mm' : 'inch'})`).join('\n') }, describe),
    h('span', { class: 'meta', title: outline ? 'Board size from the outline' : 'Extents of all layers' }, `${(x2 - x1).toFixed(2)} × ${(y2 - y1).toFixed(2)} mm`),
    toolButton('Fit', 'Show the whole board', fit),
    ...(panel ? [panel.button] : []),
    measure.button,
  );

  const stopTheme = onThemeChange(() => {
    readTheme();
    panel?.panel.querySelectorAll<HTMLElement>('.swatch').forEach((swatch, i) => (swatch.style.background = layerColor(layers[i], darkPaper)));
    invalidate(true);
  });
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  resize();

  return {
    destroy: () => {
      cancelAnimationFrame(frameRequest);
      window.clearTimeout(fullTimer);
      observer.disconnect();
      stopTheme();
      measure.dispose();
      // Frees the canvas memory right away instead of waiting for garbage collection.
      for (const c of [canvas, ...buffers.map((b) => b.canvas)]) c.width = c.height = 0;
    },
  };
}
