// SPDX-License-Identifier: GPL-3.0-or-later
// Laser scans in LAS and LAZ, read in a worker (LAZ via laz-perf, Apache-2.0, WebAssembly). Points colored by RGB,
// elevation, intensity, ASPRS classification or return, with a legend; each class is a part that can be hidden.
// Very large clouds are thinned to every Nth point. Measuring snaps to points and shows real coordinates.
import * as THREE from 'three';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import type { ViewerContext } from '../core/types';
import type { LasClass, LasRequest, LasResponse, LasResult } from '../workers/las.worker';
import { mountScene, type SceneView } from './three/scene';

type Result = Extract<LasResponse, { ok: true }>;
type Mode = 'rgb' | 'elevation' | 'intensity' | 'classification' | 'return';

/**
 * Points the browser is asked to hold: about 15 bytes each on the graphics card and 20 in memory. Tested on desktop
 * machines with 12 million; phones and devices with little memory get fewer.
 */
function pointBudget(): number {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
  const phone = window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 700;
  const budget = memory >= 8 ? 12_000_000 : memory >= 4 ? 6_000_000 : 3_000_000;
  return phone ? Math.min(budget, 3_000_000) : budget;
}

function readInWorker(file: File, progress: ViewerContext['progress']): Promise<Result> {
  const worker = new Worker(new URL('../workers/las.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Result>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<LasResponse>) => {
      const data = event.data;
      if (data.ok === 'progress') {
        progress(data.message, data.fraction);
        return;
      }
      worker.terminate();
      if (data.ok) resolve(data);
      else reject(new Error(data.error));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'The point cloud reader could not be loaded.'));
    };
    worker.postMessage({ file, budget: pointBudget() } satisfies LasRequest);
  });
}

// ---- Colors ------------------------------------------------------------------------------------------------------

/** ASPRS standard classes (LAS 1.4 R15); 8 and 12 had other meanings before LAS 1.4. */
const CLASS_NAMES: Record<number, string> = {
  0: 'Never classified', 1: 'Unclassified', 2: 'Ground', 3: 'Low vegetation', 4: 'Medium vegetation', 5: 'High vegetation',
  6: 'Building', 7: 'Low point (noise)', 8: 'Model key point', 9: 'Water', 10: 'Rail', 11: 'Road surface', 12: 'Overlap',
  13: 'Wire guard (shield)', 14: 'Wire conductor', 15: 'Transmission tower', 16: 'Wire connector (insulator)', 17: 'Bridge deck',
  18: 'High noise', 19: 'Overhead structure', 20: 'Ignored ground', 21: 'Snow', 22: 'Temporal exclusion',
};
const CLASS_COLORS: Record<number, number> = {
  0: 0x6b7480, 1: 0x9aa3ad, 2: 0xa0703c, 3: 0x9ccc65, 4: 0x4caf50, 5: 0x1e7b3c, 6: 0xe8763a, 7: 0xd63ad6, 8: 0xf2c94c,
  9: 0x2f7fd6, 10: 0x7a5c3e, 11: 0x5f6670, 12: 0xe9d36a, 13: 0xf2e14c, 14: 0xffc400, 15: 0xb0466e, 16: 0x9b59b6,
  17: 0x8e7cc3, 18: 0xff3da5, 19: 0xc08a5b, 20: 0xc9b18a, 21: 0x9fd3ef, 22: 0x7f8c8d,
};

function className(code: number, version: string): string {
  if (code === 8 && version >= '1.4') return 'Reserved (8)';
  if (code === 12 && version >= '1.4') return 'Reserved (12)';
  return CLASS_NAMES[code] ?? (code >= 64 ? `User class ${code}` : `Reserved (${code})`);
}

function classColor(code: number): number {
  if (code in CLASS_COLORS) return CLASS_COLORS[code];
  // Other classes: hues spread by the golden angle.
  return new THREE.Color().setHSL(((code * 137.508) % 360) / 360, 0.6, 0.55, THREE.SRGBColorSpace).getHex(THREE.SRGBColorSpace);
}

