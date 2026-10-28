// SPDX-License-Identifier: GPL-3.0-or-later
// Shared by the archive and comic converters: writing a ZIP one file at a time, reading entries with a password
// asked for as the archive viewer does, and safe paths and names for the result.
import { BlobReader, BlobWriter, ZipWriter } from '@zip.js/zip.js';
import { isPasswordError, type Entry } from '../../viewers/archive';
import { baseName } from '../files';

/** A new archive, filled one entry after another. */
export interface ArchiveWriter {
  folder(path: string, modified: Date, mode?: number): Promise<void>;
  file(path: string, data: Blob, modified: Date, mode?: number): Promise<void>;
  close(): Promise<Blob>;
  /** Gives up after a failure. */
  abort(): void;
}

// Data that deflate would hardly make smaller: pictures, audio, video, archives and ZIP-based documents.
const COMPRESSED =
  /\.(jpe?g|png|gif|webp|avif|heic|heif|jxl|mp3|m4a|aac|ogg|oga|opus|flac|mp4|m4v|mov|mkv|webm|zip|7z|rar|gz|tgz|bz2|tbz2|xz|txz|zst|lz4|cab|jar|apk|docx|xlsx|pptx|odt|ods|odp|epub|cbz|cbr|cb7|glb|usdz|3mf|woff2?)$/i;

/** ZIP via zip.js; `store` keeps every file uncompressed (CBZ), otherwise only already compressed ones. */
export function createZipWriter(store = false): ArchiveWriter {
  const writer = new ZipWriter(new BlobWriter('application/zip'), { useWebWorkers: false, useCompressionStream: true });
  return {
    async folder(path, modified) {
      await writer.add(path, undefined, { directory: true, lastModDate: modified });
    },
    async file(path, data, modified) {
      await writer.add(path, new BlobReader(data), { level: store || COMPRESSED.test(path) ? 0 : 6, lastModDate: modified });
    },
    close: () => writer.close(),
    abort: () => {},
  };
}

// Entries read ahead of the writer: at most 8, and only those up to 4 MB.
const READ_AHEAD = 8;
const READ_AHEAD_SIZE = 4 << 20;

/** Reads entries; at the first encrypted one it asks for the password, as the archive viewer does, and keeps it for the rest. */
export class EntryReader {
  private password: string | undefined;
  private readonly archiveName: string;
  /** An encrypted entry was read: the result holds data that had a password. */
  decrypted = false;

  constructor(archiveName: string) {
    this.archiveName = archiveName;
  }

  async read(entry: Entry): Promise<Blob> {
    for (;;) {
      try {
        const data = await entry.read(this.password);
        if (entry.encrypted) this.decrypted = true;
        return data;
      } catch (error) {
        if (!entry.encrypted || !isPasswordError(error)) {
          const reason = error instanceof Error ? error.message : String(error);
          throw new Error(`“${entry.dir}${entry.name}” could not be unpacked: ${reason}`, { cause: error });
        }
        const question = this.password === undefined ? `“${this.archiveName}” contains encrypted files. Password:` : `Wrong password for “${this.archiveName}”. Password:`;
        const input = window.prompt(question);
        if (input === null) throw new Error('The archive cannot be converted without its password.');
        this.password = input;
      }
    }
  }

  /**
   * The entries' data in order, read a few entries ahead: with many small files the waiting for each read overlaps.
   * Large and encrypted entries wait until the reads before them are done, which bounds the memory and keeps the
   * password prompt to one at a time.
   */
  async *inOrder(entries: Entry[]): AsyncGenerator<Blob> {
    const reads: Promise<Blob>[] = [];
    let next = 0;
    for (let i = 0; i < entries.length; i++) {
      while (next < entries.length && reads.length < READ_AHEAD) {
        const entry = entries[next];
        if (reads.length > 0 && (entry.encrypted || entry.size > READ_AHEAD_SIZE)) break;
        const read = this.read(entry);
        read.catch(() => {}); // after an earlier failure nobody waits for it
        reads.push(read);
        next++;
      }
      yield await reads.shift()!;
    }
  }
}

/** The path in the new archive, without empty, "." and ".." parts or a leading "/", so it cannot unpack outside its folder. */
export function cleanPath(path: string): string {
  return path
    .split('/')
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('/');
}

/** "photos.tar.gz" → "photos", "photos.7z" → "photos", "notes.md.gz" → "notes.md". */
export function archiveBaseName(name: string): string {
  const tar = /\.tar\.[^.]+$/i.exec(name);
  return tar && tar.index > 0 ? name.slice(0, tar.index) : baseName(name);
}

/** The page redraws on every progress message; with thousands of small files a few per second are enough. */
export function throttled(progress: (message: string, fraction?: number) => void): (message: string, fraction?: number) => void {
  let last = -Infinity;
  return (message, fraction) => {
    const now = performance.now();
    if (now - last < 100) return;
    last = now;
    progress(message, fraction);
  };
}

/** The date of an entry, or `fallback` (the archive's own date) when the archive has none. */
export const dateOr = (date: Date | null, fallback: Date) => (date && !Number.isNaN(date.getTime()) ? date : fallback);

export const count = (n: number, one: string, many: string) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** Up to three paths for a note: "a, b, c and 4 more". */
export function someNames(paths: string[]): string {
  const shown = paths.slice(0, 3).join(', ');
  return paths.length > 3 ? `${shown} and ${(paths.length - 3).toLocaleString('en-US')} more` : shown;
}
