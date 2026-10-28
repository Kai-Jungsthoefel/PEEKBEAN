// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionOf, startsWith } from '../core/bytes';
import { h, toolButton } from '../core/dom';
import { RAW_EXTENSIONS, inspectRaw, previewBlob, thumbnailPixels } from './camera-raw';
import { Measure2D } from './measure2d';
import type { ViewerContext } from '../core/types';
import type { DecodeFormat, DecodeResponse } from '../workers/image-decode-types';

const MIN_SCALE = 0.02;
const MAX_SCALE = 64;

export interface Source {
  url: string;
  width: number;
  height: number;
  /** Pages of a multi-page TIFF or images in a HEIC container. */
  pages: number;
  /** Shown before the size in the toolbar ("Camera preview"), with an explanation as tooltip. */
  label?: string;
  title?: string;
  /** Camera raw: size of the sensor data. */
  sensor?: [number, number];
}

// JPEG XL in its container (a bare codestream starts with FF 0A).
const JXL_CONTAINER = [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a];

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
  if (startsWith(head, [0xff, 0x0a]) || startsWith(head, JXL_CONTAINER) || ext === 'jxl') return 'jxl';
  return null;
}

/** Camera raw files, by extension or by the signatures that only raw formats use (CR3, RAF, ORF, RW2, CRW, MRW, X3F). */
function isCameraRaw(file: File, head: Uint8Array): boolean {
  return (
    RAW_EXTENSIONS.includes(extensionOf(file.name)) ||
    (startsWith(head, 'ftyp', 4) && startsWith(head, 'crx ', 8)) ||
    ['FUJIFILMCCD-RAW', 'IIRO', 'IIRS', 'MMOR', 'IIU\0', '\0MRM', 'FOVb'].some((s) => startsWith(head, s)) ||
    startsWith(head, 'HEAPCCDR', 6)
  );
}

