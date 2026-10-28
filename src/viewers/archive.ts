// SPDX-License-Identifier: GPL-3.0-or-later
// ZIP via zip.js (BSD-3-Clause, also AES), TAR and GZIP with the browser's own decompression, everything else
// (7z, RAR, bzip2, xz, CAB, ISO …) via our libarchive build. Entries open as new tabs.
import { BlobReader, BlobWriter, ZipReader, configure } from '@zip.js/zip.js';
import { extensionOf, formatBytes, startsWith } from '../core/bytes';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { viewers } from '../core/registry';
import type { ViewerContext } from '../core/types';
import type { LibarchiveRequest, LibarchiveResponse } from '../workers/libarchive.worker';

// zip.js would otherwise spawn workers from inline code; the native DecompressionStream is fast enough.
configure({ useWebWorkers: false, useCompressionStream: true });

export interface Entry {
  /** Folder path with trailing slash, '' for the root. */
  dir: string;
  name: string;
  size: number;
  modified: Date | null;
  encrypted: boolean;
  /** Unix permission bits (e.g. 0o755) where the archive records them; the converter keeps them in TAR. */
  mode?: number;
  /** A ZIP entry that is a Unix symbolic link: its data is the path it points to. */
  symlink?: boolean;
  read(password?: string): Promise<Blob>;
}

/** A folder entry, for the converter: ZIP and TAR list them, so empty folders survive a conversion. */
export interface FolderEntry {
  /** Path with trailing slash. */
  path: string;
  modified: Date | null;
  mode?: number;
}

export interface OpenedArchive {
  kind: string;
  entries: Entry[];
  folders?: FolderEntry[];
  /** Paths of links, devices … that are not listed as entries (TAR). */
  skipped?: string[];
  /** Set when listing stopped early because the archive is damaged or cut off. */
  warning?: string | null;
  close(): Promise<void>;
}

