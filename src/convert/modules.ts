// SPDX-License-Identifier: GPL-3.0-or-later
// The code of each converter in the catalog, loaded only when a file needs it.
import { CONVERTERS, sourceFor, type ConverterInfo } from './catalog';
import { extensionOf } from '../core/bytes';
import { detectViewer, viewers } from '../core/registry';
import type { ConverterModule } from './types';

const MODULES: Record<string, () => Promise<ConverterModule>> = {
  image: () => import('./converters/image'),
  audio: () => import('./converters/audio'),
  data: () => import('./converters/data'),
  subtitles: () => import('./converters/subtitles'),
  pdf: () => import('./converters/pdf'),
  office: () => import('./converters/office'),
  spreadsheet: () => import('./converters/spreadsheet'),
  model3d: () => import('./converters/model3d'),
  drawing: () => import('./converters/drawing'),
  archive: () => import('./converters/archive'),
  comic: () => import('./converters/comic'),
  map: () => import('./converters/map'),
  email: () => import('./converters/email'),
  database: () => import('./converters/database'),
};

export function loadConverter(id: string): Promise<ConverterModule> {
  return MODULES[id]();
}

/** The converter for a file a viewer shows; null when none takes it. */
export function converterForViewer(viewer: string, name: string): ConverterInfo | null {
  return CONVERTERS.find((c) => c.viewers.includes(viewer) && (!c.strict || sourceFor(c, name))) ?? null;
}

/**
 * A ZIP that a viewer shows as a whole (a shapefile with its .dbf and .prj) goes to that viewer's converter, as
 * "Open as map" does in the archive viewer. Only ZIPs are looked into; no such viewer takes other archives.
 */
async function wholeArchiveViewer(file: File): Promise<(typeof viewers)[number] | null> {
  const candidates = viewers.filter((v) => v.wholeArchive && CONVERTERS.some((c) => c.viewers.includes(v.id)));
  if (candidates.length === 0 || extensionOf(file.name) !== 'zip') return null;
  const { openArchive } = await import('../viewers/archive');
  const archive = await openArchive(file);
  try {
    const names = archive.entries.map((e) => e.name);
    return candidates.find((v) => v.wholeArchive!.accepts(names, archive.kind)) ?? null;
  } finally {
    await archive.close();
  }
}

/** The converter for a file, found by the viewers' format detection. */
export async function converterFor(file: File): Promise<{ converter: ConverterInfo | null; viewer: string; kind: string }> {
  let viewer = await detectViewer(file);
  if (viewer.id === 'archive') viewer = (await wholeArchiveViewer(file).catch(() => null)) ?? viewer;
  return { converter: converterForViewer(viewer.id, file.name), viewer: viewer.id, kind: viewer.label };
}
