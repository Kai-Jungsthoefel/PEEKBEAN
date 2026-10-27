// SPDX-License-Identifier: GPL-3.0-or-later
// Opens map files: ZIP archives (shapefiles, KMZ), KML, GPX and TCX via togeojson (BSD-2-Clause) on the main thread,
// as they need the browser's XML parser; shapefiles, GeoJSON and TopoJSON in a worker. Nothing a file links to on
// the internet is loaded: icons and overlay images only from inside a KMZ or ZIP, network links never.
import { BlobReader, Uint8ArrayWriter, ZipReader, configure, type FileEntry as ZipEntry } from '@zip.js/zip.js';
import { gpx, kmlWithFolders, tcx, type F, type Folder } from '@tmcw/togeojson';
import type { Feature, Position } from 'geojson';
import { extensionOf, startsWith } from '../../core/bytes';
import type { MapResponse } from '../../workers/map.worker';
import { trackStats, type TrackStats } from './geodesy';
import { LayerBuilder, geographic, styleOf, type MapLayer } from './model';
import type { JsonSource, ShapefileSource, VectorRequest, VectorResult } from './vector';
import type { Overlay } from './view';

configure({ useWebWorkers: false, useCompressionStream: true });

export interface MapData {
  layers: MapLayer[];
  /** What was left out or assumed, shown above the map. */
  notes: string[];
  /** Image references of the file (KML icons and overlays) → blob: or data: URL. */
  icons: Map<string, string>;
  overlays: Overlay[];
  /** Formats read, e.g. "Shapefile" or "KML". */
  kind: string;
  /** Only the .shp of a shapefile was opened, without .dbf and .prj. */
  shapesOnly: boolean;
  /** Object URLs to revoke when the viewer closes. */
  urls: string[];
}

/** Properties togeojson derives from styles and GPX internals: they style the map instead of showing as attributes. */
const STYLE_PROPERTIES = [
  'styleUrl', 'styleHash', 'styleMapHash', 'stroke', 'stroke-opacity', 'stroke-width', 'fill', 'fill-opacity', 'icon',
  'icon-color', 'icon-opacity', 'icon-scale', 'icon-heading', 'icon-offset', 'icon-offset-units', 'label-color',
  'label-opacity', 'label-scale', '@geometry-type', 'coordinateProperties', '_gpxType', 'visibility',
];

const IMAGE_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };

