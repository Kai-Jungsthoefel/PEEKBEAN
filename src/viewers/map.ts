// SPDX-License-Identifier: GPL-3.0-or-later
// Map data (GIS): shapefiles, KML/KMZ, GPX/TCX, GeoJSON and TopoJSON on an own 2D map without a basemap. Readers:
// shpjs (MIT), togeojson (BSD-2-Clause), topojson-client (ISC), proj4 (MIT) for coordinate systems. The map uses
// Web Mercator, like web maps, so shapes look as people know them; measuring and lengths are computed on the WGS84
// ellipsoid instead (local azimuthal equidistant projection, Vincenty).
import proj4 from 'proj4';
import { h, setPressed, toolButton } from '../core/dom';
import { icon } from '../core/icons';
import { onThemeChange, tokenColor } from '../core/theme';
import type { ViewerContext } from '../core/types';
import { createGrid, type Grid, type GridCell } from './grid';
import { fromEpsg, PICKABLE, type CoordinateSystem } from './map/crs';
import { formatArea, formatDegrees, formatDuration, formatLength, lineLength, ringArea, type TrackStats } from './map/geodesy';
import { LINE, POINT, featureName, identity, lonLat, mercator, type MapLayer } from './map/model';
import { readMap } from './map/read';
import { MapView, type Hit, type MapColors } from './map/view';
import { Measure2D, type Point2 } from './measure2d';

const PALETTE = ['--map-c1', '--map-c2', '--map-c3', '--map-c4', '--map-c5', '--map-c6', '--map-c7', '--map-c8'];
const MAX_COLUMNS = 200;

function colors(element: HTMLElement): MapColors {
  return {
    background: tokenColor(element, '--map-bg'),
    graticule: tokenColor(element, '--map-grid'),
    graticuleText: tokenColor(element, '--map-grid-tx'),
    text: tokenColor(element, '--tx'),
    halo: tokenColor(element, '--map-halo'),
    selection: tokenColor(element, '--acc'),
    palette: PALETTE.map((name) => tokenColor(element, name)),
  };
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function valueText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** Coordinates of one part as [lon, lat] pairs (geographic) or as they are (planar). */
function partCoordinates(layer: MapLayer, part: number): Float64Array {
  const start = layer.parts[part];
  const end = layer.parts[part + 1];
  const out = new Float64Array(2 * (end - start));
  for (let i = start; i < end; i++) {
    if (layer.planar) {
      out[2 * (i - start)] = layer.xy[2 * i];
      out[2 * (i - start) + 1] = layer.xy[2 * i + 1];
    } else {
      const [lon, lat] = lonLat(layer.xy[2 * i], layer.xy[2 * i + 1]);
      out[2 * (i - start)] = lon;
      out[2 * (i - start) + 1] = lat;
    }
  }
  return out;
}

function planarLength(c: Float64Array, closed: boolean): number {
  let total = 0;
  const n = c.length / 2;
  for (let i = 1; i < n + (closed ? 1 : 0); i++) total += Math.hypot(c[2 * (i % n)] - c[2 * (i - 1)], c[2 * (i % n) + 1] - c[2 * (i - 1) + 1]);
  return total;
}

function planarArea(c: Float64Array): number {
  let sum = 0;
  const n = c.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) sum += (c[2 * j] - c[2 * i]) * (c[2 * j + 1] + c[2 * i + 1]);
  return sum / 2;
}

/** Length, area and position of a feature, on the ellipsoid for geographic data. */
function measures(layer: MapLayer, feature: number): [string, string][] {
  const rows: [string, string][] = [];
  let length = 0;
  let perimeter = 0;
  let area = 0;
  let points = 0;
  let first: Float64Array | null = null;
  const unit = (v: number) => (layer.planar ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : formatLength(v));
  for (let g = layer.featureGroups[feature]; g < layer.featureGroups[feature + 1]; g++) {
    const kind = layer.groups[3 * g];
    for (let p = layer.groups[3 * g + 1]; p < layer.groups[3 * g + 2]; p++) {
      const c = partCoordinates(layer, p);
      first ??= c;
      if (kind === POINT) points += c.length / 2;
      else if (kind === LINE) length += layer.planar ? planarLength(c, false) : lineLength(c);
      else {
        const closed = new Float64Array(c.length + 2);
        closed.set(c);
        closed.set(c.subarray(0, 2), c.length);
        perimeter += layer.planar ? planarLength(c, true) : lineLength(closed);
        // Rings are stored outer counterclockwise, holes clockwise: signed areas add up to the net area.
        const signed = planarArea(c);
        area += layer.planar ? signed : Math.sign(signed) * ringArea(c);
      }
    }
  }
  if (length) rows.push(['Length', unit(length)]);
  if (area) rows.push(['Area', layer.planar ? `${Math.abs(area).toLocaleString('en-US', { maximumFractionDigits: 2 })} units²` : formatArea(Math.abs(area))]);
  if (perimeter) rows.push(['Perimeter', unit(perimeter)]);
  if (points === 1 && first) rows.push(['Position', layer.planar ? `X ${first[0]} · Y ${first[1]}` : formatDegrees(first[0], first[1])]);
  else if (points > 1) rows.push(['Points', points.toLocaleString('en-US')]);
  return rows;
}

