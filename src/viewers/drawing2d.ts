// SPDX-License-Identifier: GPL-3.0-or-later
// Shared 2D CAD view for DXF and DWG, rendered by dxf-viewer (MPL-2.0).
import * as THREE from 'three';
import { DxfViewer } from 'dxf-viewer';
import fontLatin from '@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-400-normal.woff?url';
import fontLatinExt from '@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-latin-ext-400-normal.woff?url';
import fontCyrillicExt from '@fontsource/ibm-plex-sans-condensed/files/ibm-plex-sans-condensed-cyrillic-ext-400-normal.woff?url';
import fontGreek from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-greek-400-normal.woff?url';
import fontCyrillic from '@fontsource/ibm-plex-sans/files/ibm-plex-sans-cyrillic-400-normal.woff?url';
import { h, toolButton } from '../core/dom';
import { tokenColor } from '../core/theme';
import { createLayerPanel, type LayerPanel } from './layers';
import { Measure2D, ShapeIndex, SnapIndex, type Point2, type Shape2 } from './measure2d';
import type { Viewer, ViewerContext } from '../core/types';

// Text in drawings is rendered from these outlines; characters missing from all of them are skipped. The condensed
// cut comes closer to the narrow CAD fonts (romans, isocp) that drawings are laid out with than regular Plex.
const FONTS = [fontLatin, fontLatinExt, fontCyrillicExt, fontGreek, fontCyrillic];

const ANSI_CODE_PAGES: Record<string, string> = {
  ANSI_874: 'windows-874', ANSI_932: 'shift_jis', ANSI_936: 'gbk', ANSI_949: 'euc-kr', ANSI_950: 'big5',
  ANSI_1250: 'windows-1250', ANSI_1251: 'windows-1251', ANSI_1252: 'windows-1252', ANSI_1253: 'windows-1253',
  ANSI_1254: 'windows-1254', ANSI_1255: 'windows-1255', ANSI_1256: 'windows-1256', ANSI_1257: 'windows-1257',
  ANSI_1258: 'windows-1258',
};

/** DXF from AutoCAD 2007 on is UTF-8; older files use the code page named in the header. */
export function dxfEncoding(head: string): string {
  const version = /\$ACADVER\s*\r?\n\s*1\s*\r?\n\s*AC(\d{4})/.exec(head)?.[1];
  if (version && Number(version) >= 1021) return 'utf-8';
  const codePage = /\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*(\S+)/.exec(head)?.[1]?.toUpperCase();
  return (codePage && ANSI_CODE_PAGES[codePage]) || 'utf-8';
}

function layerPanel(viewer: DxfViewer): LayerPanel | null {
  const layers = [...viewer.GetLayers(true)].sort((a, b) => a.displayName.localeCompare(b.displayName, 'en'));
  const visible = new Map(layers.map((layer) => [layer.name, layer.visible]));
  return createLayerPanel(
    layers.map((layer) => ({ id: layer.name, name: layer.displayName, color: `#${layer.color.toString(16).padStart(6, '0')}` })),
    {
      isVisible: (name) => visible.get(name) ?? true,
      setVisible: (names, show) => {
        for (const name of names) {
          visible.set(name, show);
          viewer.ShowLayer(name, show);
        }
        viewer.Render();
      },
    },
  );
}

export interface DrawingOptions {
  /** URL of the DXF data (usually a blob: URL). */
  url: string;
  encoding: string;
  /** Extra toolbar entries placed before the drawing tools, e.g. the DWG version. */
  info?: (string | Node)[];
}