function splitPath(path: string): { dir: string; name: string } {
  const clean = path.replace(/\\/g, '/').replace(/^\.?\//, '');
  const slash = clean.lastIndexOf('/');
  return { dir: clean.slice(0, slash + 1), name: clean.slice(slash + 1) };
}

async function openZip(file: File): Promise<OpenedArchive> {
  const reader = new ZipReader(new BlobReader(file));
  const all = await reader.getEntries();
  const entries = all.filter((e) => !e.directory);
  // Only ZIPs made on Unix record permissions.
  const mode = (unixMode: number | undefined) => (unixMode === undefined ? undefined : unixMode & 0o7777);
  return {
    kind: 'ZIP',
    entries: entries.map((entry) => ({
      ...splitPath(entry.filename),
      size: entry.uncompressedSize,
      modified: entry.lastModDate ?? null,
      encrypted: entry.encrypted,
      mode: mode(entry.unixMode),
      symlink: entry.symlink,
      read: (password) => entry.getData!(new BlobWriter(), { password }),
    })),
    folders: all
      .filter((e) => e.directory)
      .map((e) => ({ path: e.filename.replace(/\\/g, '/').replace(/\/?$/, '/'), modified: e.lastModDate ?? null, mode: mode(e.unixMode) })),
    close: () => reader.close(),
  };
}

const decodeField = (bytes: Uint8Array) => new TextDecoder().decode(bytes.subarray(0, bytes.indexOf(0) < 0 ? bytes.length : bytes.indexOf(0)));
const octal = (bytes: Uint8Array) => parseInt(decodeField(bytes).trim() || '0', 8);

/** Reads TAR headers lazily from a Blob; the file data is only read when an entry is opened. */
async function readTar(blob: Blob): Promise<Pick<OpenedArchive, 'entries' | 'folders' | 'skipped'>> {
  const entries: Entry[] = [];
  const folders: FolderEntry[] = [];
  const skipped: string[] = [];
  let offset = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  while (offset + 512 <= blob.size) {
    const header = new Uint8Array(await blob.slice(offset, offset + 512).arrayBuffer());
    if (header.every((b) => b === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const dataStart = offset + 512;
    offset = dataStart + Math.ceil(size / 512) * 512;

    if (type === 'L') {
      longName = decodeField(new Uint8Array(await blob.slice(dataStart, dataStart + size).arrayBuffer()));
      continue;
    }
    if (type === 'x') {
      const pax = new TextDecoder().decode(await blob.slice(dataStart, dataStart + size).arrayBuffer());
      paxPath = /\d+ path=([^\n]*)\n/.exec(pax)?.[1] ?? null;
      continue;
    }
    const prefix = startsWith(header, 'ustar', 257) ? decodeField(header.subarray(345, 500)) : '';
    const path = paxPath ?? longName ?? (prefix ? `${prefix}/` : '') + decodeField(header.subarray(0, 100));
    longName = paxPath = null;
    const mtime = octal(header.subarray(136, 148));
    const modified = mtime ? new Date(mtime * 1000) : null;
    const mode = octal(header.subarray(100, 108)) & 0o7777;
    if (type === '5') folders.push({ path: path.replace(/\/?$/, '/'), modified, mode });
    else if ('12346'.includes(type)) skipped.push(path);
    if (type !== '0' && type !== '\0' && type !== '7') continue; // folders, links, devices
    entries.push({
      ...splitPath(path),
      size,
      modified,
      encrypted: false,
      mode,
      read: async () => blob.slice(dataStart, dataStart + size),
    });
  }
  return { entries, folders, skipped };
}

async function gunzip(file: Blob): Promise<Blob> {
  return new Response(file.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
}

/** Original file name from the gzip header, if the compressor stored one. */
function gzipName(head: Uint8Array, fallback: string): string {
  if (!(head[3] & 0x08)) return fallback;
  let start = 10;
  if (head[3] & 0x04) start += 2 + (head[10] | (head[11] << 8));
  const end = head.indexOf(0, start);
  return end > start ? new TextDecoder('latin1').decode(head.subarray(start, end)) : fallback;
}

/** Thrown when an entry needs a (different) password; the viewer then asks again. */
class PasswordError extends Error {
  override name = 'PasswordError';
}

/** The entry could not be read for want of the right password (zip.js: "Invalid password", "File contains encrypted entry"). */
export function isPasswordError(error: unknown): boolean {
  return error instanceof PasswordError || /password|encrypted entry/i.test(String(error));
}

const LIBARCHIVE_ERRORS: Record<string, string> = {
  UNRECOGNIZED: 'The archive format was not recognized, or the file is damaged.',
  UNSUPPORTED_ENCRYPTION: 'This encryption (AES in ZIP, 7z or RAR) cannot be decrypted in the browser yet.',
  OUT_OF_MEMORY: 'The archive is too large for the memory of this browser tab.',
};

/** 7z, RAR, tar.bz2/xz/zst, CAB, ISO … via our libarchive build, running in a worker. */
async function openLibarchive(file: File): Promise<OpenedArchive> {
  const worker = new Worker(new URL('../workers/libarchive.worker.ts', import.meta.url), { type: 'module' });
  // One request at a time: the worker answers in order, but keep the pairing obvious.
  let queue: Promise<unknown> = Promise.resolve();
  const call = (request: LibarchiveRequest) => {
    const next = queue.then(
      () =>
        new Promise<LibarchiveResponse>((resolve, reject) => {
          worker.onmessage = (e: MessageEvent<LibarchiveResponse>) => resolve(e.data);
          worker.onerror = (e) => reject(new Error(e.message || 'The archive module could not be loaded.'));
          worker.postMessage(request);
        }),
    );
    queue = next.catch(() => {});
    return next;
  };
  const failure = (r: Extract<LibarchiveResponse, { ok: false }>) =>
    r.code === 'PASSPHRASE' ? new PasswordError(r.error) : new Error(LIBARCHIVE_ERRORS[r.code] ?? r.error);

  const opened = await call({ kind: 'open', file });
  if (!opened.ok || opened.kind !== 'open') {
    worker.terminate();
    throw opened.ok ? new Error('Unexpected answer from the archive module.') : failure(opened);
  }
  // A single compressed file (format "raw") has one entry called "data"; name it after the outer file.
  const rawName = file.name.replace(/\.(xz|bz2|lzma|zst|lz4|lz|z|gz)$/i, '') || 'unpacked';
  return {
    kind: [opened.format === 'raw' ? 'Compressed file' : opened.format, ...opened.filters.filter((f) => f !== 'none')].join(' · '),
    entries: opened.entries.map((e) => ({
      ...(opened.format === 'raw' ? { dir: '', name: rawName } : splitPath(e.path)),
      size: e.size ?? 0,
      modified: e.mtime ? new Date(e.mtime * 1000) : null,
      encrypted: e.encrypted,
      read: async (password?: string) => {
        const r = await call({ kind: 'extract', index: e.index, passphrase: password });
        if (!r.ok) throw failure(r);
        if (r.kind !== 'extract') throw new Error('Unexpected answer from the archive module.');
        return new Blob([r.data as Uint8Array<ArrayBuffer>]);
      },
    })),
    warning: opened.warning,
    close: async () => worker.terminate(),
  };
}

export async function openArchive(file: File): Promise<OpenedArchive> {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (startsWith(head, 'PK')) return openZip(file);
  if (startsWith(head, [0x1f, 0x8b])) {
    const data = await gunzip(file);
    const inner = new Uint8Array(await data.slice(0, 512).arrayBuffer());
    if (startsWith(inner, 'ustar', 257)) return { kind: 'TAR.GZ', ...(await readTar(data)), close: async () => {} };
    const name = gzipName(head, file.name.replace(/\.gz$/i, '') || 'unpacked');
    return { kind: 'GZIP', entries: [{ dir: '', name, size: data.size, modified: null, encrypted: false, read: async () => data }], close: async () => {} };
  }
  if (startsWith(head, 'ustar', 257) || extensionOf(file.name) === 'tar') return { kind: 'TAR', ...(await readTar(file)), close: async () => {} };
  return openLibarchive(file);
}

interface Folder {
  folders: Map<string, Folder>;
  files: Entry[];
}

function buildTree(entries: Entry[]): Folder {
  const root: Folder = { folders: new Map(), files: [] };
  for (const entry of entries) {
    let folder = root;
    for (const part of entry.dir.split('/').filter(Boolean)) {
      if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), files: [] });
      folder = folder.folders.get(part)!;
    }
    folder.files.push(entry);
  }
  return root;
}

function download(file: File): void {
  const url = URL.createObjectURL(file);
  h('a', { href: url, download: file.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function mount({ file, container, toolbar, openFile, progress }: ViewerContext) {
  progress('Reading archive …');
  const archive = await openArchive(file);
  if (archive.entries.length === 0) {
    await archive.close();
    throw new Error('The archive contains no files.');
  }

  let password: string | undefined;
  async function extract(entry: Entry): Promise<File> {
    for (;;) {
      if (entry.encrypted && password === undefined) {
        const input = window.prompt(`“${entry.name}” is encrypted. Password:`);
        if (input === null) throw new Error('The file cannot be extracted without a password.');
        password = input;
      }
      try {
        const blob = await entry.read(password);
        return new File([blob], entry.name, { lastModified: entry.modified?.getTime() });
      } catch (error) {
        if (entry.encrypted && isPasswordError(error)) {
          password = undefined;
          continue;
        }
        throw error;
      }
    }
  }

  const busy = async (button: HTMLButtonElement, action: () => Promise<void>) => {
    button.disabled = true;
    try {
      await action();
    } catch (error) {
      window.alert(`The file could not be extracted: ${error instanceof Error ? error.message : error}`);
    } finally {
      button.disabled = false;
    }
  };

  const fileRow = (entry: Entry, depth: number) => {
    const openButton: HTMLButtonElement = h('button', { type: 'button', class: 'btn sm', title: 'Open in a new tab', onclick: () =>
      busy(openButton, async () => openFile(await extract(entry))) }, icon('external', 13), h('span', { class: 'lbl' }, 'Open'));
    const saveButton: HTMLButtonElement = h('button', { type: 'button', class: 'ibtn s', title: 'Save', 'aria-label': `Save ${entry.name}`, onclick: () =>
      busy(saveButton, async () => download(await extract(entry))) }, icon('download', 14));
    return h(
      'div',
      { class: 'tree-row', style: `--depth:${depth}`, ondblclick: () => openButton.click() },
      h('span', { class: 'tree-name' }, icon(entry.encrypted ? 'lock' : 'file', 15), h('span', {}, entry.name)),
      h('span', { class: 'tree-size' }, formatBytes(entry.size)),
      h('span', { class: 'tree-date' }, entry.modified?.toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) ?? ''),
      h('span', { class: 'tree-actions' }, openButton, saveButton),
    );
  };

  const folderRows = (folder: Folder, depth: number): HTMLElement[] => {
    const rows: HTMLElement[] = [];
    for (const [name, sub] of [...folder.folders.entries()].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
      const children = h('div', { class: 'tree-children' }, ...folderRows(sub, depth + 1));
      const toggle = h('div', { class: 'tree-row folder', style: `--depth:${depth}`, onclick: () => {
        children.hidden = !children.hidden;
        toggle.classList.toggle('collapsed', children.hidden);
      } }, h('span', { class: 'tree-name' }, icon('folder', 15), h('span', {}, name)));
      rows.push(toggle, children);
    }
    for (const entry of folder.files.sort((a, b) => a.name.localeCompare(b.name, 'en'))) rows.push(fileRow(entry, depth));
    return rows;
  };

  const total = archive.entries.reduce((sum, e) => sum + e.size, 0);
  container.append(
    h(
      'div',
      { class: 'tree' },
      h('div', { class: 'tree-row tree-head' }, h('span', {}, 'Name'), h('span', { class: 'tree-size' }, 'Size'), h('span', { class: 'tree-date' }, 'Modified'), h('span', {})),
      ...folderRows(buildTree(archive.entries), 0),
    ),
  );
  toolbar.append(h('span', { class: 'meta' }, `${archive.kind} · ${archive.entries.length} ${archive.entries.length === 1 ? 'file' : 'files'} · ${formatBytes(total)} unpacked`));
  // Viewers that show several files of an archive together (a board's Gerber files, shapefiles) offer to open it whole.
  const names = archive.entries.map((e) => e.name);
  for (const viewer of viewers) {
    const whole = viewer.wholeArchive;
    if (!whole?.accepts(names, archive.kind)) continue;
    toolbar.append(h('button', { type: 'button', class: 'btn sm', title: whole.title, onclick: () => openFile(file, viewer.id) }, icon(viewer.icon, 14), whole.label));
  }

  return { destroy: () => void archive.close() };
}
