// SPDX-License-Identifier: GPL-3.0-or-later
// 2D map on a canvas: pan, zoom and pinch, features drawn by kind (areas, then lines, then points) and batched per
// style, a faint graticule, labels for named points, and hit-testing for clicks.
import { EARTH_RADIUS, LINE, POINT, POLYGON, featureName, lonLat, mercator, type FeatureStyle, type MapLayer } from './model';

export interface MapColors {
  background: string;
  graticule: string;
  graticuleText: string;
  text: string;
  halo: string;
  selection: string;
  palette: string[];
}

export interface Hit {
  layer: number;
  feature: number;
}

/** A KML ground overlay: an image stretched over a longitude/latitude box. */
export interface Overlay {
  layer: number;
  feature: number;
  url: string;
}

const MIN_DRAG = 5;
const TAU = Math.PI * 2;
const E2 = 0.00669437999014;
const GRATICULE_STEPS = [0.0001, 0.0002, 0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 45];
const MAX_LABELS = 300;
/** Frames with more path segments than this take too long to draw for every step of a gesture. */
const HEAVY_SEGMENTS = 40000;
/** Pixels beyond the screen edge from which vertices count as outside (wider than any line). */
const OUTSIDE = 64;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class MapView {
  readonly stage: HTMLDivElement;
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private width = 0;
  private height = 0;
  private dpr = 1;
  /** View center in map coordinates and map units per CSS pixel. */
  cx = 0;
  cy = 0;
  res = 1;
  private minRes = 0;
  private maxRes = 1;
  readonly visible: boolean[];
  selected: Hit | null = null;
  graticule = true;
  /** The view shows everything and follows size changes until the user pans or zooms. */
  private fitted = true;
  private frame = 0;
  private readonly names: (string | undefined)[][];
  private bounds: Float64Array[] = [];
  private readonly images = new Map<string, HTMLImageElement | null>();
  private readonly tinted = new Map<string, HTMLCanvasElement>();
  /** Full redraws take longer than a frame; the last one is kept as a picture for gestures. */
  private heavy = false;
  /** Path segments and markers of the current frame. */
  private segments = 0;
  private snapshot: { canvas: HTMLCanvasElement; cx: number; cy: number; res: number; width: number; height: number } | null = null;
  /** The pending view change comes from the pointer, the wheel or a pinch. */
  private gesture = false;
  private settle = 0;
  /** Pixels that already have a speck (see drawKind), reused between frames. */
  private specks = new Uint8Array(0);
  private readonly listeners: (() => void)[] = [];
  private readonly resizeObserver: ResizeObserver;
  private font = '12px sans-serif';
  onClick: ((hit: Hit | null) => void) | null = null;
  onPointer: ((x: number, y: number) => void) | null = null;

  constructor(
    readonly layers: MapLayer[],
    public planar: boolean,
    private colors: MapColors,
    private readonly icons: Map<string, string>,
    private readonly overlays: Overlay[],
  ) {
    this.stage = document.createElement('div');
    this.stage.className = 'map-stage';
    this.canvas.className = 'map-canvas';
    this.stage.append(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.visible = layers.map((layer) => !layer.hidden);
    this.names = layers.map((layer) => layer.properties.map((p, i) => (layer.featureGroups[i + 1] > layer.featureGroups[i] ? featureName(p) : undefined)));
    this.measureData();
    this.installPointer();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.stage);
  }

  /** Bounds per layer and the zoom limits, from the current coordinates. */
  private measureData(): void {
    this.bounds = this.layers.map((layer) => {
      const b = new Float64Array([Infinity, Infinity, -Infinity, -Infinity]);
      for (let i = 0; i < layer.bbox.length; i += 4) {
        if (!(layer.bbox[i] <= layer.bbox[i + 2])) continue;
        b[0] = Math.min(b[0], layer.bbox[i]);
        b[1] = Math.min(b[1], layer.bbox[i + 1]);
        b[2] = Math.max(b[2], layer.bbox[i + 2]);
        b[3] = Math.max(b[3], layer.bbox[i + 3]);
      }
      return b;
    });
    const all = this.dataBounds(true);
    const extent = all ? Math.max(all[2] - all[0], all[3] - all[1]) : 0;
    if (this.planar) {
      this.maxRes = Math.max(extent, 1) / 20;
      this.minRes = Math.max(extent, 1) * 1e-7;
    } else {
      this.maxRes = (2 * Math.PI * EARTH_RADIUS) / 128;
      this.minRes = 0.002;
    }
  }

  /** The layers' coordinates changed between the file's own and Web Mercator; shows all of them again. */
  setPlanar(planar: boolean): void {
    this.planar = planar;
    this.measureData();
    this.fitAll();
  }

  setColors(colors: MapColors): void {
    this.colors = colors;
    this.tinted.clear();
    this.render();
  }

  onChange(listener: () => void): void {
    this.listeners.push(listener);
  }

  // ---- View -------------------------------------------------------------------------------------------------------

  private resize(): void {
    this.snapshot = null;
    const rect = this.stage.getBoundingClientRect();
    this.width = Math.max(1, rect.width);
    this.height = Math.max(1, rect.height);
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.font = `12px ${getComputedStyle(this.stage).fontFamily || 'sans-serif'}`;
    if (this.fitted) this.fit();
    else this.changed();
  }

  /** Bounds of the visible layers (or all), or null when they have no geometry. */
  dataBounds(all = false): [number, number, number, number] | null {
    const b = [Infinity, Infinity, -Infinity, -Infinity];
    this.bounds.forEach((lb, i) => {
      if (!all && !this.visible[i]) return;
      b[0] = Math.min(b[0], lb[0]);
      b[1] = Math.min(b[1], lb[1]);
      b[2] = Math.max(b[2], lb[2]);
      b[3] = Math.max(b[3], lb[3]);
    });
    return b[0] <= b[2] ? (b as [number, number, number, number]) : null;
  }

  featureBounds(hit: Hit): [number, number, number, number] | null {
    const b = this.layers[hit.layer].bbox.subarray(4 * hit.feature, 4 * hit.feature + 4);
    return b[0] <= b[2] ? [b[0], b[1], b[2], b[3]] : null;
  }

  /** Shows the given bounds (default: all visible data), never closer than `minRes`. */
  fit(bounds = this.dataBounds() ?? this.dataBounds(true), minRes = this.planar ? 0 : 0.25): void {
    if (!bounds) return;
    const pad = Math.min(40, this.width / 8, this.height / 8);
    const w = bounds[2] - bounds[0];
    const h = bounds[3] - bounds[1];
    this.res = clamp(Math.max(w / Math.max(1, this.width - 2 * pad), h / Math.max(1, this.height - 2 * pad), minRes, this.minRes), this.minRes, this.maxRes);
    this.cx = (bounds[0] + bounds[2]) / 2;
    this.cy = (bounds[1] + bounds[3]) / 2;
    this.changed();
  }

  fitAll(): void {
    this.fitted = true;
    this.fit();
  }

  zoomAt(factor: number, sx = this.width / 2, sy = this.height / 2): void {
    const [wx, wy] = this.toWorld(sx, sy);
    const next = clamp(this.res / factor, this.minRes, this.maxRes);
    this.cx = wx - (sx - this.width / 2) * next;
    this.cy = wy + (sy - this.height / 2) * next;
    this.res = next;
    this.fitted = false;
    this.changed();
  }

  toWorld(sx: number, sy: number): [number, number] {
    return [this.cx + (sx - this.width / 2) * this.res, this.cy - (sy - this.height / 2) * this.res];
  }

  toScreen(x: number, y: number): [number, number] {
    return [(x - this.cx) / this.res + this.width / 2, this.height / 2 - (y - this.cy) / this.res];
  }

  /** Meters on the ground per map unit at a map y (Web Mercator, east-west); 1 for planar data. */
  groundScale(y = this.cy): number {
    if (this.planar) return 1;
    const lat = lonLat(0, y)[1] * (Math.PI / 180);
    return Math.cos(lat) / Math.sqrt(1 - E2 * Math.sin(lat) ** 2);
  }

  get size(): { width: number; height: number } {
    return { width: this.width, height: this.height };
  }

  private changed(): void {
    this.render();
    for (const listener of this.listeners) listener();
  }

  /**
   * Draws the map in the next frame. While the user pans or zooms data that takes longer than a frame to draw, the
   * last full picture is moved and scaled instead, and the map is drawn in full once the gesture pauses.
   */
  render(): void {
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.settle);
    const quick = this.gesture && this.heavy && this.snapshot;
    this.gesture = false;
    if (quick) {
      this.frame = requestAnimationFrame(() => this.drawSnapshot());
      this.settle = window.setTimeout(() => this.render(), 180);
      return;
    }
    this.frame = requestAnimationFrame(() => {
      this.segments = 0;
      this.draw();
      // Canvases rasterize after the frame, so the time spent here says little; the amount of drawing does.
      this.heavy = this.segments > HEAVY_SEGMENTS;
      this.keepSnapshot();
    });
  }

  private keepSnapshot(): void {
    if (!this.heavy) {
      this.snapshot = null;
      return;
    }
    const canvas = this.snapshot?.canvas ?? document.createElement('canvas');
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    canvas.getContext('2d')!.drawImage(this.canvas, 0, 0);
    this.snapshot = { canvas, cx: this.cx, cy: this.cy, res: this.res, width: this.width, height: this.height };
  }

  private drawSnapshot(): void {
    const s = this.snapshot!;
    const { ctx } = this;
    const scale = s.res / this.res;
    const [x, y] = this.toScreen(s.cx - (s.width / 2) * s.res, s.cy + (s.height / 2) * s.res);
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.colors.background;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.drawImage(s.canvas, x, y, s.width * scale, s.height * scale);
  }

  // ---- Drawing ----------------------------------------------------------------------------------------------------

  private layerColor(index: number): string {
    return this.colors.palette[index % this.colors.palette.length];
  }

  private draw(): void {
    const { ctx, width: w, height: h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = this.colors.background;
    ctx.fillRect(0, 0, w, h);
    if (!this.planar && this.graticule) this.drawGraticule();
    this.drawOverlays();
    for (const kind of [POLYGON, LINE, POINT]) this.drawKind(kind);
    this.drawLabels();
    this.drawSelection();
  }

  /** Map bounds of the screen plus a margin, for culling. */
  private viewBounds(marginPx = 24): [number, number, number, number] {
    const [x0, y1] = this.toWorld(-marginPx, -marginPx);
    const [x1, y0] = this.toWorld(this.width + marginPx, this.height + marginPx);
    return [x0, y0, x1, y1];
  }

  private drawGraticule(): void {
    const { ctx } = this;
    const [x0, y0, x1, y1] = this.viewBounds(0);
    const [lon0, lat0] = lonLat(x0, y0);
    const [lon1, lat1] = lonLat(x1, y1);
    const degreesPerPixel = (lon1 - lon0) / this.width;
    const step = GRATICULE_STEPS.find((s) => s / degreesPerPixel >= 110) ?? 90;
    const digits = Math.max(0, Math.ceil(-Math.log10(step) - 1e-9));
    const label = (v: number, pos: string, neg: string) => `${Math.abs(v).toFixed(digits)}° ${v < 0 ? neg : pos}`;
    const at = new Float64Array(2);
    ctx.save();
    ctx.strokeStyle = this.colors.graticule;
    ctx.fillStyle = this.colors.graticuleText;
    ctx.lineWidth = 1;
    ctx.font = this.font.replace('12px', '10.5px');
    ctx.beginPath();
    const meridians: [number, number][] = [];
    for (let lon = Math.ceil(Math.max(-180, lon0) / step) * step; lon <= Math.min(180, lon1); lon += step) {
      mercator(lon, 0, at);
      const sx = Math.round(this.toScreen(at[0], 0)[0]) + 0.5;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, this.height);
      meridians.push([sx, lon]);
    }
    const parallels: [number, number][] = [];
    for (let lat = Math.ceil(Math.max(-85, lat0) / step) * step; lat <= Math.min(85, lat1); lat += step) {
      mercator(0, lat, at);
      const sy = Math.round(this.toScreen(0, at[1])[1]) + 0.5;
      ctx.moveTo(0, sy);
      ctx.lineTo(this.width, sy);
      parallels.push([sy, lat]);
    }
    ctx.stroke();
    // Labels along the bottom and right edges, where the floating panels leave room.
    ctx.textBaseline = 'bottom';
    for (const [sx, lon] of meridians) ctx.fillText(label(lon, 'E', 'W'), sx + 4, this.height - 4);
    ctx.textAlign = 'right';
    for (const [sy, lat] of parallels) ctx.fillText(label(lat, 'N', 'S'), this.width - 4, sy - 2);
    ctx.restore();
  }

  private drawOverlays(): void {
    for (const overlay of this.overlays) {
      if (!this.visible[overlay.layer]) continue;
      const image = this.image(overlay.url);
      const b = this.featureBounds(overlay);
      if (!image || !b) continue;
      const [sx0, sy0] = this.toScreen(b[0], b[3]);
      const [sx1, sy1] = this.toScreen(b[2], b[1]);
      this.ctx.drawImage(image, sx0, sy0, sx1 - sx0, sy1 - sy0);
    }
  }

  /**
   * Adds the parts of one group to a path. Vertices less than a pixel apart are left out, and so are runs of vertices
   * that all lie beyond the same edge of the screen: the shortcut between the first and last of such a run stays
   * beyond that edge too, so what is visible does not change, fills included.
   */
  private appendGroup(path: Path2D, layer: MapLayer, group: number, radius: number): void {
    const { groups, parts, xy } = layer;
    const kind = groups[3 * group];
    const k = 1 / this.res;
    const ox = this.width / 2 - this.cx * k;
    const oy = this.height / 2 + this.cy * k;
    const x0 = -OUTSIDE;
    const y0 = -OUTSIDE;
    const x1 = this.width + OUTSIDE;
    const y1 = this.height + OUTSIDE;
    const side = (sx: number, sy: number) => (sx < x0 ? 1 : sx > x1 ? 2 : 0) | (sy < y0 ? 4 : sy > y1 ? 8 : 0);
    for (let p = groups[3 * group + 1]; p < groups[3 * group + 2]; p++) {
      const start = parts[p];
      const end = parts[p + 1];
      if (kind === POINT) {
        for (let i = start; i < end; i++) {
          const sx = xy[2 * i] * k + ox;
          const sy = oy - xy[2 * i + 1] * k;
          if (sx < -radius || sy < -radius || sx > this.width + radius || sy > this.height + radius) continue;
          path.moveTo(sx + radius, sy);
          path.arc(sx, sy, radius, 0, TAU);
          this.segments += 8;
        }
        continue;
      }
      const fx = xy[2 * start] * k + ox;
      const fy = oy - xy[2 * start + 1] * k;
      let lx = fx;
      let ly = fy;
      /** Sides of the screen that every vertex of the current run lies beyond. */
      let run = side(fx, fy);
      let pending = false;
      let px = 0;
      let py = 0;
      let emitted = 1;
      path.moveTo(fx, fy);
      for (let i = start + 1; i < end; i++) {
        const sx = xy[2 * i] * k + ox;
        const sy = oy - xy[2 * i + 1] * k;
        const s = side(sx, sy);
        if (run & s && i < end - 1) {
          run &= s;
          pending = true;
          px = sx;
          py = sy;
          continue;
        }
        if (pending) {
          path.lineTo(px, py);
          lx = px;
          ly = py;
          pending = false;
          emitted++;
        }
        run = s;
        if (i < end - 1 && Math.abs(sx - lx) < 0.7 && Math.abs(sy - ly) < 0.7) continue;
        path.lineTo(sx, sy);
        lx = sx;
        ly = sy;
        emitted++;
      }
      // An explicit line back instead of closePath(), which gets slow on paths with many points in Chromium.
      if (kind === POLYGON) path.lineTo(fx, fy);
      this.segments += emitted;
    }
  }

  private markerRadius(style: FeatureStyle): number {
    return clamp(5 * (style.iconScale ?? 1), 3, 12);
  }

  private drawKind(kind: number): void {
    const [vx0, vy0, vx1, vy1] = this.viewBounds();
    const k = 1 / this.res;
    const width = Math.ceil(this.width);
    this.layers.forEach((layer, li) => {
      if (!this.visible[li] || !(layer.kinds & (1 << kind))) return;
      const { bbox, featureGroups, groups, styleOf, styles } = layer;
      const paths = new Map<number, Path2D>();
      let specks: Uint8Array | null = null;
      const count = layer.properties.length;
      for (let f = 0; f < count; f++) {
        const b = 4 * f;
        // Features without geometry have NaN bounds and fail these tests.
        if (!(bbox[b] <= vx1 && bbox[b + 2] >= vx0 && bbox[b + 1] <= vy1 && bbox[b + 3] >= vy0)) continue;
        const s = styleOf[f];
        const icon = kind === POINT ? this.icon(styles[s]) : null;
        // Lines and areas smaller than a pixel become a dot, one per pixel: at small scales most of a road network
        // is such specks, and drawing each of them costs far more than it shows.
        const speck = kind !== POINT && (bbox[b + 2] - bbox[b]) * k < 1 && (bbox[b + 3] - bbox[b + 1]) * k < 1;
        for (let g = featureGroups[f]; g < featureGroups[f + 1]; g++) {
          if (groups[3 * g] !== kind) continue;
          if (icon) {
            this.drawIcons(layer, g, styles[s], icon);
            continue;
          }
          let path = paths.get(s);
          if (!path) paths.set(s, (path = new Path2D()));
          if (speck) {
            const [sx, sy] = this.toScreen(bbox[b], bbox[b + 1]);
            const cell = Math.floor(sy) * width + Math.floor(sx);
            if (!specks) {
              if (this.specks.length < width * Math.ceil(this.height)) this.specks = new Uint8Array(width * Math.ceil(this.height));
              specks = this.specks.fill(0);
            }
            if (sx >= 0 && sy >= 0 && sx < width && sy < this.height && !specks[cell]) {
              specks[cell] = 1;
              path.moveTo(sx, sy);
              path.lineTo(sx + 1, sy);
              this.segments++;
            }
            break;
          }
          this.appendGroup(path, layer, g, this.markerRadius(styles[s]));
        }
      }
      for (const [s, path] of paths) this.paint(kind, styles[s], this.layerColor(li), path);
    });
  }

  private paint(kind: number, style: FeatureStyle, color: string, path: Path2D): void {
    const { ctx } = this;
    if (kind === POLYGON) {
      ctx.fillStyle = style.fill ?? color;
      ctx.globalAlpha = clamp(style.fillOpacity ?? (style.fill ? 0.45 : 0.22), 0, 1);
      if (ctx.globalAlpha > 0) ctx.fill(path, 'nonzero');
      ctx.strokeStyle = style.stroke ?? style.fill ?? color;
      ctx.globalAlpha = clamp(style.strokeOpacity ?? 1, 0, 1);
      this.lineWidth(clamp(style.strokeWidth ?? 1.25, 0.5, 12));
      if (ctx.globalAlpha > 0) ctx.stroke(path);
    } else if (kind === LINE) {
      ctx.strokeStyle = style.stroke ?? color;
      ctx.globalAlpha = clamp(style.strokeOpacity ?? 1, 0, 1);
      this.lineWidth(clamp(style.strokeWidth ?? 2, 0.5, 16));
      if (ctx.globalAlpha > 0) ctx.stroke(path);
    } else {
      ctx.globalAlpha = 1;
      ctx.fillStyle = style.marker ?? style.stroke ?? color;
      ctx.fill(path);
      ctx.strokeStyle = this.colors.halo;
      this.lineWidth(1.5);
      ctx.stroke(path);
    }
    ctx.globalAlpha = 1;
  }

  /** Round joins and caps cost a lot of drawing time and only show on wide lines. */
  private lineWidth(width: number): void {
    const round = width >= 3;
    this.ctx.lineWidth = width;
    this.ctx.lineJoin = round ? 'round' : 'miter';
    this.ctx.lineCap = round ? 'round' : 'butt';
  }

  // ---- Icons ------------------------------------------------------------------------------------------------------

  private image(url: string): HTMLImageElement | null {
    if (this.images.has(url)) return this.images.get(url)!;
    this.images.set(url, null);
    const image = new Image();
    image.src = url;
    image.decode().then(
      () => {
        this.images.set(url, image);
        this.render();
      },
      () => {},
    );
    return null;
  }

  /** The icon image of a style, tinted with the icon color as KML does, once it has loaded. */
  private icon(style: FeatureStyle): CanvasImageSource | null {
    const url = style.icon ? this.icons.get(style.icon) : undefined;
    const image = url ? this.image(url) : null;
    if (!image || !style.marker || /^#?f{3}(?:f{3})?$/i.test(style.marker)) return image;
    const key = `${url}|${style.marker}`;
    let canvas = this.tinted.get(key);
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth || 32;
      canvas.height = image.naturalHeight || 32;
      const c = canvas.getContext('2d')!;
      c.drawImage(image, 0, 0);
      c.globalCompositeOperation = 'multiply';
      c.fillStyle = style.marker;
      c.fillRect(0, 0, canvas.width, canvas.height);
      c.globalCompositeOperation = 'destination-in';
      c.drawImage(image, 0, 0);
      this.tinted.set(key, canvas);
    }
    return canvas;
  }

  /** Where an icon goes relative to its point: offset of the top left corner and size, in pixels. */
  private iconBox(style: FeatureStyle, icon: CanvasImageSource): { x: number; y: number; w: number; h: number } {
    const source = icon as HTMLImageElement | HTMLCanvasElement;
    const iw = (source as HTMLImageElement).naturalWidth || source.width || 32;
    const ih = (source as HTMLImageElement).naturalHeight || source.height || 32;
    const scale = clamp(28 * (style.iconScale ?? 1), 8, 96) / Math.max(iw, ih);
    const w = iw * scale;
    const h = ih * scale;
    // KML hot spots count from the lower left corner, in pixels of the image or as fractions.
    const [ax, ay, ux, uy] = style.iconAnchor ?? [0.5, 0.5, 'fraction', 'fraction'];
    const anchorX = ux === 'pixels' ? ax * scale : ux === 'insetPixels' ? w - ax * scale : ax * w;
    const anchorY = uy === 'pixels' ? h - ay * scale : uy === 'insetPixels' ? ay * scale : h - ay * h;
    return { x: -anchorX, y: -anchorY, w, h };
  }

  private drawIcons(layer: MapLayer, group: number, style: FeatureStyle, icon: CanvasImageSource): void {
    const { groups, parts, xy } = layer;
    const box = this.iconBox(style, icon);
    const reach = Math.max(box.w, box.h);
    for (let p = groups[3 * group + 1]; p < groups[3 * group + 2]; p++) {
      for (let i = parts[p]; i < parts[p + 1]; i++) {
        const [sx, sy] = this.toScreen(xy[2 * i], xy[2 * i + 1]);
        if (sx < -reach || sy < -reach || sx > this.width + reach || sy > this.height + reach) continue;
        this.ctx.drawImage(icon, sx + box.x, sy + box.y, box.w, box.h);
      }
    }
  }

  // ---- Labels and selection ---------------------------------------------------------------------------------------

  /** Names next to named points, as long as there are few enough on screen to read; overlapping ones are left out. */
  private drawLabels(): void {
    const labels: [number, number, string][] = [];
    this.layers.forEach((layer, li) => {
      if (!this.visible[li] || !(layer.kinds & (1 << POINT)) || labels.length > MAX_LABELS) return;
      const names = this.names[li];
      for (let f = 0; f < names.length && labels.length <= MAX_LABELS; f++) {
        const name = names[f];
        if (!name) continue;
        for (let g = layer.featureGroups[f]; g < layer.featureGroups[f + 1]; g++) {
          if (layer.groups[3 * g] !== POINT) continue;
          const i = layer.parts[layer.groups[3 * g + 1]];
          const [sx, sy] = this.toScreen(layer.xy[2 * i], layer.xy[2 * i + 1]);
          if (sx < 0 || sy < 0 || sx > this.width || sy > this.height) continue;
          // Next to the icon if there is one, else next to the marker.
          const style = layer.styles[layer.styleOf[f]];
          const icon = this.icon(style);
          const box = icon ? this.iconBox(style, icon) : null;
          const x = box ? sx + box.x + box.w + 2 : sx + this.markerRadius(style) + 6;
          const y = box ? sy + box.y + box.h / 2 : sy;
          labels.push([x, y, name.length > 40 ? `${name.slice(0, 39)}…` : name]);
          break;
        }
      }
    });
    if (!labels.length || labels.length > MAX_LABELS) return;
    const { ctx } = this;
    ctx.font = this.font;
    ctx.textBaseline = 'middle';
    this.lineWidth(3);
    ctx.strokeStyle = this.colors.halo;
    ctx.fillStyle = this.colors.text;
    const placed: [number, number, number, number][] = [];
    for (const [x, y, text] of labels) {
      const right = x + ctx.measureText(text).width;
      if (placed.some(([x0, y0, x1, y1]) => x < x1 && right > x0 && y - 7 < y1 && y + 7 > y0)) continue;
      placed.push([x, y - 7, right, y + 7]);
      ctx.strokeText(text, x, y);
      ctx.fillText(text, x, y);
    }
  }

  private drawSelection(): void {
    const hit = this.selected;
    if (!hit || !this.visible[hit.layer]) return;
    const layer = this.layers[hit.layer];
    const { ctx } = this;
    const color = this.colors.selection;
    for (let g = layer.featureGroups[hit.feature]; g < layer.featureGroups[hit.feature + 1]; g++) {
      const kind = layer.groups[3 * g];
      const path = new Path2D();
      this.appendGroup(path, layer, g, 9);
      if (kind === POLYGON) {
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = color;
        ctx.fill(path, 'nonzero');
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = this.colors.halo;
      this.lineWidth(6);
      ctx.stroke(path);
      ctx.strokeStyle = color;
      this.lineWidth(3);
      ctx.stroke(path);
    }
  }

  // ---- Hit-testing ------------------------------------------------------------------------------------------------

  /** The feature drawn at a screen position: points first, then lines, then areas; later layers win. */
  hit(sx: number, sy: number): Hit | null {
    const [wx, wy] = this.toWorld(sx, sy);
    for (const kind of [POINT, LINE, POLYGON]) {
      const tolerance = (kind === POINT ? 8 : kind === LINE ? 5 : 2) * this.res;
      for (let li = this.layers.length - 1; li >= 0; li--) {
        const layer = this.layers[li];
        if (!this.visible[li] || !(layer.kinds & (1 << kind))) continue;
        const { bbox, featureGroups, groups } = layer;
        for (let f = layer.properties.length - 1; f >= 0; f--) {
          const b = 4 * f;
          if (!(bbox[b] - tolerance <= wx && bbox[b + 2] + tolerance >= wx && bbox[b + 1] - tolerance <= wy && bbox[b + 3] + tolerance >= wy)) continue;
          for (let g = featureGroups[f]; g < featureGroups[f + 1]; g++) {
            if (groups[3 * g] === kind && this.hitGroup(layer, g, wx, wy, tolerance)) return { layer: li, feature: f };
          }
        }
      }
    }
    return null;
  }

  private hitGroup(layer: MapLayer, group: number, x: number, y: number, tolerance: number): boolean {
    const { groups, parts, xy } = layer;
    const kind = groups[3 * group];
    const t2 = tolerance * tolerance;
    let winding = 0;
    for (let p = groups[3 * group + 1]; p < groups[3 * group + 2]; p++) {
      const start = parts[p];
      const end = parts[p + 1];
      if (kind === POINT) {
        for (let i = start; i < end; i++) if ((xy[2 * i] - x) ** 2 + (xy[2 * i + 1] - y) ** 2 <= t2) return true;
        continue;
      }
      const last = kind === POLYGON ? end : end - 1;
      for (let i = start; i < last; i++) {
        const j = i + 1 < end ? i + 1 : start;
        const ax = xy[2 * i];
        const ay = xy[2 * i + 1];
        const bx = xy[2 * j];
        const by = xy[2 * j + 1];
        if (segmentDistance2(x, y, ax, ay, bx, by) <= t2) return true;
        if (kind === POLYGON) {
          if (ay <= y) {
            if (by > y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) > 0) winding++;
          } else if (by <= y && (bx - ax) * (y - ay) - (x - ax) * (by - ay) < 0) {
            winding--;
          }
        }
      }
    }
    return winding !== 0;
  }

  /** The vertex of a visible feature nearest to a map position, within a tolerance in map units. */
  nearestVertex(x: number, y: number, tolerance: number): [number, number] | null {
    let best: [number, number] | null = null;
    let bestDistance = tolerance * tolerance;
    this.layers.forEach((layer, li) => {
      if (!this.visible[li]) return;
      const { bbox, featureGroups, groups, parts, xy } = layer;
      for (let f = 0; f < layer.properties.length; f++) {
        const b = 4 * f;
        if (!(bbox[b] - tolerance <= x && bbox[b + 2] + tolerance >= x && bbox[b + 1] - tolerance <= y && bbox[b + 3] + tolerance >= y)) continue;
        for (let g = featureGroups[f]; g < featureGroups[f + 1]; g++) {
          for (let i = parts[groups[3 * g + 1]]; i < parts[groups[3 * g + 2]]; i++) {
            const d = (xy[2 * i] - x) ** 2 + (xy[2 * i + 1] - y) ** 2;
            if (d < bestDistance) {
              bestDistance = d;
              best = [xy[2 * i], xy[2 * i + 1]];
            }
          }
        }
      }
    });
    return best;
  }

  // ---- Pointer ----------------------------------------------------------------------------------------------------

  private installPointer(): void {
    const stage = this.stage;
    const local = (e: { clientX: number; clientY: number }) => {
      const rect = stage.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top] as const;
    };
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const [sx, sy] = local(e);
        const delta = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
        this.gesture = true;
        this.zoomAt(Math.exp(-delta * 0.0015), sx, sy);
      },
      { passive: false },
    );
    // One pointer pans; two touch points pinch-zoom around their middle. A short tap or click selects.
    const pointers = new Map<number, { x: number; y: number }>();
    let drag: { id: number; x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
    let pinch: { distance: number } | null = null;
    const pinchState = () => {
      const [p, q] = [...pointers.values()];
      const rect = stage.getBoundingClientRect();
      return { distance: Math.hypot(p.x - q.x, p.y - q.y), sx: (p.x + q.x) / 2 - rect.left, sy: (p.y + q.y) / 2 - rect.top };
    };
    stage.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      stage.setPointerCapture(e.pointerId);
      if (pointers.size === 2) {
        drag = null;
        pinch = { distance: pinchState().distance };
        return;
      }
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, cx: this.cx, cy: this.cy, moved: false };
    });
    stage.addEventListener('pointermove', (e) => {
      const [sx, sy] = local(e);
      this.onPointer?.(...this.toWorld(sx, sy));
      if (!pointers.has(e.pointerId)) {
        if (e.pointerType === 'mouse') stage.style.cursor = !stage.classList.contains('measuring') && this.hit(sx, sy) ? 'pointer' : '';
        return;
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (pinch && pointers.size === 2) {
        const now = pinchState();
        this.gesture = true;
        if (pinch.distance > 0) this.zoomAt(now.distance / pinch.distance, now.sx, now.sy);
        pinch.distance = now.distance;
        return;
      }
      if (!drag || drag.id !== e.pointerId) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < MIN_DRAG) return;
      drag.moved = true;
      stage.classList.add('dragging');
      this.cx = drag.cx - (e.clientX - drag.x) * this.res;
      this.cy = drag.cy + (e.clientY - drag.y) * this.res;
      this.fitted = false;
      this.gesture = true;
      this.changed();
    });
    const end = (e: PointerEvent) => {
      if (!pointers.has(e.pointerId)) return;
      const wasClick = e.type === 'pointerup' && drag?.id === e.pointerId && !drag.moved && pointers.size === 1;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) pinch = null;
      drag = null;
      stage.classList.remove('dragging');
      if (wasClick && !stage.classList.contains('measuring')) {
        const [sx, sy] = local(e);
        this.onClick?.(this.hit(sx, sy));
      }
    };
    stage.addEventListener('pointerup', end);
    stage.addEventListener('pointercancel', end);
    stage.addEventListener('dblclick', (e) => {
      if (stage.classList.contains('measuring')) return;
      const [sx, sy] = local(e);
      this.zoomAt(2, sx, sy);
    });
  }

  destroy(): void {
    cancelAnimationFrame(this.frame);
    window.clearTimeout(this.settle);
    this.resizeObserver.disconnect();
  }
}

function segmentDistance2(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const length2 = dx * dx + dy * dy;
  const t = length2 ? clamp(((px - ax) * dx + (py - ay) * dy) / length2, 0, 1) : 0;
  return (ax + t * dx - px) ** 2 + (ay + t * dy - py) ** 2;
}
