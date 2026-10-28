// SPDX-License-Identifier: GPL-3.0-or-later
// Archives (ZIP, RAR, 7z, TAR and its compressed forms, ISO, CAB, LZH …) to ZIP or TAR.GZ. The files are read with
// the archive viewer's readers and written one after another, so only the new archive and the current file are in
// memory. A single compressed file (.gz, .bz2, .xz, .zst) becomes an archive holding the one unpacked file.
import { openArchive, type Entry, type FolderEntry } from '../../viewers/archive';
import { createTarGzWriter } from '../archive/tar';
import { EntryReader, archiveBaseName, cleanPath, count, createZipWriter, dateOr, someNames, throttled } from '../archive/pack';
import type { ConvertContext, ConvertResult } from '../types';

// A path that would unpack outside the target folder (the readers already drop a leading "/").
const ESCAPING = /(^|\/)\.\.(\/|$)/;

/** zip.js refuses ZIPs with such paths; say why in words. */
async function open(file: File) {
  try {
    return await openArchive(file);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== 'Unsafe filename') throw error;
    const name = (error as Error & { filename?: string }).filename;
    throw new Error(`The ZIP contains paths that point outside its folder${name ? ` (“${name}”)` : ''}, which is often a sign of a harmful archive. It is not converted.`);
  }
}

export async function convert({ file, target, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading archive …');
  const archive = await open(file);
  const writer = target === 'tgz' ? createTarGzWriter() : createZipWriter();
  try {
    // A path stored twice keeps its last copy, which is what unpacking the archive would leave.
    const files = new Map<string, Entry>();
    const left = [...(archive.skipped ?? [])];
    let duplicates = 0;
    let escaping = 0;
    for (const entry of archive.entries) {
      const stored = entry.dir + entry.name;
      if (entry.symlink) {
        left.push(stored);
        continue;
      }
      const path = cleanPath(stored);
      if (!path) continue;
      if (ESCAPING.test(stored)) escaping++;
      if (files.has(path)) duplicates++;
      files.set(path, entry);
    }
    if (files.size === 0) throw new Error('The archive contains no files.');
    // Folders the archive lists itself (ZIP, TAR), so empty ones and their dates are kept.
    const folders = new Map<string, FolderEntry>();
    for (const folder of archive.folders ?? []) {
      const path = cleanPath(folder.path);
      if (path && !files.has(path)) folders.set(`${path}/`, folder);
    }

    const fallback = new Date(file.lastModified);
    for (const [path, folder] of folders) await writer.folder(path, dateOr(folder.modified, fallback), folder.mode);
    const reader = new EntryReader(file.name);
    const paths = [...files.keys()];
    const entries = [...files.values()];
    const total = entries.reduce((sum, entry) => sum + entry.size, 0);
    const step = throttled(progress);
    let index = 0;
    let done = 0;
    for await (const data of reader.inOrder(entries)) {
      const entry = entries[index];
      step(`Packing ${entry.name} (${(index + 1).toLocaleString('en-US')} of ${entries.length.toLocaleString('en-US')}) …`, (done + index) / (total + entries.length));
      await writer.file(paths[index], data, dateOr(entry.modified, fallback), entry.mode);
      done += entry.size;
      index++;
    }
    progress('Finishing …', 1);
    const tgz = target === 'tgz';
    const result = new File([await writer.close()], `${archiveBaseName(file.name)}.${tgz ? 'tar.gz' : 'zip'}`, { type: tgz ? 'application/gzip' : 'application/zip' });

    const notes: string[] = [];
    if (archive.warning) notes.push('The archive is damaged or incomplete; only the files before the damage were converted.');
    if (left.length > 0) notes.push(`Left out ${count(left.length, 'link or special file', 'links and special files')}: ${someNames(left)}.`);
    if (duplicates > 0) notes.push(`${count(duplicates, 'file was', 'files were')} stored twice; the last copy was kept.`);
    if (escaping > 0) notes.push(`Removed “..” from ${count(escaping, 'path', 'paths')}, so everything unpacks into one folder.`);
    if (reader.decrypted) notes.push('The files were encrypted; the new archive has no password.');
    return { files: [result], notes };
  } catch (error) {
    writer.abort();
    throw error;
  } finally {
    await archive.close();
  }
}