function trackRows(stats: TrackStats): [string, string][] {
  const rows: [string, string][] = [['Length', formatLength(stats.length)]];
  if (stats.duration !== undefined) rows.push(['Duration', formatDuration(stats.duration)]);
  if (stats.duration && stats.length) rows.push(['Average speed', `${((stats.length / stats.duration) * 3.6).toLocaleString('en-US', { maximumFractionDigits: 1 })} km/h`]);
  if (stats.start) rows.push(['Start', new Date(stats.start).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })]);
  if (stats.ascent !== undefined) rows.push(['Ascent / descent', `${Math.round(stats.ascent).toLocaleString('en-US')} m / ${Math.round(stats.descent ?? 0).toLocaleString('en-US')} m`]);
  if (stats.minElevation !== undefined) rows.push(['Elevation', `${Math.round(stats.minElevation).toLocaleString('en-US')}–${Math.round(stats.maxElevation ?? 0).toLocaleString('en-US')} m`]);
  return rows;
}

/** Totals of all tracks for the toolbar, e.g. "12.4 km · 2:31 h · ↑ 340 m ↓ 320 m · 32–180 m". */
function trackSummary(layers: MapLayer[]): string | null {
  const all = layers.flatMap((layer) => Object.values(layer.stats ?? {}));
  if (!all.length) return null;
  const sum = (pick: (s: TrackStats) => number | undefined) => all.reduce((total, s) => total + (pick(s) ?? 0), 0);
  const parts = [formatLength(sum((s) => s.length))];
  if (all.some((s) => s.duration !== undefined)) parts.push(formatDuration(sum((s) => s.duration)));
  if (all.some((s) => s.ascent !== undefined)) parts.push(`↑ ${Math.round(sum((s) => s.ascent))} m ↓ ${Math.round(sum((s) => s.descent))} m`);
  const lows = all.flatMap((s) => (s.minElevation === undefined ? [] : [s.minElevation]));
  const highs = all.flatMap((s) => (s.maxElevation === undefined ? [] : [s.maxElevation]));
  if (lows.length) parts.push(`${Math.round(Math.min(...lows))}–${Math.round(Math.max(...highs))} m`);
  return parts.join(' · ');
}

/**
 * Places a layer stored in its file's own coordinates (`raw`): in Web Mercator once the user names its coordinate
 * system, or back as it is with null.
 */