// A 1×1 JPEG XL image: Safari decodes the format itself, other browsers mostly do not.
const JXL_PROBE = 'data:image/jxl;base64,/woAELASCAgQACwASxiLFcJJQR4A9Ac=';
let nativeJxl: Promise<boolean> | null = null;
function browserDecodesJxl(): Promise<boolean> {
  nativeJxl ??= new Promise((resolve) => {
    const probe = new Image();
    probe.onload = () => resolve(probe.naturalWidth === 1);
    probe.onerror = () => resolve(false);
    probe.src = JXL_PROBE;
  });
  return nativeJxl;
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

export function decodedSource(file: File, format: DecodeFormat, page: number): Promise<Source> {
  const worker = new Worker(new URL('../workers/image-decode.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<DecodeResponse>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<DecodeResponse>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || 'The image decoder could not be loaded.'));
    void file.arrayBuffer().then((buffer) => worker.postMessage({ format, buffer, page }, [buffer]));
  })
    .finally(() => worker.terminate())
    .then(async (result) => {
      if (!result.ok) throw new Error(result.error);
      const { width, height, data, png, pages, note } = result;
      const source = png ? await blobSource(new Blob([data as Uint8ClampedArray<ArrayBuffer>], { type: 'image/png' })) : await pixelSource(width, height, data);
      if (!source) throw new Error('This browser cannot show the decoded image.');
      return { ...source, pages, label: note };
    });
}

/** A JPEG or PNG blob the browser decodes; null if it cannot. */
async function blobSource(blob: Blob): Promise<Source | null> {
  const url = URL.createObjectURL(blob);
  const probe = new Image();
  probe.src = url;
  try {
    await probe.decode();
    return { url, width: probe.naturalWidth, height: probe.naturalHeight, pages: 1 };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

/** Krita and OpenRaster files are ZIPs of layers that also hold the flattened picture (mergedimage.png). */
const LAYERED_EXTENSIONS = ['kra', 'krz', 'ora'];

async function layeredSource(file: File): Promise<Source> {
  const { BlobReader, Uint8ArrayWriter, ZipReader, configure } = await import('@zip.js/zip.js');
  configure({ useWebWorkers: false, useCompressionStream: true });
  const zip = new ZipReader(new BlobReader(file));
  try {
    const entries = await zip.getEntries();
    const app = extensionOf(file.name) === 'ora' ? 'The application' : 'Krita';
    // .krz files leave out the merged image; then only the small preview is left.
    for (const [name, label, title] of [
      ['mergedimage.png', '', `The flattened picture ${app} saved with the layers.`],
      ['preview.png', 'Preview', `${app} saved no flattened picture, only this small preview. The layers are not shown.`],
      ['Thumbnails/thumbnail.png', 'Preview', 'The file holds no flattened picture, only this small preview. The layers are not shown.'],
    ]) {
      const entry = entries.find((e) => e.filename === name && !e.directory);
      if (!entry || !('getData' in entry) || !entry.getData) continue;
      const source = await blobSource(new Blob([(await entry.getData(new Uint8ArrayWriter())) as Uint8Array<ArrayBuffer>], { type: 'image/png' }));
      if (source) return { ...source, label: label || undefined, title };
    }
    throw new Error('The file contains no flattened picture.');
  } finally {
    await zip.close();
  }
}

const PREVIEW_NOTE = 'The JPEG picture the camera stored in the raw file. The raw sensor data is not developed.';
const THUMBNAIL_NOTE = 'The only picture this raw file holds is a small thumbnail. The raw sensor data is not developed.';

/**
 * Camera raw: the largest JPEG preview the camera embedded, turned by the raw file's orientation. DNG files without a
 * usable one (often from phones) are developed in the worker; a few medium format raws only hold a small RGB thumbnail.
 */
async function rawSource(file: File, progress: (message: string) => void): Promise<Source> {
  const info = await inspectRaw(file);
  const sensor: [number, number] | undefined = info.rawWidth ? [info.rawWidth, info.rawHeight] : undefined;
  const best = info.previews[0];
  if (info.dng && (!best || Math.max(best.width, best.height) < Math.max(info.rawWidth, info.rawHeight) / 2)) {
    progress('Developing raw data …');
    try {
      const developed = await decodedSource(file, 'dng', 0);
      return { ...developed, sensor, title: 'The file has no full-size preview, so the raw sensor data was developed here, plainly: white balance and colors as recorded, no noise reduction or lens corrections.' };
    } catch (error) {
      if (!best) throw error;
    }
  }
  for (const preview of info.previews) {
    const source = await blobSource(previewBlob(file, preview, info.orientation));
    if (!source) continue;
    const long = Math.max(source.width, source.height);
    const tiny = long < 400 && long * 2 < Math.max(info.rawWidth, info.rawHeight);
    return { ...source, label: tiny ? 'Camera thumbnail' : 'Camera preview', title: tiny ? THUMBNAIL_NOTE : PREVIEW_NOTE, sensor };
  }
  if (info.thumbnail) {
    const { width, height } = info.thumbnail;
    return { ...(await pixelSource(width, height, await thumbnailPixels(file, info.thumbnail))), label: 'Camera thumbnail', title: THUMBNAIL_NOTE, sensor };
  }
  throw new Error('This raw file contains no preview image.');
}

/**
 * The picture of an image file as a blob URL, which the caller revokes. `format` is set when the worker decodes the
 * file, so that further pages can be decoded with decodedSource(). The converter uses this too.
 */
export async function openImage(file: File, progress: (message: string) => void): Promise<{ source: Source; format: DecodeFormat | null }> {
  const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const raw = isCameraRaw(file, head);
  const layered = !raw && LAYERED_EXTENSIONS.includes(extensionOf(file.name)) && startsWith(head, 'PK\x03\x04');
  const format = raw || layered ? null : decoderFormat(file, head);
  const special = raw || layered ? null : mainThreadFormat(file, head);
  // Safari shows TIFF, HEIC and JPEG XL natively; the other decoded formats no browser shows.
  const native = !raw && !layered && !special && (!format || format === 'tiff' || format === 'heic' || (format === 'jxl' && (await browserDecodesJxl())));
  let source = native ? await nativeSource(file) : null;
  if (layered) {
    progress('Reading the flattened picture …');
    source = await layeredSource(file);
  } else if (raw) {
    progress('Reading camera preview …');
    source = await rawSource(file, progress);
  } else if (!source && special) {
    progress('Decoding image …');
    source = special === 'ktx2' ? await ktx2Source(file) : await metafileSource(file);
  } else if (!source && format) {
    progress('Decoding image …');
    source = await decodedSource(file, format, 0);
  }
  if (!source) throw new Error('This browser does not support this image format, or the file is damaged.');
  return { source, format };
}

export async function mount({ file, container, toolbar, progress }: ViewerContext) {
  const opened = await openImage(file, progress);
  const { format } = opened;
  let source: Source | null = opened.source;

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
  const sensorLabel = h('span', { class: 'meta' });

  function setSource(next: Source): void {
    if (source && source !== next) URL.revokeObjectURL(source.url);
    source = next;
    ({ width, height } = next);
    img.src = next.url;
    img.style.width = `${width}px`;
    img.style.height = `${height}px`;
    sizeLabel.textContent = file.name.toLowerCase().endsWith('.svg') ? 'Vector graphic' : `${next.label ? `${next.label} · ` : ''}${width} × ${height} px`;
    sizeLabel.title = next.title ?? '';
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
  if (source.sensor) {
    sensorLabel.textContent = `Raw ${source.sensor[0]} × ${source.sensor[1]}`;
    sensorLabel.title = 'Size of the sensor data in the raw file';
    toolbar.append(sensorLabel);
  }
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