export async function mountDrawing({ container, toolbar, progress }: ViewerContext, options: DrawingOptions): Promise<Viewer> {
  container.classList.add('drawing');
  const host = h('div', { class: 'drawing-canvas' });
  const status = h('div', { class: 'status' }, h('span', { class: 'spinner' }), h('span', {}, 'Preparing drawing …'));
  container.append(host, status);

  const viewer = new DxfViewer(host, {
    // Light or dark paper as the theme says; color correction turns black and white entities to stay visible on it.
    clearColor: new THREE.Color(tokenColor(container, '--drawing-bg')),
    autoResize: true,
    colorCorrection: true,
    fileEncoding: options.encoding,
    pointerMoveEvent: true,
    // The parsed entities provide the snap points for measuring.
    retainParsedDxf: true,
  });
  const warnings: string[] = [];
  viewer.Subscribe('message', (event) => {
    if (event.detail.level !== 'info') warnings.push(event.detail.message);
  });

  try {
    const phases = { font: 'Loading fonts', fetch: 'Reading drawing', parse: 'Parsing drawing', prepare: 'Preparing geometry' };
    const started = performance.now();
    let lastPhase = '';
    await viewer.Load({
      url: options.url,
      fonts: FONTS,
      workerFactory: () => new Worker(new URL('../workers/dxf.worker.ts', import.meta.url), { type: 'module' }),
      // Big drawings take a while; say what is happening instead of a silent spinner.
      progressCbk: (phase, processed, total) => {
        if (phase !== lastPhase) {
          console.debug(`[dxf] ${phase} from ${((performance.now() - started) / 1000).toFixed(1)} s`);
          lastPhase = phase;
        }
        const percent = total ? ` ${Math.round((processed / total) * 100)} %` : '';
        status.lastChild!.textContent = `${phases[phase]} …${percent}`;
        progress(`${phases[phase]} …`, total ? processed / total : undefined);
      },
    });
    console.debug(`[dxf] done after ${((performance.now() - started) / 1000).toFixed(1)} s`);
  } catch (error) {
    viewer.Destroy();
    throw error;
  } finally {
    status.remove();
  }

  const bounds = viewer.GetBounds();
  if (!bounds) {
    viewer.Destroy();
    throw new Error('The drawing contains nothing that can be displayed in model space.');
  }

  const fit = () => {
    const origin = viewer.GetOrigin();
    viewer.FitView(bounds.minX - origin.x, bounds.maxX - origin.x, bounds.minY - origin.y, bounds.maxY - origin.y);
  };

  const coords = h('span', { class: 'meta coords', title: 'Pointer position in drawing coordinates' });
  viewer.Subscribe('pointermove', (event) => {
    const origin = viewer.GetOrigin();
    const { x, y } = event.detail.position;
    coords.textContent = `X ${(x + origin.x).toFixed(2)}  Y ${(y + origin.y).toFixed(2)}`;
  });

  const layers = layerPanel(viewer);
  if (layers) container.append(layers.panel);

  const measure = drawingMeasure(viewer, container);
  container.append(h('div', { class: 'cards' }, measure.card));
  viewer.Subscribe('viewChanged', () => measure.update());
  viewer.Subscribe('resized', () => measure.update());

  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  toolbar.append(
    ...(options.info ?? []),
    h('span', { class: 'meta', title: 'Extents in model space' }, `${width.toFixed(2)} × ${height.toFixed(2)}`),
    toolButton('Fit', 'Show the whole drawing', fit),
    ...(layers ? [layers.button] : []),
    measure.button,
    coords,
  );
  if (warnings.length) {
    container.prepend(h('div', { class: 'banner' }, warnings.join(' · ')));
  }

  return {
    destroy: () => {
      measure.dispose();
      viewer.Destroy();
    },
  };
}

// $INSUNITS codes of the units a drawing declares for its coordinates.
const INSUNITS: Record<number, string> = { 1: 'in', 2: 'ft', 4: 'mm', 5: 'cm', 6: 'm', 14: 'dm' };

interface DxfPoint {
  x: number;
  y: number;
  /** Polyline vertices: the segment to the next vertex is an arc. */
  bulge?: number;
}

interface DxfEntity {
  type: string;
  inPaperSpace?: boolean;
  vertices?: DxfPoint[];
  center?: DxfPoint;
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  position?: DxfPoint;
  /** Closed polyline. */
  shape?: boolean;
}

