// SPDX-License-Identifier: GPL-3.0-or-later
// What the e-book reader works with, whatever the file format: metadata, reading order, table of contents and
// access to the files inside the book.

export interface BookMeta {
  title: string;
  creators: string[];
  language: string;
  publisher: string;
  date: string;
  description: string;
  identifier: string;
  subjects: string[];
  rights: string;
  modified: string;
  series: string;
}

export interface TocEntry {
  label: string;
  /** Path inside the book, with an optional #fragment. */
  target: string;
  children: TocEntry[];
}

export interface SpineItem {
  path: string;
  mediaType: string;
  /** Uncompressed size, to estimate the height before the chapter is drawn. */
  size: number;
  /** Fixed-layout page (pre-paginated) instead of reflowable text. */
  fixed: boolean;
}

export interface Book {
  /** e.g. "EPUB 3.0" or "FictionBook 2". */
  format: string;
  meta: BookMeta;
  spine: SpineItem[];
  toc: TocEntry[];
  /** Path of the cover picture. */
  cover: string | null;
  /** All style sheets of the book, scanned once for embedded font families. */
  stylesheets: string[];
  direction: 'ltr' | 'rtl';
  mediaType(path: string): string;
  has(path: string): boolean;
  text(path: string): Promise<string | null>;
  bytes(path: string): Promise<Uint8Array | null>;
  close(): Promise<void>;
}

export const emptyMeta = (): BookMeta => ({
  title: '', creators: [], language: '', publisher: '', date: '', description: '', identifier: '', subjects: [], rights: '', modified: '', series: '',
});

/** A path inside the book from a link relative to `base` (a file path); '' for links that leave the book. */
export function resolvePath(base: string, href: string): string {
  const clean = href.replace(/[#?].*$/s, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('//')) return '';
  let path = clean;
  try {
    path = decodeURIComponent(clean);
  } catch {
    // Keep the raw text when the escapes are broken.
  }
  const parts = path.startsWith('/') ? [] : base.split('/').slice(0, -1);
  for (const segment of path.split('/')) {
    if (segment === '..') parts.pop();
    else if (segment && segment !== '.') parts.push(segment);
  }
  return parts.join('/');
}

/** The fragment of a link, decoded; '' when there is none. */
export function fragmentOf(href: string): string {
  const hash = href.indexOf('#');
  if (hash < 0) return '';
  try {
    return decodeURIComponent(href.slice(hash + 1));
  } catch {
    return href.slice(hash + 1);
  }
}

const MEDIA_TYPES: Record<string, string> = {
  xhtml: 'application/xhtml+xml', html: 'text/html', htm: 'text/html', css: 'text/css', svg: 'image/svg+xml', png: 'image/png',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', otf: 'font/otf', ttf: 'font/ttf',
  woff: 'font/woff', woff2: 'font/woff2', mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'video/mp4', webm: 'video/webm', ogg: 'audio/ogg',
};

export function mediaTypeOf(path: string): string {
  return MEDIA_TYPES[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';
}

/** XML or HTML text from bytes: byte order mark, then the encoding in the XML declaration, else UTF-8. */
export function decodeMarkup(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  const head = String.fromCharCode(...bytes.subarray(0, 200));
  const declared = /^(?:﻿|\xef\xbb\xbf)?\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head)?.[1];
  try {
    return new TextDecoder(declared || 'utf-8').decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

export function parseXml(text: string): Document | null {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

/** Elements by local name, ignoring namespaces and prefixes. */
export function byName(root: Document | Element, name: string): Element[] {
  return [...root.getElementsByTagNameNS('*', name)];
}

export function childrenByName(parent: Element, name: string): Element[] {
  return [...parent.children].filter((c) => c.localName === name);
}

export const squash = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