function place(layer: MapLayer, raw: Float64Array, system: CoordinateSystem | null): void {
  const project = system?.project ?? identity;
  const xy = new Float64Array(raw.length);
  const at = new Float64Array(2);
  for (let i = 0; i < raw.length; i += 2) {
    const ok = project(raw[i], raw[i + 1], at);
    xy[i] = ok ? at[0] : NaN;
    xy[i + 1] = ok ? at[1] : NaN;
  }
  const { featureGroups, groups, parts } = layer;
  const bbox = new Float64Array(layer.bbox.length).fill(NaN);
  for (let f = 0; f < layer.properties.length; f++) {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    for (let g = featureGroups[f]; g < featureGroups[f + 1]; g++) {
      for (let i = parts[groups[3 * g + 1]]; i < parts[groups[3 * g + 2]]; i++) {
        if (!Number.isFinite(xy[2 * i])) continue;
        b[0] = Math.min(b[0], xy[2 * i]);
        b[1] = Math.min(b[1], xy[2 * i + 1]);
        b[2] = Math.max(b[2], xy[2 * i]);
        b[3] = Math.max(b[3], xy[2 * i + 1]);
      }
    }
    if (b[0] <= b[2]) bbox.set(b, 4 * f);
  }
  Object.assign(layer, { xy, bbox, planar: !system, crs: system?.name });
}

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  const data = await readMap(file, progress);
  const notes = [...data.notes];
  // Layers without a known coordinate system cannot be placed next to others.
  if (data.layers.some((l) => l.planar) && data.layers.some((l) => !l.planar)) {
    for (const layer of data.layers.filter((l) => l.planar)) notes.push(`${layer.name} has no coordinate system (.prj file) and is left out.`);
    data.layers = data.layers.filter((l) => !l.planar);
  }
  const layers = data.layers;
  if (!layers.length) throw new Error(['The file contains no features that could be shown.', ...notes].join(' '));
  const featureTotal = layers.reduce((sum, l) => sum + l.properties.length, 0);
  if (data.shapesOnly) notes.unshift('Only the shapes: attributes (.dbf) and the coordinate system (.prj) are separate files. Open the shapefile as a ZIP with all its files to see them too.');
  const raw = new Map(layers.filter((l) => l.planar).map((l) => [l, l.xy]));

  container.classList.add('map-view');
  const view = new MapView(layers, layers.every((l) => l.planar), colors(container), data.icons, data.overlays);
  const body = h('div', { class: 'map-body' }, view.stage);
  const banners = h('div', { class: 'map-banners' }, ...notes.map((note) => h('div', { class: 'banner' }, note)));
  container.append(banners, body);

  // ---- Summary and coordinate system -------------------------------------------------------------------------------

  // GPS files show their track totals, everything else the number of features; the rest goes into the tooltip.
  const summary = trackSummary(layers);
  const meta = h('span', { class: summary ? 'meta map-track' : 'meta' }, `${data.kind} · ${summary ?? count(featureTotal, 'feature')}`);
  const updateCrsMeta = () => {
    const names = [...new Set(layers.map((l) => l.crs ?? (l.planar ? 'unknown' : 'WGS 84')))];
    meta.title = [
      `${count(layers.length, 'layer')}, ${count(featureTotal, 'feature')}`,
      `Coordinate system: ${names.join(', ')}`,
      summary ? 'Tracks: length, time from the first to the last point, ascent and descent, lowest and highest point' : '',
    ].filter(Boolean).join('\n');
  };
  updateCrsMeta();
  if (view.planar) {
    const crsSelect = h(
      'select',
      { 'aria-label': 'Coordinate system' },
      h('option', { value: '' }, 'Unknown (plain coordinates)'),
      ...PICKABLE.map((c) => h('option', { value: String(c.code) }, `${c.name} (EPSG:${c.code})`)),
    );
    crsSelect.addEventListener('change', () => {
      const system = crsSelect.value ? fromEpsg(Number(crsSelect.value)) : null;
      for (const [layer, xy] of raw) place(layer, xy, system);
      select(null);
      measure.setActive(false);
      view.setPlanar(!system);
      measureSettings.hidden = view.planar;
      updateCrsMeta();
    });
    banners.append(
      h(
        'div',
        { class: 'banner map-crs' },
        h('span', {}, 'The file does not say which coordinate system its coordinates are in, so they are shown as they are. Choose it to place the data on the map and measure in meters:'),
        crsSelect,
      ),
    );
  }

  // ---- Feature card -----------------------------------------------------------------------------------------------

  const card = h('div', { class: 'float map-info', hidden: true });
  function select(hit: Hit | null, zoom = false): void {
    view.selected = hit;
    view.render();
    if (!hit) {
      card.hidden = true;
      return;
    }
    const layer = layers[hit.layer];
    const properties = layer.properties[hit.feature];
    const title = featureName(properties) ?? `Feature ${(hit.feature + 1).toLocaleString('en-US')}`;
    const stats = layer.stats?.[hit.feature];
    const rows = stats ? trackRows(stats) : measures(layer, hit.feature);
    const entries = Object.entries(properties);
    card.replaceChildren(
      h(
        'div',
        { class: 'float-hd' },
        h('b', { class: 'mi-title', title }, title),
        h('span', { class: 'grow' }),
        h('button', { type: 'button', class: 'hb', title: 'Zoom to this feature', 'aria-label': 'Zoom to this feature', onclick: () => zoomTo(hit) }, icon('target', 14)),
        h('button', { type: 'button', class: 'hb', title: 'Close (Escape)', 'aria-label': 'Close', onclick: () => select(null) }, icon('close', 13, 2)),
      ),
      h(
        'div',
        { class: 'mi-body' },
        h('div', { class: 'mi-sub' }, `${layer.name} · ${(hit.feature + 1).toLocaleString('en-US')} of ${layer.properties.length.toLocaleString('en-US')}`),
        rows.length ? h('dl', { class: 'mi-measures' }, ...rows.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null,
        entries.length
          ? h('dl', { class: 'mi-attrs' }, ...entries.flatMap(([k, v]) => [h('dt', { title: k }, k), h('dd', { class: v === null || v === undefined || v === '' ? 'c3' : '' }, valueText(v) || '—')]))
          : h('p', { class: 'mi-none' }, 'No attributes.'),
      ),
    );
    card.hidden = false;
    if (zoom) zoomTo(hit);
  }
  function zoomTo(hit: Hit): void {
    const bounds = view.featureBounds(hit);
    if (!bounds) return;
    view.fit(bounds, view.planar ? 0 : 0.5);
  }
  view.onClick = (hit) => select(hit);

  // ---- Layers -----------------------------------------------------------------------------------------------------

  // The file's own color when the whole layer shares one style, else the default color of the layer.
  const swatchColor = (index: number) => {
    const { styles, styleOf } = layers[index];
    const style = styleOf.every((s) => s === styleOf[0]) ? styles[styleOf[0]] : undefined;
    return style?.stroke ?? style?.fill ?? style?.marker ?? `var(${PALETTE[index % PALETTE.length]})`;
  };
  const layerRows = layers.map((layer, index) => {
    const box = h('input', { type: 'checkbox', checked: view.visible[index], onchange: () => {
      view.visible[index] = box.checked;
      if (view.selected?.layer === index && !box.checked) select(null);
      view.render();
    } });
    return h(
      'div',
      { class: 'part map-layer' },
      h('label', { class: 'ml-name', title: layer.name }, box, h('span', { class: 'swatch', style: `background:${swatchColor(index)}` }), h('span', {}, layer.name)),
      h('span', { class: 'ml-count c3', title: `${count(layer.properties.length, 'feature')}` }, layer.properties.length.toLocaleString('en-US')),
      h('button', { type: 'button', class: 'hb', title: 'Attribute table', 'aria-label': `Attribute table of ${layer.name}`, onclick: () => openTable(index) }, icon('table', 14)),
    );
  });
  const layerPanel = h(
    'div',
    { class: 'float parts map-layers' },
    h('div', { class: 'float-hd' }, icon('layers', 14), h('b', {}, 'Layers'), h('span', { class: 'c3' }, String(layers.length)), h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'hb', title: 'Hide the layer list', 'aria-label': 'Hide the layer list', onclick: () => setLayersOpen(false) }, icon('close', 13, 2))),
    h('div', { class: 'parts-list' }, ...layerRows),
  );
  const layersButton: HTMLButtonElement = toolButton('Layers', 'Show or hide the layer list', () => setLayersOpen(layersButton.getAttribute('aria-pressed') !== 'true'));
  function setLayersOpen(open: boolean): void {
    layerPanel.hidden = !open;
    setPressed(layersButton, open);
  }
  // Phones start with the map alone.
  setLayersOpen(!window.matchMedia('(max-width: 639px)').matches);

  // ---- Attribute table --------------------------------------------------------------------------------------------

  const tableHost = h('div', { class: 'grid-host' });
  const tableTitle = h('select', { 'aria-label': 'Layer', onchange: () => openTable(Number(tableTitle.value)) }, ...layers.map((l, i) => h('option', { value: String(i) }, l.name)));
  const tableCount = h('span', { class: 'c3' });
  const table = h(
    'div',
    { class: 'map-table', hidden: true },
    h('div', { class: 'map-table-hd' }, icon('table', 14), layers.length > 1 ? tableTitle : h('b', {}, layers[0].name), tableCount, h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'hb', title: 'Close the table', 'aria-label': 'Close the table', onclick: () => setTableOpen(false) }, icon('close', 13, 2))),
    tableHost,
  );
  let grid: Grid | null = null;
  let tableLayer = -1;
  const tableButton: HTMLButtonElement = toolButton('Table', 'Attribute table of a layer', () => (table.hidden ? openTable(Math.max(0, tableLayer)) : setTableOpen(false)));
  function setTableOpen(open: boolean): void {
    table.hidden = !open;
    setPressed(tableButton, open);
  }
  function openTable(index: number): void {
    setTableOpen(true);
    if (index === tableLayer && grid) return;
    tableLayer = index;
    tableTitle.value = String(index);
    grid?.destroy();
    const layer = layers[index];
    const keys: string[] = [];
    const seen = new Set<string>();
    for (const p of layer.properties) {
      for (const key of Object.keys(p)) {
        if (seen.has(key) || keys.length >= MAX_COLUMNS) continue;
        seen.add(key);
        keys.push(key);
      }
    }
    const titles = ['#', ...keys];
    const rows: GridCell[][] = layer.properties.map((p, i) => [
      { text: String(i + 1), numeric: true },
      ...keys.map((key): GridCell => {
        const v = p[key];
        return typeof v === 'number' ? { text: String(v), numeric: true } : valueText(v);
      }),
    ]);
    const widths = titles.map((title, c) => {
      let longest = title.length;
      for (let r = 0; r < Math.min(rows.length, 200); r++) {
        const cell = rows[r][c];
        longest = Math.max(longest, Math.min(40, (typeof cell === 'string' ? cell : cell.text).length));
      }
      return c === 0 ? Math.max(48, 9 * String(rows.length).length + 16) : Math.min(280, Math.max(64, longest * 7.5 + 16));
    });
    const byLength = [...titles].sort((a, b) => b.length - a.length);
    grid = createGrid({ rows, columnCount: titles.length, columnTitles: titles, columnWidths: widths }, (address) => {
      // The address is the column title followed by the row number.
      for (const title of byLength) {
        const rest = address.slice(title.length);
        if (!address.startsWith(title) || !/^\d+$/.test(rest)) continue;
        const row = Number(rest) - 1;
        if (row < rows.length) {
          if (!view.visible[index]) {
            view.visible[index] = true;
            (layerRows[index].querySelector('input') as HTMLInputElement).checked = true;
          }
          select({ layer: index, feature: row }, true);
        }
        return;
      }
    });
    tableHost.replaceChildren(grid.element);
    tableCount.textContent = `${count(rows.length, 'feature')}${keys.length ? '' : ', no attributes'}`;
  }

  // ---- Scale bar and pointer position -------------------------------------------------------------------------------

  const scaleBar = h('div', { class: 'map-scale' });
  const scaleLabel = h('span', {});
  const coords = h('div', { class: 'map-coords' });
  const status = h('div', { class: 'map-status' }, h('div', { class: 'map-scale-wrap' }, scaleLabel, scaleBar), coords);
  function updateScale(): void {
    const perPixel = view.res * view.groundScale();
    const target = perPixel * 110;
    const power = 10 ** Math.floor(Math.log10(target));
    const nice = [5, 2, 1].map((m) => m * power).find((v) => v <= target) ?? power;
    scaleBar.style.width = `${Math.round(nice / perPixel)}px`;
    scaleLabel.textContent = view.planar
      ? nice.toLocaleString('en-US', { maximumFractionDigits: 6 })
      : nice >= 1000 ? `${(nice / 1000).toLocaleString('en-US', { maximumFractionDigits: 3 })} km` : `${nice.toLocaleString('en-US', { maximumFractionDigits: 3 })} m`;
  }
  view.onPointer = (x, y) => {
    if (view.planar) {
      coords.textContent = `X ${x.toLocaleString('en-US', { maximumFractionDigits: 2 })} · Y ${y.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    } else {
      const [lon, lat] = lonLat(x, y);
      coords.textContent = formatDegrees(lon, lat);
    }
  };

  // ---- Measuring --------------------------------------------------------------------------------------------------

  // Geographic data is measured in a local azimuthal equidistant projection around the view center on the WGS84
  // ellipsoid: distances from the center are exact, others off by about (d / 6371 km)² / 6, i.e. 0.0004 % at 10 km
  // from the center. The center follows the view; points already picked are moved into the new projection with it.
  const aeqd = (lon: number, lat: number) => proj4('WGS84', `+proj=aeqd +lat_0=${lat} +lon_0=${lon} +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs`);
  let local = aeqd(...lonLat(view.cx, view.cy));
  const picked: Point2[] = [];
  const positions = new WeakMap<Point2, [number, number]>();
  const at = new Float64Array(2);
  const geoPoint = (lon: number, lat: number): Point2 => {
    const [x, y] = local.forward([lon, lat]);
    const p = { x, y };
    positions.set(p, [lon, lat]);
    picked.push(p);
    if (picked.length > 16) picked.shift();
    return p;
  };
  const recenter = () => {
    if (view.planar) return;
    local = aeqd(...lonLat(view.cx, view.cy));
    for (const p of picked) [p.x, p.y] = local.forward(positions.get(p)!);
  };
  const unitSelect = h('select', { 'aria-label': 'Unit' }, h('option', { value: 'm' }, 'm'), h('option', { value: 'km' }, 'km'));
  const measureSettings = h('label', { class: 'mc-scale', hidden: view.planar }, h('span', {}, 'Unit'), unitSelect);
  const screenPoint = (clientX: number, clientY: number) => {
    const rect = view.stage.getBoundingClientRect();
    return view.toWorld(clientX - rect.left, clientY - rect.top);
  };
  const measure = new Measure2D({
    surface: view.stage,
    overlay: view.stage,
    toWorld: (clientX, clientY) => {
      const [x, y] = screenPoint(clientX, clientY);
      return view.planar ? { x, y } : geoPoint(...lonLat(x, y));
    },
    toScreen: (p) => {
      let x = p.x;
      let y = p.y;
      if (!view.planar) {
        const [lon, lat] = positions.get(p) ?? local.inverse([p.x, p.y]);
        mercator(lon, lat, at);
        [x, y] = at;
      }
      const [sx, sy] = view.toScreen(x, y);
      return { x: sx, y: sy };
    },
    unitsPerPixel: () => view.res * view.groundScale(),
    snap: (p, tolerance) => {
      const pixels = tolerance / (view.res * view.groundScale());
      let x = p.x;
      let y = p.y;
      if (!view.planar) {
        const [lon, lat] = positions.get(p)!;
        mercator(lon, lat, at);
        [x, y] = at;
      }
      const vertex = view.nearestVertex(x, y, pixels * view.res);
      if (!vertex) return null;
      return view.planar ? { x: vertex[0], y: vertex[1] } : geoPoint(...lonLat(vertex[0], vertex[1]));
    },
    convert: (length) => (view.planar || unitSelect.value === 'm' ? length : length / 1000),
    unit: () => (view.planar ? '' : unitSelect.value),
    settings: measureSettings,
    describe: (p) => {
      const position = positions.get(p);
      return position ? formatDegrees(position[0], position[1]) : `X ${p.x.toLocaleString('en-US', { maximumFractionDigits: 2 })} · Y ${p.y.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
    },
  });
  measure.button.title = 'Measure distances on the ground; snaps to the points of features (Escape ends)';
  // Runs after Measure2D's own click handler has switched measuring on or off.
  measure.button.addEventListener('click', () => {
    if (measure.button.getAttribute('aria-pressed') !== 'true') return;
    select(null);
    // Kilometers once the view spans more than a few of them.
    unitSelect.value = view.size.width * view.res * view.groundScale() > 5000 ? 'km' : 'm';
  });

  view.onChange(() => {
    recenter();
    measure.update();
    updateScale();
  });

  body.append(layerPanel, card, h('div', { class: 'cards' }, measure.card), status);
  container.append(table);

  // ---- Toolbar ----------------------------------------------------------------------------------------------------

  toolbar.append(
    meta,
    toolButton('−', 'Zoom out', () => view.zoomAt(1 / 1.5)),
    toolButton('+', 'Zoom in', () => view.zoomAt(1.5)),
    toolButton('Fit', 'Show all data', () => view.fitAll()),
    layersButton,
    tableButton,
    measure.button,
  );

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && !card.hidden && !view.stage.classList.contains('measuring')) select(null);
  };
  window.addEventListener('keydown', onKey);
  const offTheme = onThemeChange(() => view.setColors(colors(container)));

  return {
    destroy: () => {
      offTheme();
      window.removeEventListener('keydown', onKey);
      measure.dispose();
      grid?.destroy();
      view.destroy();
      for (const url of data.urls) URL.revokeObjectURL(url);
    },
  };
}