/** Elevation: blue over green and yellow to red (after "Turbo", without its near-black ends). */
const ELEVATION_STOPS = [0x3b4cc0, 0x2f8fe0, 0x1fc8c8, 0x4bdc6a, 0xb8e23a, 0xf6c33a, 0xf2802a, 0xd6431c];
/** Intensity: dark to light gray. */
const INTENSITY_STOPS = [0x23272e, 0x7d8692, 0xf2f3f5];

function ramp(stops: number[]): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = (i / 255) * (stops.length - 1);
    const a = Math.min(stops.length - 2, Math.floor(t));
    const f = t - a;
    for (let c = 0; c < 3; c++) {
      const shift = 16 - c * 8;
      lut[i * 3 + c] = Math.round(((stops[a] >> shift) & 255) * (1 - f) + ((stops[a + 1] >> shift) & 255) * f);
    }
  }
  return lut;
}

const css = (hex: number) => `#${hex.toString(16).padStart(6, '0')}`;
const gradient = (stops: number[]) => `linear-gradient(to right, ${stops.map(css).join(', ')})`;

/** Values at two percentiles of a histogram, so that a few outliers do not flatten the colors. */
function percentiles(histogram: Uint32Array, total: number, low: number, high: number): [number, number] {
  let sum = 0;
  let lo = 0;
  let hi = histogram.length - 1;
  let foundLow = false;
  for (let i = 0; i < histogram.length; i++) {
    sum += histogram[i];
    if (!foundLow && sum >= total * low) {
      lo = i;
      foundLow = true;
    }
    if (sum >= total * high) {
      hi = i;
      break;
    }
  }
  return [lo, Math.max(hi, lo + 1)];
}

const RETURN_KINDS: [string, number][] = [['Single return', 0x7d8692], ['First of many', 0x2f7fd6], ['Intermediate', 0xf29a38], ['Last of many', 0x3e9a48]];

/** 0 single, 1 first of many, 2 intermediate, 3 last of many. */
function returnKind(value: number): number {
  const number = value & 15;
  const of = value >> 4;
  if (of <= 1 || number === 0) return 0;
  if (number === 1) return 1;
  return number >= of ? 3 : 2;
}

// ---- Points ------------------------------------------------------------------------------------------------------

/** Point colors are sRGB bytes; the shader turns them into the linear colors three.js works with. */
class SrgbPointsMaterial extends THREE.PointsMaterial {
  override onBeforeCompile(shader: THREE.WebGLProgramParametersWithUniforms): void {
    shader.vertexShader = `vec3 srgbToLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }\n${shader.vertexShader.replace(
      '#include <color_vertex>',
      '#include <color_vertex>\n#ifdef USE_COLOR\n\tvColor.rgb = srgbToLinear(vColor.rgb);\n#endif',
    )}`;
  }

  override customProgramCacheKey(): string {
    return 'srgb-points';
  }
}

/** Distance from the pointer, in pixels, within which a point can be picked. */
const PICK_PX = 6;

/**
 * Picking for millions of points: only the cells whose bounding spheres come near the pointer ray are searched. Of the
 * points within a few pixels of the pointer, the front ones count, and of those the one closest to the pointer.
 */
