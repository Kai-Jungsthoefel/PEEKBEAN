// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionOf, startsWith } from '../core/bytes';
import { h, toolButton } from '../core/dom';
import { Measure2D } from './measure2d';
import type { ViewerContext } from '../core/types';
import type { DecodeFormat, DecodeResponse } from '../workers/image-decode-types';

const MIN_SCALE = 0.02;
const MAX_SCALE = 64;

interface Source {
  url: string;
  width: number;
  height: number;
  /** Pages of a multi-page TIFF or images in a HEIC container. */
  pages: number;
}

/** Formats the browser may not decode itself; they are decoded in a worker instead. */
function decoderFormat(file: File, head: Uint8Array): DecodeFormat | null {
  const ext = extensionOf(file.name);
  if (startsWith(head, '8BPS') || ext === 'psd') return 'psd';
  if (startsWith(head, 'II*\0') || startsWith(head, 'MM\0*') || ext === 'tif' || ext === 'tiff') return 'tiff';
  const brand = startsWith(head, 'ftyp', 4) ? String.fromCharCode(...head.subarray(8, 12)) : '';
  if (['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'].includes(brand) || ext === 'heic' || ext === 'heif') return 'heic';
  if (startsWith(head, 'DDS ') || ext === 'dds') return 'dds';
  if (startsWith(head, [0x76, 0x2f, 0x31, 0x01]) || ext === 'exr') return 'exr';
  if (startsWith(head, '#?RADIANCE') || startsWith(head, '#?RGBE') || ext === 'hdr') return 'hdr';
  if (ext === 'tga' || ext === 'icb' || ext === 'vda' || ext === 'vst') return 'tga';
  return null;
}

const KTX2_SIGNATURE = [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb];

/** Formats decoded on the main thread: KTX2 brings its own transcoder workers, metafiles draw on a canvas. */
function mainThreadFormat(file: File, head: Uint8Array): 'ktx2' | 'metafile' | null {
  const ext = extensionOf(file.name);
  if (startsWith(head, KTX2_SIGNATURE) || ext === 'ktx2') return 'ktx2';
  // EMF starts with record type 1 and has " EMF" at byte 40; WMF either a placeable header or a plain one.
  if (['emf', 'wmf', 'emz', 'wmz'].includes(ext) || startsWith(head, [0xd7, 0xcd, 0xc6, 0x9a]) || (startsWith(head, [1, 0, 0, 0]) && startsWith(head, ' EMF', 40))) return 'metafile';
  return null;
}

async function pixelSource(width: number, height: number, data: Uint8ClampedArray): Promise<Source> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0);
  const blob = await new Promise<Blob | null>((done) => canvas.toBlob(done, 'image/png'));
  if (!blob) throw new Error('The image is too large for this browser.');
  return { url: URL.createObjectURL(blob), width, height, pages: 1 };
}

/** KTX2 (Basis Universal or raw pixels) via the three.js loader and the transcoder served next to the page. */
async function ktx2Source(file: File): Promise<Source> {
  const [THREE, { KTX2Loader }, { toneMap }] = await Promise.all([
    import('three'),
    import('three/addons/loaders/KTX2Loader.js'),
    import('../workers/tonemap'),
  ]);
  const loader = new KTX2Loader().setTranscoderPath(new URL('basis/', document.baseURI).href);
  // Without a GPU format to aim for, the transcoder hands out plain RGBA pixels.
  loader.detectSupport({ extensions: { has: () => false } } as unknown as InstanceType<typeof THREE.WebGLRenderer>);
  try {
    const buffer = await file.arrayBuffer();
    const texture = await new Promise<InstanceType<typeof THREE.Texture>>((resolve, reject) => loader.parse(buffer, resolve, reject));
    const level = ((texture as { mipmaps?: { data: ArrayBufferView; width: number; height: number }[] }).mipmaps?.[0] ?? texture.image) as {
      data: ArrayBufferView;
      width: number;
      height: number;
    };
    texture.dispose();
    const { width, height, data } = level;
    if (texture.format !== THREE.RGBAFormat) throw new Error('This KTX2 pixel format cannot be shown yet.');
    if (texture.type === THREE.HalfFloatType) return pixelSource(width, height, toneMap(Array.from(data as Uint16Array, THREE.DataUtils.fromHalfFloat), width, height, 4));
    if (texture.type === THREE.FloatType) return pixelSource(width, height, toneMap(data as Float32Array, width, height, 4));
    return pixelSource(width, height, new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength));
  } finally {
    loader.dispose();
  }
}

