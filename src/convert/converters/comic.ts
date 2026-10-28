// SPDX-License-Identifier: GPL-3.0-or-later
// Comic book archives (CBR, CB7, CBT, CBZ) to CBZ: the pictures the comic viewer shows, in its order, in a ZIP whose
// entries are only stored, as comic readers expect. ComicInfo.xml (title, series, credits) goes along.
import { openArchive, type Entry } from '../../viewers/archive';
import { comicPages } from '../../viewers/comic';
import { EntryReader, cleanPath, count, createZipWriter, dateOr, someNames, throttled } from '../archive/pack';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

// Files nobody misses: macOS and Windows folder metadata.
const JUNK = /^(\.|thumbs\.db$|desktop\.ini$)/i;

/**
 * Names for the pages. Readers sort by name, some as the viewer does ("2" before "10"), some character by character;
 * when the two orders differ, numbered names put the pages in the same order in all of them.
 */
function pageNames(pages: Entry[]): { names: string[]; renamed: boolean } {
  const names = pages.map((e) => cleanPath(e.dir + e.name));
  const plain = [...names].sort();
  if (new Set(names).size === names.length && names.every((name, i) => name && name === plain[i])) return { names, renamed: false };
  const width = Math.max(3, String(pages.length).length);
  return { names: pages.map((e, i) => `${String(i + 1).padStart(width, '0')}${e.name.slice(e.name.lastIndexOf('.'))}`), renamed: true };
}

export async function convert({ file, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading comic …');
  const archive = await openArchive(file);
  const writer = createZipWriter(true);
  try {
    const pages = comicPages(archive.entries);
    if (pages.length === 0) throw new Error('The comic archive contains no pictures.');
    const info = archive.entries.find((e) => e.name.toLowerCase() === 'comicinfo.xml' && !e.dir.startsWith('__MACOSX'));
    const { names, renamed } = pageNames(pages);

    const reader = new EntryReader(file.name);
    const fallback = new Date(file.lastModified);
    const step = throttled(progress);
    let index = 0;
    for await (const data of reader.inOrder(pages)) {
      step(`Packing page ${(index + 1).toLocaleString('en-US')} of ${pages.length.toLocaleString('en-US')} …`, index / pages.length);
      await writer.file(names[index], data, dateOr(pages[index].modified, fallback));
      index++;
    }
    if (info) await writer.file('ComicInfo.xml', await reader.read(info), dateOr(info.modified, fallback));
    progress('Finishing …', 1);
    const result = new File([await writer.close()], resultName(file.name, 'cbz'), { type: 'application/vnd.comicbook+zip' });

    const used = new Set<Entry>([...pages, ...(info ? [info] : [])]);
    const others = archive.entries.filter((e) => !used.has(e) && !JUNK.test(e.name) && !e.dir.startsWith('__MACOSX')).map((e) => e.dir + e.name);
    const notes: string[] = [];
    if (archive.warning) notes.push('The archive is damaged or incomplete; only the pages before the damage were converted.');
    if (renamed) notes.push(`The pages were renamed ${names[0]} to ${names[names.length - 1]}, so that every comic reader shows them in this order.`);
    if (others.length > 0) notes.push(`Left out ${count(others.length, 'file that is not a page', 'files that are not pages')}: ${someNames(others)}.`);
    if (reader.decrypted) notes.push('The comic was encrypted; the CBZ has no password.');
    return { files: [result], notes };
  } catch (error) {
    writer.abort();
    throw error;
  } finally {
    await archive.close();
  }
}