/** Plain text of an HTML description; the parsed document is inert, nothing in it runs or loads. */
function htmlText(html: string): string {
  const doc = new DOMParser().parseFromString(html.replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>/gi, '$&\n'), 'text/html');
  return (doc.body?.textContent ?? '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function attributes(properties: Record<string, unknown> | null): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (STYLE_PROPERTIES.includes(key)) continue;
    if (value && typeof value === 'object' && (value as { '@type'?: string })['@type'] === 'html') {
      out[key] = htmlText(String((value as { value?: unknown }).value ?? ''));
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** XML text in the encoding its declaration names (KML and GPX are nearly always UTF-8). */
function decodeXml(bytes: Uint8Array): string {
  if (startsWith(bytes, [0xff, 0xfe])) return new TextDecoder('utf-16le').decode(bytes);
  if (startsWith(bytes, [0xfe, 0xff])) return new TextDecoder('utf-16be').decode(bytes);
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 256));
  const declared = /^(?:\xef\xbb\xbf)?\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1];
  try {
    return new TextDecoder(declared ?? 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

function parseXml(text: string, name: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error(`${name} is not well-formed XML.`);
  return doc;
}

const isUrl = (href: string) => /^[a-z][\w+.-]*:/i.test(href);

/** Path inside the archive for a reference relative to the KML file, or null for anything outside it. */
function resolvePath(href: string, dir: string): string | null {
  if (isUrl(href) || href.startsWith('/')) return null;
  let path = href.split(/[?#]/)[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep it as written.
  }
  const out: string[] = [];
  for (const part of `${dir}${path}`.replace(/\\/g, '/').split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return out.join('/').toLowerCase();
}

interface XmlSource {
  name: string;
  bytes: Uint8Array;
  /** Folder of the file inside the archive, with trailing slash, to resolve its references. */
  dir: string;
}

interface Collected {
  shapefiles: ShapefileSource[];
  json: JsonSource[];
  xml: XmlSource[];
  /** Files in the archive by lower-case path, for icons. */
  files: Map<string, ZipEntry>;
  kinds: Set<string>;
  notes: string[];
  shapesOnly: boolean;
}

const baseName = (path: string) => path.replace(/^.*\//, '').replace(/\.[^.]*$/, '');
const bytesOf = (entry: ZipEntry) => entry.getData(new Uint8ArrayWriter());
const textOf = async (entry: ZipEntry) => new TextDecoder().decode(await bytesOf(entry));

async function collectZip(file: File, kmz: boolean, out: Collected): Promise<ZipReader<unknown>> {
  const reader = new ZipReader(new BlobReader(file));
  const entries = (await reader.getEntries()).filter((e): e is ZipEntry => !e.directory && !/(^|\/)(__MACOSX\/|\._)/.test(e.filename));
  for (const entry of entries) out.files.set(entry.filename.replace(/\\/g, '/').toLowerCase(), entry);
  const companion = (base: string, ext: string) => out.files.get(`${base}.${ext}`.toLowerCase());
  const skipped: string[] = [];
  const safely = async (entry: ZipEntry, read: () => Promise<void>) => {
    try {
      await read();
    } catch {
      skipped.push(entry.filename);
    }
  };

  for (const entry of entries) {
    const path = entry.filename.replace(/\\/g, '/');
    const ext = extensionOf(path);
    if (ext === 'shp') {
      const base = path.slice(0, -4);
      await safely(entry, async () => {
        const [shp, dbf, prj, cpg] = [entry, companion(base, 'dbf'), companion(base, 'prj'), companion(base, 'cpg')];
        out.shapefiles.push({
          name: baseName(path),
          shp: (await bytesOf(shp)).buffer as ArrayBuffer,
          dbf: dbf ? ((await bytesOf(dbf)).buffer as ArrayBuffer) : undefined,
          prj: prj ? await textOf(prj) : undefined,
          cpg: cpg ? await textOf(cpg) : undefined,
        });
        if (!dbf) out.notes.push(`${baseName(path)}: no .dbf file in the archive, so the shapes have no attributes.`);
        out.kinds.add('Shapefile');
      });
    } else if (['geojson', 'topojson', 'json'].includes(ext) && !kmz) {
      await safely(entry, async () => {
        out.json.push({ name: baseName(path), data: (await bytesOf(entry)).buffer as ArrayBuffer });
        out.kinds.add(ext === 'topojson' ? 'TopoJSON' : 'GeoJSON');
      });
    } else if (['gpx', 'tcx'].includes(ext) && !kmz) {
      await safely(entry, async () => {
        out.xml.push({ name: baseName(path), bytes: await bytesOf(entry), dir: '' });
      });
    }
  }
  // A KMZ holds one main KML (doc.kml by convention); other KML files in it are only reached through links.
  const kmls = entries.filter((e) => extensionOf(e.filename) === 'kml');
  const main = kmz ? [kmls.find((e) => /^doc\.kml$/i.test(e.filename)) ?? kmls.find((e) => !e.filename.includes('/')) ?? kmls[0]].filter(Boolean) : kmls;
  for (const entry of main as ZipEntry[]) {
    await safely(entry, async () => {
      const path = entry.filename.replace(/\\/g, '/');
      out.xml.push({ name: baseName(path), bytes: await bytesOf(entry), dir: path.slice(0, path.lastIndexOf('/') + 1) });
    });
  }
  if (skipped.length) out.notes.push(`Could not be extracted (encrypted or damaged): ${skipped.join(', ')}.`);
  return reader;
}

function readInWorker(request: VectorRequest): Promise<VectorResult> {
  const worker = new Worker(new URL('../../workers/map.worker.ts', import.meta.url), { type: 'module' });
  const transfer = [...request.shapefiles.flatMap((s) => (s.dbf ? [s.shp, s.dbf] : [s.shp])), ...request.json.map((j) => j.data)];
  return new Promise<MapResponse>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<MapResponse>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || 'The map reader could not be loaded.'));
    worker.postMessage(request, transfer);
  })
    .finally(() => worker.terminate())
    .then((result) => {
      if (!result.ok) throw new Error(result.error);
      return result;
    });
}

interface XmlResult {
  layers: MapLayer[];
  /** Overlays with layer indexes relative to `layers`. */
  overlays: { layer: number; feature: number; href: string }[];
  hrefs: Set<string>;
  networkLinks: number;
}

/** Segments of a line feature, for track statistics. */
function segments(feature: Feature): Position[][] {
  const g = feature.geometry;
  if (g?.type === 'LineString') return [g.coordinates];
  if (g?.type === 'MultiLineString') return g.coordinates;
  return [];
}

function layerOf(name: string, features: F[], result: XmlResult, options: { hidden?: boolean; tracks?: boolean } = {}): void {
  const builder = new LayerBuilder(geographic);
  const stats: Record<number, TrackStats> = {};
  const layerIndex = result.layers.length;
  for (const feature of features) {
    const properties = (feature.properties ?? {}) as Record<string, unknown>;
    const type = properties['@geometry-type'];
    if (type === 'networklink') {
      result.networkLinks++;
      continue;
    }
    const style = styleOf(properties);
    if (style?.icon) result.hrefs.add(style.icon);
    if (type === 'groundoverlay' && typeof properties.icon === 'string') {
      result.overlays.push({ layer: layerIndex, feature: builder.count, href: properties.icon });
      result.hrefs.add(properties.icon);
    }
    if (options.tracks && (feature.geometry?.type === 'LineString' || feature.geometry?.type === 'MultiLineString')) {
      stats[builder.count] = trackStats(segments(feature as Feature), (properties.coordinateProperties as { times?: unknown } | undefined)?.times);
    }
    // A ground overlay shows its image; its box gets a thin outline only.
    builder.add(feature.geometry, attributes(properties), type === 'groundoverlay' ? { ...style, stroke: '#8c939b', fillOpacity: 0, strokeWidth: 1 } : style);
  }
  if (!builder.count) return;
  const layer = builder.build(name, false);
  if (options.hidden) layer.hidden = true;
  if (Object.keys(stats).length) layer.stats = stats;
  result.layers.push(layer);
}

function readKml(doc: Document, fallbackName: string, result: XmlResult): void {
  const tree = kmlWithFolders(doc);
  const documentName = doc.getElementsByTagName('Document')[0]?.getElementsByTagName('name')[0]?.textContent?.trim();
  const visit = (children: (Folder | F)[], path: string[], hidden: boolean) => {
    const own = children.filter((c): c is F => c.type === 'Feature');
    if (own.length) layerOf(path.join(' / ') || documentName || fallbackName, own, result, { hidden });
    for (const child of children) {
      if (child.type !== 'folder') continue;
      const name = typeof child.meta.name === 'string' && child.meta.name.trim() ? child.meta.name.trim() : 'Folder';
      visit(child.children, [...path, name], hidden || child.meta.visibility === '0');
    }
  };
  visit(tree.children, [], false);
}

/** GPX and TCX: tracks, routes and waypoints as three layers. */
function readGps(doc: Document, format: 'gpx' | 'tcx', prefix: string, result: XmlResult): void {
  const features = (format === 'gpx' ? gpx(doc) : tcx(doc)).features as F[];
  const kind = (f: F) => (f.geometry?.type === 'Point' ? 'wpt' : (f.properties as { _gpxType?: string })?._gpxType === 'rte' ? 'rte' : 'trk');
  const named = (name: string) => (prefix ? `${prefix} – ${name}` : name);
  layerOf(named('Tracks'), features.filter((f) => kind(f) === 'trk'), result, { tracks: true });
  layerOf(named('Routes'), features.filter((f) => kind(f) === 'rte'), result, { tracks: true });
  layerOf(named('Waypoints'), features.filter((f) => kind(f) === 'wpt'), result);
}

/** First non-blank byte, after a UTF-8 byte order mark. */
function firstByte(head: Uint8Array): number {
  let i = startsWith(head, [0xef, 0xbb, 0xbf]) ? 3 : 0;
  while (i < head.length && (head[i] === 0x20 || head[i] === 0x09 || head[i] === 0x0a || head[i] === 0x0d)) i++;
  return head[i] ?? 0;
}

export async function readMap(file: File, progress: (message: string) => void): Promise<MapData> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  const ext = extensionOf(file.name);
  const out: Collected = { shapefiles: [], json: [], xml: [], files: new Map(), kinds: new Set(), notes: [], shapesOnly: false };
  let zip: ZipReader<unknown> | null = null;
  const data: MapData = { layers: [], notes: out.notes, icons: new Map(), overlays: [], kind: '', shapesOnly: false, urls: [] };

  try {
    if (startsWith(head, 'PK\x03\x04') || startsWith(head, 'PK\x05\x06')) {
      progress('Unpacking …');
      zip = await collectZip(file, ext === 'kmz' || ext === 'kml', out);
      if (ext === 'kmz') out.kinds.add('KMZ');
      if (!out.shapefiles.length && !out.json.length && !out.xml.length) {
        throw new Error('The archive contains no map data: no shapefile (.shp), KML, GPX or GeoJSON file.');
      }
    } else if (ext === 'shp' || (head.length >= 4 && new DataView(head.buffer).getInt32(0) === 9994)) {
      out.shapefiles.push({ name: baseName(file.name), shp: await file.arrayBuffer() });
      out.kinds.add('Shapefile');
      data.shapesOnly = true;
    } else if (firstByte(head) === 0x3c) {
      out.xml.push({ name: baseName(file.name), bytes: new Uint8Array(await file.arrayBuffer()), dir: '' });
    } else if (firstByte(head) === 0x7b) {
      out.json.push({ name: baseName(file.name), data: await file.arrayBuffer() });
      out.kinds.add(ext === 'topojson' ? 'TopoJSON' : 'GeoJSON');
    } else {
      throw new Error('This file is not map data: not a shapefile, KML, KMZ, GPX or GeoJSON.');
    }

    const xml: XmlResult = { layers: [], overlays: [], hrefs: new Set(), networkLinks: 0 };
    for (const source of out.xml) {
      progress(`Reading ${source.name} …`);
      const doc = parseXml(decodeXml(source.bytes), source.name);
      const root = doc.documentElement.localName;
      if (root === 'kml') {
        readKml(doc, source.name, xml);
        out.kinds.add(out.kinds.has('KMZ') ? 'KMZ' : 'KML');
      } else if (root === 'gpx' || root === 'TrainingCenterDatabase') {
        readGps(doc, root === 'gpx' ? 'gpx' : 'tcx', out.xml.length > 1 ? source.name : '', xml);
        out.kinds.add(root === 'gpx' ? 'GPX' : 'TCX');
      } else if (out.xml.length === 1 && !out.shapefiles.length && !out.json.length) {
        throw new Error(`This XML file (<${root}>) is not KML, GPX or TCX.`);
      } else {
        out.notes.push(`${source.name}: <${root}> is not KML, GPX or TCX.`);
      }
    }

    let vector: VectorResult = { layers: [], notes: [] };
    if (out.shapefiles.length || out.json.length) {
      progress(out.shapefiles.length ? 'Reading shapes and attributes …' : 'Reading features …');
      vector = await readInWorker({ shapefiles: out.shapefiles, json: out.json });
    }
    out.notes.push(...vector.notes);

    // Icons and overlay images: only data: URLs and files inside the archive.
    const dirs = [...new Set(out.xml.map((s) => s.dir))];
    let missing = 0;
    for (const href of xml.hrefs) {
      if (/^data:image\//i.test(href)) {
        data.icons.set(href, href);
        continue;
      }
      const entry = dirs.map((dir) => resolvePath(href, dir)).map((path) => (path ? out.files.get(path) : undefined)).find(Boolean);
      if (!entry) {
        missing++;
        continue;
      }
      try {
        const type = IMAGE_TYPES[extensionOf(entry.filename)] ?? 'application/octet-stream';
        const url = URL.createObjectURL(new Blob([(await bytesOf(entry)) as Uint8Array<ArrayBuffer>], { type }));
        data.urls.push(url);
        data.icons.set(href, url);
      } catch {
        missing++;
      }
    }
    if (missing) out.notes.push('Icons and images the file links to outside itself are not loaded, so nothing leaves this device; colored markers stand in for them.');
    if (xml.networkLinks) out.notes.push(xml.networkLinks === 1 ? 'A network link was not followed: it would load content from another server.' : `${xml.networkLinks} network links were not followed: they would load content from other servers.`);

    data.layers = [...xml.layers, ...vector.layers];
    data.overlays = xml.overlays.flatMap((o) => {
      const url = data.icons.get(o.href);
      return url ? [{ layer: o.layer, feature: o.feature, url }] : [];
    });
    data.kind = [...out.kinds].join(', ') || 'Map data';
    return data;
  } catch (error) {
    for (const url of data.urls) URL.revokeObjectURL(url);
    throw error;
  } finally {
    await zip?.close();
  }
}