/** Windows metafiles (EMF, WMF and their gzip forms), drawn by the renderer of ooxml-pages. */
async function metafileSource(file: File): Promise<Source> {
  const { metafileToPng } = await import('ooxml-pages/metafile');
  const blob = await metafileToPng(new Uint8Array(await file.arrayBuffer()));
  if (!blob) throw new Error('The metafile could not be drawn; it may be damaged or use only EMF+ records.');
  const url = URL.createObjectURL(blob);
  const probe = new Image();
  probe.src = url;
  await probe.decode();
  return { url, width: probe.naturalWidth, height: probe.naturalHeight, pages: 1 };
}

async function nativeSource(file: File): Promise<Source | null> {
  const url = URL.createObjectURL(file);
  const probe = new Image();
  probe.src = url;
  try {
    // SVGs open through <img> run no scripts, so untrusted SVG files are safe to show.
    await probe.decode();
    // SVGs without intrinsic size report 0×0.
    return { url, width: probe.naturalWidth || 1024, height: probe.naturalHeight || 768, pages: 1 };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

function decodedSource(file: File, format: DecodeFormat, page: number): Promise<Source> {
  const worker = new Worker(new URL('../workers/image-decode.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<DecodeResponse>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<DecodeResponse>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || 'The image decoder could not be loaded.'));
    void file.arrayBuffer().then((buffer) => worker.postMessage({ format, buffer, page }, [buffer]));
  })
    .finally(() => worker.terminate())
    .then(async (result) => {
      if (!result.ok) throw new Error(result.error);
      return { ...(await pixelSource(result.width, result.height, result.data)), pages: result.pages };
    });
}

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const format = decoderFormat(file, head);
  const special = mainThreadFormat(file, head);
  // Safari shows TIFF and HEIC natively; the other decoded formats no browser shows.
  let source = special || (format && format !== 'tiff' && format !== 'heic') ? null : await nativeSource(file);
  if (!source && special) {
    progress('Decoding image …');
    source = special === 'ktx2' ? await ktx2Source(file) : await metafileSource(file);
  } else if (!source && format) {
    progress('Decoding image …');
    source = await decodedSource(file, format, 0);
  }
  if (!source) throw new Error('This browser does not support this image format, or the file is damaged.');

  const img = h('img', { class: 'image', alt: file.name, draggable: false });
  const stage = h('div', { class: 'image-viewer checkerboard' }, img);
  container.append(stage);

  let { width, height } = source;
  let scale = 1;
  let x = 0;
  let y = 0;
  let fitted = true;
  let measure: Measure2D | null = null;
  const zoomLabel = h('span', { class: 'meta zoom-label' });
  const sizeLabel = h('span', { class: 'meta' });

  function setSource(next: Source): void {
    if (source && source !== next) URL.revokeObjectURL(source.url);
    source = next;
    ({ width, height } = next);
    img.src = next.url;
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;
    sizeLabel.textContent = file.name.toLowerCase().endsWith('.svg') ? 'Vector graphic' : `${width} × ${height} px`;
  }

  function apply(): void {
    img.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    // Show individual pixels when zoomed in, like image editors do.
    img.classList.toggle('pixelated', scale >= 3);
    zoomLabel.textContent = `${Math.round(scale * 100)} %`;
    measure?.update();
  }

  function fit(): void {
    const { clientWidth: w, clientHeight: hgt } = stage;
    scale = Math.min(1, w / width, hgt / height);
    x = (w - width * scale) / 2;
    y = (hgt - height * scale) / 2;
    fitted = true;
    apply();
  }

  function zoomAt(factor: number, cx = stage.clientWidth / 2, cy = stage.clientHeight / 2): void {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    x = cx - ((cx - x) * next) / scale;
    y = cy - ((cy - y) * next) / scale;
    scale = next;
    fitted = false;
    apply();
  }

  const actualSize = () => zoomAt(1 / scale);

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const rect = stage.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    },
    { passive: false },
  );

  // One pointer pans; two touch points pinch-zoom around their middle.
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { id: number; startX: number; startY: number; x: number; y: number } | null = null;
  let pinch: { distance: number } | null = null;
  const pinchState = () => {
    const [p, q] = [...pointers.values()];
    const rect = stage.getBoundingClientRect();
    return { distance: Math.hypot(p.x - q.x, p.y - q.y), cx: (p.x + q.x) / 2 - rect.left, cy: (p.y + q.y) / 2 - rect.top };
  };
  stage.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    stage.setPointerCapture(e.pointerId);
    if (pointers.size === 2) {
      drag = null;
      pinch = { distance: pinchState().distance };
      return;
    }
    drag = { id: e.pointerId, startX: e.clientX, startY: e.clientY, x, y };
    stage.classList.add('dragging');
  });
  stage.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pointers.size === 2) {
      const now = pinchState();
      if (pinch.distance > 0) zoomAt(now.distance / pinch.distance, now.cx, now.cy);
      pinch.distance = now.distance;
      return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    x = drag.x + e.clientX - drag.startX;
    y = drag.y + e.clientY - drag.startY;
    fitted = false;
    apply();
  });
  const endDrag = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    drag = null;
    stage.classList.remove('dragging');
  };
  stage.addEventListener('pointerup', endDrag);
  stage.addEventListener('pointercancel', endDrag);
  stage.addEventListener('dblclick', () => (fitted ? actualSize() : fit()));

  const resizeObserver = new ResizeObserver(() => {
    if (fitted) fit();
  });
  resizeObserver.observe(stage);

  setSource(source);
  await img.decode().catch(() => {});

  toolbar.append(sizeLabel);
  if (format && source.pages > 1) {
    const pageSelect = h(
      'select',
      { title: 'Page', onchange: async () => {
        pageSelect.disabled = true;
        try {
          setSource(await decodedSource(file, format, Number(pageSelect.value)));
          fit();
        } finally {
          pageSelect.disabled = false;
        }
      } },
      ...Array.from({ length: source.pages }, (_, i) => h('option', { value: String(i) }, `Page ${i + 1} of ${source!.pages}`)),
    );
    toolbar.append(pageSelect);
  }
  toolbar.append(
    toolButton('−', 'Zoom out', () => zoomAt(1 / 1.25)),
    zoomLabel,
    toolButton('+', 'Zoom in', () => zoomAt(1.25)),
    toolButton('Fit', 'Fit to window', fit),
    toolButton('100 %', 'Actual size', actualSize),
  );

  // Measuring in image pixels (SVG: user units), optionally converted with a factor per pixel.
  const factorInput = h('input', { type: 'number', min: '0', step: 'any', value: '1', title: 'Length of one pixel or SVG unit in the chosen unit' });
  const unitSelect = h('select', { title: 'Unit' }, ...['px', 'mm', 'cm', 'm', 'in'].map((u) => h('option', { value: u }, u)));
  const factor = () => (unitSelect.value === 'px' ? 1 : Number(factorInput.value) > 0 ? Number(factorInput.value) : 1);
  measure = new Measure2D({
    surface: stage,
    overlay: stage,
    toWorld: (clientX, clientY) => {
      const rect = stage.getBoundingClientRect();
      return { x: (clientX - rect.left - x) / scale, y: (clientY - rect.top - y) / scale };
    },
    toScreen: (p) => ({ x: x + p.x * scale, y: y + p.y * scale }),
    unitsPerPixel: () => 1 / scale,
    convert: (length) => length * factor(),
    unit: () => unitSelect.value,
    settings: h('label', { class: 'mc-scale' }, h('span', {}, '1 px ='), factorInput, unitSelect),
    calibrate: {
      units: ['mm', 'cm', 'm', 'in'],
      apply: (length, value, unit) => {
        factorInput.value = String(Number((value / length).toPrecision(8)));
        unitSelect.value = unit;
      },
    },
    describe: (p) => `X ${p.x.toFixed(1)} · Y ${p.y.toFixed(1)} px`,
  });
  container.append(h('div', { class: 'cards' }, measure.card));
  toolbar.append(measure.button);
  fit();

  return {
    destroy: () => {
      measure?.dispose();
      resizeObserver.disconnect();
      if (source) URL.revokeObjectURL(source.url);
    },
  };
}
