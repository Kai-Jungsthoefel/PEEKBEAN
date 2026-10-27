// SPDX-License-Identifier: GPL-3.0-or-later
// Properties of RTF documents (the \info group) and e-books (EPUB package document, FictionBook description).
import type { BookMeta } from '../viewers/ebook/book';
import { formatNumber, row, section, xmlDate, type MetaSection } from './model';

export async function rtfMetadata(file: File): Promise<MetaSection[]> {
  const { readRtfInfo } = await import('../viewers/rtf/parse');
  // The \info group sits in the header; the first 256 KB hold it even when pictures follow.
  const info = readRtfInfo(new Uint8Array(await file.slice(0, 256 * 1024).arrayBuffer()));
  return [
    section('Document', [
      row('Title', info.title),
      row('Subject', info.subject),
      row('Author', info.author),
      row('Manager', info.manager),
      row('Company', info.company),
      row('Category', info.category),
      row('Keywords', info.keywords),
      row('Comments', info.comment),
      row('Created', info.created),
      row('Modified', info.revised),
      row('Printed', info.printed),
    ]),
    section('Statistics', [
      row('Pages', info.pages),
      row('Words', info.words),
      row('Characters', info.characters),
    ]),
    section('Origin', [
      row('Last saved by', info.operator),
      row('Created with', info.generator),
      row('Version', info.version),
      row('Code page', info.codepage ? `Windows-${info.codepage}` : ''),
    ]),
  ].filter((s): s is MetaSection => s !== null);
}

function bookSections(meta: BookMeta, format: string, extra: [string, unknown][]): MetaSection[] {
  return [
    section('Book', [
      row('Title', meta.title),
      row(meta.creators.length > 1 ? 'Authors' : 'Author', meta.creators),
      row('Series', meta.series),
      row('Publisher', meta.publisher),
      row('Published', meta.date),
      row('Language', meta.language),
      row('Subjects', meta.subjects),
      row('Description', meta.description.length > 600 ? `${meta.description.slice(0, 600)} …` : meta.description),
      row('Identifier', meta.identifier),
      row('Rights', meta.rights),
    ]),
    section('Format', [row('Format', format), row('Modified', xmlDate(meta.modified)), ...extra.map(([label, value]) => row(label, value))]),
  ].filter((s): s is MetaSection => s !== null);
}

export async function epubMetadata(file: File): Promise<MetaSection[]> {
  const { openArchive } = await import('../viewers/archive');
  const { byName, decodeMarkup, parseXml } = await import('../viewers/ebook/book');
  const { hasDrm, parseEncryption, parsePackage } = await import('../viewers/ebook/epub');
  const archive = await openArchive(file);
  try {
    const find = (path: string) => archive.entries.find((e) => e.dir + e.name === path);
    const read = async (path: string) => {
      const entry = find(path);
      return entry ? decodeMarkup(new Uint8Array(await (await entry.read()).arrayBuffer())) : null;
    };
    const container = parseXml((await read('META-INF/container.xml')) ?? '');
    const opfPath = (container && byName(container, 'rootfile')[0]?.getAttribute('full-path')) ?? archive.entries.find((e) => e.name.endsWith('.opf'))?.name;
    const opf = opfPath ? await read(opfPath) : null;
    if (!opfPath || !opf) return [];
    const pkg = parsePackage(opf, opfPath);
    const encryption = parseEncryption(await read('META-INF/encryption.xml'));
    const protection = hasDrm(encryption) ? 'DRM (cannot be shown)' : encryption.size ? `${formatNumber(encryption.size, 0)} obfuscated fonts` : '';
    return bookSections(pkg.meta, `EPUB ${pkg.version || '2.0'}`, [
      ['Layout', pkg.fixed ? 'Fixed layout (pages)' : 'Reflowable'],
      ['Reading order', `${pkg.spine.length} ${pkg.spine.length === 1 ? 'document' : 'documents'}`],
      ['Protection', protection],
    ]);
  } finally {
    await archive.close();
  }
}

export async function fb2Metadata(file: File): Promise<MetaSection[]> {
  const { openFb2 } = await import('../viewers/ebook/fb2');
  const book = await openFb2(file);
  return bookSections(book.meta, book.format, [['Chapters', book.spine.length]]);
}
