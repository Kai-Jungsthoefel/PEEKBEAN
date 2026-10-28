// SPDX-License-Identifier: GPL-3.0-or-later
import { h } from '../core/dom';

/** The file name without its extension. */
export function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** Name of a converted file: the original name with the new extension, and a suffix for one of several results. */
export function resultName(original: string, extension: string, suffix = ''): string {
  // Characters Windows does not allow in file names, e.g. from sheet names.
  const safe = suffix.replace(/[\\/:*?"<>|]/g, '_');
  return `${baseName(original)}${safe ? ` ${safe}` : ''}.${extension}`;
}

export function download(file: File): void {
  const url = URL.createObjectURL(file);
  h('a', { href: url, download: file.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** One ZIP of all files; names that occur twice get a number. Images and other compressed data are only stored. */
export async function zipFiles(files: File[], name: string): Promise<File> {
  const { BlobReader, BlobWriter, ZipWriter, configure } = await import('@zip.js/zip.js');
  configure({ useWebWorkers: false, useCompressionStream: true });
  const writer = new ZipWriter(new BlobWriter('application/zip'));
  const used = new Set<string>();
  for (const file of files) {
    let entry = file.name;
    for (let n = 2; used.has(entry.toLowerCase()); n++) entry = `${baseName(file.name)} (${n})${file.name.slice(baseName(file.name).length)}`;
    used.add(entry.toLowerCase());
    const compressed = /\.(png|jpe?g|webp|glb|usdz|xlsx|ods|zip)$/i.test(entry);
    await writer.add(entry, new BlobReader(file), { level: compressed ? 0 : 6 });
  }
  return new File([await writer.close()], name, { type: 'application/zip' });
}