function cellRaycast(points: THREE.Points, cls: LasClass, viewportHeight: () => number): THREE.Points['raycast'] {
  const inverse = new THREE.Matrix4();
  const ray = new THREE.Ray();
  return (raycaster, intersects) => {
    const camera = raycaster.camera;
    if (!(camera instanceof THREE.PerspectiveCamera)) return;
    const position = (points.geometry.getAttribute('position') as THREE.BufferAttribute).array as Float32Array;
    inverse.copy(points.matrixWorld).invert();
    ray.copy(raycaster.ray).applyMatrix4(inverse);
    const { x: ox, y: oy, z: oz } = ray.origin;
    const { x: dx, y: dy, z: dz } = ray.direction;
    // World size of one pixel per unit of depth.
    const perPixel = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2)) / Math.max(1, viewportHeight());
    const slope = perPixel * PICK_PX;
    const near = camera.near;
    const hits: number[] = [];
    let front = Infinity;
    const spheres = cls.cellSphere;
    for (let c = 0; c < cls.cellStart.length; c++) {
      const vx = spheres[c * 4] - ox;
      const vy = spheres[c * 4 + 1] - oy;
      const vz = spheres[c * 4 + 2] - oz;
      const r = spheres[c * 4 + 3];
      const t = vx * dx + vy * dy + vz * dz;
      if (t + r < near || t - r > front * 1.02 + r) continue;
      const off = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - t * t));
      if (off - r > slope * (t + r)) continue;
      const end = cls.cellStart[c] + cls.cellCount[c];
      for (let i = cls.cellStart[c]; i < end; i++) {
        const px = position[i * 3] - ox;
        const py = position[i * 3 + 1] - oy;
        const pz = position[i * 3 + 2] - oz;
        const depth = px * dx + py * dy + pz * dz;
        if (depth < near) continue;
        const limit = slope * depth;
        const off2 = px * px + py * py + pz * pz - depth * depth;
        if (off2 > limit * limit) continue;
        if (depth < front) front = depth;
        hits.push(i, depth, Math.sqrt(Math.max(0, off2)) / (perPixel * depth));
      }
    }
    if (!hits.length) return;
    // The front layer: points up to a few pixels' depth behind the first one.
    const layer = front + front * perPixel * PICK_PX * 4 + front * 0.002;
    let best = -1;
    for (let k = 0; k < hits.length; k += 3) {
      if (hits[k + 1] <= layer && (best < 0 || hits[k + 2] < hits[best + 2])) best = k;
    }
    const index = hits[best];
    const point = new THREE.Vector3().fromArray(position, index * 3).applyMatrix4(points.matrixWorld);
    intersects.push({ distance: raycaster.ray.origin.distanceTo(point), distanceToRay: hits[best + 2] * perPixel * hits[best + 1], point, index, object: points });
  };
}

const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n.toLocaleString('en-US')}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

const count = (n: number) => n.toLocaleString('en-US');

// ---- Viewer ------------------------------------------------------------------------------------------------------

