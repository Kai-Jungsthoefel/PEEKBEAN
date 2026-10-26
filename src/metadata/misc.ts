// SPDX-License-Identifier: GPL-3.0-or-later
// Smaller formats: font names (opentype.js, MIT), SQLite file header, HTML head.
import opentype from 'opentype.js';
import { row, section, type MetaSection } from './model';

export async function fontMetadata(file: File): Promise<MetaSection[]> {
  let font: ReturnType<typeof opentype.parse>;
  try {
    font = opentype.parse(await file.arrayBuffer());
  } catch {
    // WOFF2 and collections are beyond opentype.js.
    return [];
  }
  const name = (key: string) => font.names?.[key]?.en ?? Object.values(font.names?.[key] ?? {})[0] ?? '';
  return [
    section('Font', [
      row('Family', name('fontFamily')),
      row('Style', name('fontSubfamily')),
      row('Full name', name('fullName')),
      row('PostScript name', name('postScriptName')),
      row('Version', name('version')),
      row('Glyphs', font.numGlyphs),
      row('Description', name('description')),
    ]),
    section('Origin', [
      row('Designer', name('designer')),
      row('Manufacturer', name('manufacturer')),
      row('Copyright', name('copyright')),
      row('Trademark', name('trademark')),
      row('License', name('license')),
      row('License URL', name('licenseURL')),
    ]),
  ].filter((s): s is MetaSection => s !== null);
}

export function sqliteMetadata(head: Uint8Array): MetaSection[] {
  if (head.length < 100) return [];
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const pageSize = view.getUint16(16) === 1 ? 65536 : view.getUint16(16);
  const pages = view.getUint32(28);
  const encoding = ['', 'UTF-8', 'UTF-16 LE', 'UTF-16 BE'][view.getUint32(56)] ?? '';
  const version = view.getUint32(96);
  const userVersion = view.getUint32(60);
  const applicationId = view.getUint32(68);
  return [
    section('Database', [
      row('Pages', pages ? `${pages.toLocaleString('en-US')} × ${pageSize.toLocaleString('en-US')} bytes` : ''),
      row('Text encoding', encoding),
      row('Schema version (user_version)', userVersion || ''),
      row('Application ID', applicationId ? `0x${applicationId.toString(16).padStart(8, '0')}` : ''),
      row('Last written by', version ? `SQLite ${Math.floor(version / 1_000_000)}.${Math.floor(version / 1000) % 1000}.${version % 1000}` : ''),
      row('Journal', head[18] === 2 ? 'WAL' : 'rollback'),
    ]),
  ].filter((s): s is MetaSection => s !== null);
}

export async function htmlMetadata(file: File): Promise<MetaSection[]> {
  // DOMParser builds an inert document: no scripts run and nothing is loaded.
  const source = new TextDecoder().decode(await file.slice(0, 256 * 1024).arrayBuffer());
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const meta = (name: string) =>
    doc.querySelector(`meta[name="${name}" i]`)?.getAttribute('content') ?? doc.querySelector(`meta[property="${name}" i]`)?.getAttribute('content') ?? '';
  return [
    section('Page', [
      row('Title', doc.title),
      row('Description', meta('description') || meta('og:description')),
      row('Author', meta('author')),
      row('Keywords', meta('keywords')),
      row('Language', doc.documentElement.lang),
      row('Generator', meta('generator')),
      row('Canonical URL', doc.querySelector('link[rel="canonical" i]')?.getAttribute('href')),
    ]),
  ].filter((s): s is MetaSection => s !== null);
}