/** End points, middles of straight segments, centers and quadrants of the model-space geometry. */
function snapPoints(entities: DxfEntity[]): Point2[] {
  const points: Point2[] = [];
  const add = (p: DxfPoint | undefined) => {
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) points.push({ x: p.x, y: p.y });
  };
  const middle = (a: DxfPoint, b: DxfPoint) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const onCircle = (c: DxfPoint, r: number, angle: number) => ({ x: c.x + r * Math.cos(angle), y: c.y + r * Math.sin(angle) });
  for (const e of entities) {
    if (e.inPaperSpace) continue;
    switch (e.type) {
      case 'LINE':
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const v = e.vertices ?? [];
        v.forEach((p, i) => {
          add(p);
          if (i > 0) add(middle(v[i - 1], p));
        });
        break;
      }
      case 'CIRCLE':
      case 'ARC':
        if (!e.center || e.radius === undefined) break;
        // The center carries the radius, so picking it shows the diameter.
        if (Number.isFinite(e.center.x) && Number.isFinite(e.center.y)) points.push({ x: e.center.x, y: e.center.y, radius: e.radius, arc: e.type === 'ARC' });
        if (e.type === 'CIRCLE') {
          for (let q = 0; q < 4; q++) add(onCircle(e.center, e.radius, (q * Math.PI) / 2));
        } else if (e.startAngle !== undefined && e.endAngle !== undefined) {
          const end = e.endAngle < e.startAngle ? e.endAngle + 2 * Math.PI : e.endAngle;
          add(onCircle(e.center, e.radius, e.startAngle));
          add(onCircle(e.center, e.radius, end));
          add(onCircle(e.center, e.radius, (e.startAngle + end) / 2));
        }
        break;
      case 'POINT':
      case 'INSERT':
        add(e.position);
        break;
      case 'ELLIPSE':
        add(e.center);
        break;
    }
  }
  return points;
}

/** Straight segments and circles of the model-space geometry, for snapping onto lines and circle rims. */
function snapShapes(entities: DxfEntity[]): Shape2[] {
  const shapes: Shape2[] = [];
  const finite = (p: DxfPoint | undefined): p is DxfPoint => !!p && Number.isFinite(p.x) && Number.isFinite(p.y);
  for (const e of entities) {
    if (e.inPaperSpace) continue;
    switch (e.type) {
      case 'LINE':
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const v = e.vertices ?? [];
        const count = e.shape && v.length > 2 ? v.length : v.length - 1;
        for (let i = 0; i < count; i++) {
          const a = v[i];
          const b = v[(i + 1) % v.length];
          // Bulged segments are arcs; only straight ones count as lines.
          if (finite(a) && finite(b) && !a.bulge) shapes.push({ kind: 'line', a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y } });
        }
        break;
      }
      case 'CIRCLE':
      case 'ARC':
        if (!finite(e.center) || !(e.radius! > 0)) break;
        shapes.push({ kind: 'circle', center: { x: e.center.x, y: e.center.y }, radius: e.radius!, ...(e.type === 'ARC' ? { start: e.startAngle, end: e.endAngle } : {}) });
        break;
    }
  }
  return shapes;
}

function drawingMeasure(viewer: DxfViewer, container: HTMLElement): Measure2D {
  const canvas = viewer.GetCanvas();
  const dxf = viewer.GetDxf() as { entities?: DxfEntity[]; header?: Record<string, unknown> } | null;
  const bounds = viewer.GetBounds()!;
  const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) || 1;
  const index = new SnapIndex(snapPoints(dxf?.entities ?? []), extent / 256);
  // Built on first use: large drawings have hundreds of thousands of segments.
  let shapes: ShapeIndex | null = null;
  const unit = INSUNITS[Number(dxf?.header?.['$INSUNITS'])] ?? '';
  const toCanvas = (clientX: number, clientY: number) => {
    const rect = canvas.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  return new Measure2D({
    surface: canvas,
    overlay: container,
    toWorld: (clientX, clientY) => {
      const c = toCanvas(clientX, clientY);
      const p = viewer.CanvasToSceneCoord(c.x, c.y);
      const origin = viewer.GetOrigin();
      return { x: p.x + origin.x, y: p.y + origin.y };
    },
    toScreen: (p) => {
      const origin = viewer.GetOrigin();
      return viewer.SceneToCanvasCoord(p.x - origin.x, p.y - origin.y);
    },
    unitsPerPixel: () => {
      const a = viewer.CanvasToSceneCoord(0, 0);
      const b = viewer.CanvasToSceneCoord(1, 0);
      return Math.hypot(b.x - a.x, b.y - a.y);
    },
    // The tolerance is 12 px, so circles up to about 100 px radius on screen snap to their center over the rim.
    snap: (p, tolerance) => index.nearest(p, tolerance) ?? (shapes ??= new ShapeIndex(snapShapes(dxf?.entities ?? []), extent / 256)).nearest(p, tolerance, tolerance * 8),
    convert: (length) => length,
    unit: () => unit,
  });
}