export async function mount(ctx: ViewerContext) {
  ctx.progress('Reading points …');
  const result: LasResult = await readInWorker(ctx.file, ctx.progress);
  ctx.progress('Building view …');
  const { header, kept } = result;

  const colors = new Uint8Array(kept * 3);
  const classes = [...result.classes];
  let view: SceneView | null = null;
  const viewportHeight = () => view?.canvas.clientHeight || 800;
  const pointSize = kept > 3_000_000 ? 1 : 2;

  // One part per class, positioned at the cloud's center (the origin of the stored positions).
  const cloud = new THREE.Group();
  cloud.position.set(...result.origin);
  const parts = classes.map((cls) => {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(result.positions.subarray(cls.start * 3, (cls.start + cls.count) * 3), 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors.subarray(cls.start * 3, (cls.start + cls.count) * 3), 3, true));
    const points = new THREE.Points(geometry, new SrgbPointsMaterial({ size: pointSize, sizeAttenuation: false, vertexColors: true }));
    points.name = classes.length > 1 || cls.code > 1 ? className(cls.code, header.version) : '';
    points.raycast = cellRaycast(points, cls, viewportHeight);
    cloud.add(points);
    return points;
  });
  // The scene turns this group to the chosen up axis; the cloud inside keeps its real coordinates.
  const root = new THREE.Group().add(cloud);

  // ---- Color modes -------------------------------------------------------------------------------------------------
  const zOf = (i: number) => result.positions[i * 3 + 2];
  const modes: [Mode, string][] = [];
  if (result.rgb) modes.push(['rgb', 'RGB']);
  modes.push(['elevation', 'Elevation']);
  if (result.intensity) modes.push(['intensity', 'Intensity']);
  if (classes.length > 1 || classes[0].code > 1) modes.push(['classification', 'Classification']);
  let returnCounts: number[] | null = null;
  {
    const kinds = [0, 0, 0, 0];
    for (let i = 0; i < kept; i++) kinds[returnKind(result.returns[i])]++;
    if (kinds[0] < kept) {
      returnCounts = kinds;
      modes.push(['return', 'Return']);
    }
  }

  // Robust ranges for the ramps.
  const elevationRange = (() => {
    const bins = new Uint32Array(1024);
    const lo = result.min[2];
    const span = result.max[2] - lo || 1;
    for (let i = 0; i < kept; i++) bins[Math.min(1023, Math.floor(((zOf(i) - lo) / span) * 1024))]++;
    const [a, b] = percentiles(bins, kept, 0.005, 0.995);
    return [lo + (a / 1024) * span, lo + ((b + 1) / 1024) * span];
  })();
  // Intensities are often bunched at the dark end: they are spread evenly over the grays (histogram equalization).
  const intensity = (() => {
    if (!result.intensity) return { range: [0, 1], level: new Uint8Array(1) };
    const bins = new Uint32Array(65536);
    for (let i = 0; i < kept; i++) bins[result.intensity[i]]++;
    const level = new Uint8Array(65536);
    for (let v = 0, sum = 0; v < 65536; v++) {
      level[v] = Math.min(255, Math.floor(((sum + bins[v] / 2) / kept) * 256));
      sum += bins[v];
    }
    return { range: percentiles(bins, kept, 0.02, 0.98), level };
  })();

  const elevationLut = ramp(ELEVATION_STOPS);
  const intensityLut = ramp(INTENSITY_STOPS);
  const fillRamp = (lut: Uint8Array, value: (i: number) => number, lo: number, hi: number) => {
    const scale = 255 / (hi - lo || 1);
    for (let i = 0; i < kept; i++) {
      const k = Math.max(0, Math.min(255, Math.round((value(i) - lo) * scale))) * 3;
      colors[i * 3] = lut[k];
      colors[i * 3 + 1] = lut[k + 1];
      colors[i * 3 + 2] = lut[k + 2];
    }
  };

  function paint(mode: Mode): void {
    if (mode === 'rgb') colors.set(result.rgb!);
    else if (mode === 'elevation') fillRamp(elevationLut, zOf, elevationRange[0], elevationRange[1]);
    else if (mode === 'intensity') fillRamp(intensityLut, (i) => intensity.level[result.intensity![i]], 0, 255);
    else if (mode === 'classification') {
      for (const cls of classes) {
        const hex = classColor(cls.code);
        for (let i = cls.start; i < cls.start + cls.count; i++) {
          colors[i * 3] = hex >> 16;
          colors[i * 3 + 1] = (hex >> 8) & 255;
          colors[i * 3 + 2] = hex & 255;
        }
      }
    } else {
      for (let i = 0; i < kept; i++) {
        const hex = RETURN_KINDS[returnKind(result.returns[i])][1];
        colors[i * 3] = hex >> 16;
        colors[i * 3 + 1] = (hex >> 8) & 255;
        colors[i * 3 + 2] = hex & 255;
      }
    }
    for (const p of parts) p.geometry.getAttribute('color').needsUpdate = true;
    renderLegend(mode);
    view?.requestRender();
  }

  // ---- Legend --------------------------------------------------------------------------------------------------------
  const unit = header.unit ? ` ${header.unit}` : '';
  const legendBody = h('div', { class: 'pc-legend-body' });
  const legendTitle = h('b', {});
  let collapsed = window.matchMedia('(max-width: 639px)').matches;
  const collapse = h('button', { type: 'button', class: 'hb', onclick: () => {
    collapsed = !collapsed;
    renderLegend(modeSelect.value as Mode);
  } });
  const legend = h('div', { class: 'float pc-legend' }, h('div', { class: 'float-hd' }, legendTitle, h('span', { class: 'grow' }), collapse), legendBody);
  const swatch = (hex: number) => h('i', { class: 'pc-sw', style: `background:${css(hex)}` });
  const row = (hex: number, name: string, n: number) => h('div', { class: 'pc-row' }, swatch(hex), h('span', { class: 'pc-name' }, name), h('span', { class: 'pc-n' }, count(n)));
  const rampRows = (stops: number[], lo: string, hi: string) => [
    h('div', { class: 'pc-ramp', style: `background:${gradient(stops)}` }),
    h('div', { class: 'pc-ends' }, h('span', {}, lo), h('span', {}, hi)),
  ];
  const coordinate = (v: number) => `${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}${unit}`;

  function renderLegend(mode: Mode): void {
    legend.hidden = mode === 'rgb';
    const title = modes.find(([m]) => m === mode)?.[1] ?? '';
    legendTitle.textContent = title;
    collapse.replaceChildren(icon(collapsed ? 'chevUp' : 'chevDown', 13, 2));
    collapse.title = collapsed ? 'Show the legend' : 'Hide the legend';
    collapse.setAttribute('aria-label', collapse.title);
    legend.classList.toggle('collapsed', collapsed);
    if (collapsed) {
      legendBody.replaceChildren();
      return;
    }
    if (mode === 'classification') legendBody.replaceChildren(...classes.map((c) => row(classColor(c.code), className(c.code, header.version), c.count)));
    else if (mode === 'return') legendBody.replaceChildren(...RETURN_KINDS.map(([name, hex], i) => row(hex, name, returnCounts![i])).filter((_, i) => returnCounts![i] > 0));
    else if (mode === 'elevation') legendBody.replaceChildren(...rampRows(ELEVATION_STOPS, coordinate(elevationRange[0] + result.origin[2]), coordinate(elevationRange[1] + result.origin[2])));
    else if (mode === 'intensity') legendBody.replaceChildren(...rampRows(INTENSITY_STOPS, count(intensity.range[0]), count(intensity.range[1])));
  }

  // ---- Toolbar -------------------------------------------------------------------------------------------------------
  const { toolbar } = ctx;
  const modeSelect = h('select', { title: 'Color the points by', 'aria-label': 'Color the points by', onchange: () => paint(modeSelect.value as Mode) },
    ...modes.map(([value, label]) => h('option', { value }, label)));
  modeSelect.value = modes[0][0];
  const sizeSelect = h('select', { title: 'Point size on screen', 'aria-label': 'Point size', onchange: () => {
    for (const p of parts) (p.material as THREE.PointsMaterial).size = Number(sizeSelect.value);
    view?.requestRender();
  } }, ...[1, 2, 3, 4, 6].map((px) => h('option', { value: String(px) }, `${px} px`)));
  sizeSelect.value = String(pointSize);

  const total = count(header.count);
  const about = [
    `LAS ${header.version}${header.compressed ? ', compressed (LAZ)' : ''}, point format ${header.pointFormat}`,
    header.software && `written by ${header.software}`,
    header.crs ? `coordinate system ${header.crs}` : 'no coordinate system in the file',
    header.geographic ? 'longitude and latitude shown as meters east and north of the center' : header.unit ? `unit ${header.unit}${header.unitFromFile ? '' : ' (assumed)'}` : 'unit unknown',
  ].filter(Boolean).join('; ');
  toolbar.append(
    result.step > 1
      ? h('span', { class: 'meta', title: `The cloud is thinned evenly so that the browser can show it. ${about}` }, `Showing every ${ordinal(result.step)} point (${count(kept)} of ${total})`)
      : h('span', { class: 'meta', title: about }, `${total} points · LAS ${header.version}`),
    modeSelect,
    sizeSelect,
  );

  paint(modes[0][0]);
  view = mountScene(ctx, root, { zUp: true, unit: header.unit, title: ctx.file.name });
  ctx.container.append(legend);
  renderLegend(modeSelect.value as Mode);
  return view;
}
