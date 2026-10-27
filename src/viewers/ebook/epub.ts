// SPDX-License-Identifier: GPL-3.0-or-later
// EPUB 2 and 3: META-INF/container.xml leads to the package document (metadata, manifest, reading order); the table of
// contents comes from nav.xhtml (EPUB 3) or toc.ncx (EPUB 2). Font obfuscation (IDPF and Adobe) is undone; any other
// encryption is DRM and the book is refused. The ZIP is read with zip.js through the archive viewer.
import { openArchive, type Entry } from '../archive';
import { type Book, type BookMeta, type TocEntry, byName, childrenByName, decodeMarkup, emptyMeta, fragmentOf, mediaTypeOf, parseXml, resolvePath, squash } from './book';

const DC = 'http://purl.org/dc/elements/1.1/';
const OPS = 'http://www.idpf.org/2007/ops';
const IDPF_FONTS = 'http://www.idpf.org/2008/embedding';
const ADOBE_FONTS = 'http://ns.adobe.com/pdf/enc#RC';

export const DRM_MESSAGE = 'This e-book is protected by DRM and cannot be shown.';

interface ManifestItem {
  path: string;
  mediaType: string;
  properties: string;
}

export interface EpubPackage {
  version: string;
  meta: BookMeta;
  identifiers: string[];
  manifest: Map<string, ManifestItem>;
  spine: { path: string; mediaType: string; fixed: boolean }[];
  cover: string | null;
  navPath: string | null;
  ncxPath: string | null;
  fixed: boolean;
  direction: 'ltr' | 'rtl';
}

/** Plain text from a description that may contain (escaped) HTML. */
function plain(text: string): string {
  if (!/[<&]/.test(text)) return squash(text);
  return squash(new DOMParser().parseFromString(text, 'text/html').body.textContent);
}

export function parsePackage(xml: string, opfPath: string): EpubPackage {
  const doc = parseXml(xml) ?? new DOMParser().parseFromString(xml, 'text/html');
  const pkg = byName(doc, 'package')[0] ?? doc.documentElement;
  const dc = (name: string) => byName(doc, name).filter((e) => e.namespaceURI === DC || e.prefix === 'dc');
  const metas = byName(doc, 'meta');
  const property = (name: string) => squash(metas.find((m) => m.getAttribute('property') === name)?.textContent);
  const uniqueId = pkg.getAttribute('unique-identifier');
  const identifiers = dc('identifier');
  const identifier = identifiers.find((e) => e.getAttribute('id') === uniqueId) ?? identifiers[0];
  const dates = dc('date');
  const date = dates.find((d) => /publication/i.test(d.getAttributeNS('*', 'event') ?? d.getAttribute('opf:event') ?? '')) ?? dates[0];

  const meta: BookMeta = {
    ...emptyMeta(),
    title: squash(dc('title')[0]?.textContent),
    creators: dc('creator').map((c) => squash(c.textContent)).filter(Boolean),
    language: squash(dc('language')[0]?.textContent),
    publisher: squash(dc('publisher')[0]?.textContent),
    date: squash(date?.textContent),
    description: plain(dc('description')[0]?.textContent ?? ''),
    identifier: squash(identifier?.textContent),
    subjects: dc('subject').map((s) => squash(s.textContent)).filter(Boolean),
    rights: squash(dc('rights')[0]?.textContent),
    modified: property('dcterms:modified'),
    series: property('belongs-to-collection') || (metas.find((m) => m.getAttribute('name') === 'calibre:series')?.getAttribute('content') ?? ''),
  };

  const manifest = new Map<string, ManifestItem>();
  for (const item of byName(doc, 'item')) {
    const href = item.getAttribute('href');
    if (!href) continue;
    manifest.set(item.getAttribute('id') ?? href, {
      path: resolvePath(opfPath, href),
      mediaType: item.getAttribute('media-type') ?? mediaTypeOf(href),
      properties: item.getAttribute('properties') ?? '',
    });
  }
  const items = [...manifest.values()];
  const fixed = property('rendition:layout') === 'pre-paginated';
  const spineEl = byName(doc, 'spine')[0];
  const spine = byName(doc, 'itemref').flatMap((ref) => {
    const item = manifest.get(ref.getAttribute('idref') ?? '');
    if (!item) return [];
    const props = ref.getAttribute('properties') ?? '';
    const own = /rendition:layout-pre-paginated/.test(props) ? true : /rendition:layout-reflowable/.test(props) ? false : fixed;
    return [{ path: item.path, mediaType: item.mediaType, fixed: own }];
  });

  const isImage = (item?: ManifestItem) => !!item && item.mediaType.startsWith('image/');
  const coverMeta = metas.find((m) => m.getAttribute('name') === 'cover')?.getAttribute('content') ?? '';
  const cover =
    items.find((i) => /\bcover-image\b/.test(i.properties))?.path ??
    (isImage(manifest.get(coverMeta)) ? manifest.get(coverMeta)!.path : undefined) ??
    items.find((i) => isImage(i) && /cover/i.test(i.path))?.path ??
    null;
  const ncxId = spineEl?.getAttribute('toc') ?? '';
  return {
    version: pkg.getAttribute('version') ?? '',
    meta,
    identifiers: identifiers.map((e) => squash(e.textContent)),
    manifest,
    spine,
    cover,
    navPath: items.find((i) => /\bnav\b/.test(i.properties))?.path ?? null,
    ncxPath: manifest.get(ncxId)?.path ?? items.find((i) => i.mediaType === 'application/x-dtbncx+xml')?.path ?? null,
    fixed,
    direction: spineEl?.getAttribute('page-progression-direction') === 'rtl' ? 'rtl' : 'ltr',
  };
}

const target = (base: string, href: string) => {
  const path = resolvePath(base, href);
  const fragment = fragmentOf(href);
  return path ? (fragment ? `${path}#${fragment}` : path) : '';
};

/** EPUB 3 navigation document: the <nav epub:type="toc"> list. */
export function parseNav(text: string, navPath: string): TocEntry[] {
  const doc = parseXml(text) ?? new DOMParser().parseFromString(text, 'text/html');
  const navs = byName(doc, 'nav');
  const type = (n: Element) => n.getAttributeNS(OPS, 'type') ?? n.getAttribute('epub:type') ?? '';
  const nav = navs.find((n) => /\btoc\b/.test(type(n))) ?? navs[0];
  const list = nav && byName(nav, 'ol')[0];
  const read = (ol: Element): TocEntry[] =>
    childrenByName(ol, 'li').map((li) => {
      const label = [...li.children].find((c) => c.localName === 'a' || c.localName === 'span');
      const sub = childrenByName(li, 'ol')[0];
      const children = sub ? read(sub) : [];
      const href = label?.getAttribute('href');
      return { label: squash(label?.textContent) || 'Untitled', target: href ? target(navPath, href) : (children[0]?.target ?? ''), children };
    });
  return list ? read(list) : [];
}

/** EPUB 2 table of contents (NCX): nested navPoints. */
export function parseNcx(text: string, ncxPath: string): TocEntry[] {
  const doc = parseXml(text);
  const map = doc && byName(doc, 'navMap')[0];
  const read = (parent: Element): TocEntry[] =>
    childrenByName(parent, 'navPoint').map((point) => {
      const label = childrenByName(point, 'navLabel')[0];
      const src = childrenByName(point, 'content')[0]?.getAttribute('src') ?? '';
      return { label: squash(label && childrenByName(label, 'text')[0]?.textContent) || 'Untitled', target: src ? target(ncxPath, src) : '', children: read(point) };
    });
  return map ? read(map) : [];
}

/** Encrypted files and their algorithm, from META-INF/encryption.xml. */
export function parseEncryption(text: string | null): Map<string, string> {
  const result = new Map<string, string>();
  const doc = text ? parseXml(text) : null;
  if (!doc) return result;
  for (const data of byName(doc, 'EncryptedData')) {
    const algorithm = byName(data, 'EncryptionMethod')[0]?.getAttribute('Algorithm') ?? '';
    const uri = byName(data, 'CipherReference')[0]?.getAttribute('URI');
    if (uri) result.set(resolvePath('', uri), algorithm);
  }
  return result;
}

/** True when anything but fonts is encrypted, or with anything but the two font obfuscation methods. */
export function hasDrm(encryption: Map<string, string>): boolean {
  return [...encryption.values()].some((a) => a !== IDPF_FONTS && a !== ADOBE_FONTS);
}

/** Key for font obfuscation: SHA-1 of the unique identifier (IDPF) or the bytes of its UUID (Adobe). */
async function obfuscationKey(algorithm: string, pkg: EpubPackage): Promise<Uint8Array | null> {
  if (algorithm === IDPF_FONTS) {
    // crypto.subtle exists only in secure contexts (https, localhost); without it the fonts are left out.
    if (!globalThis.crypto?.subtle) return null;
    const id = pkg.meta.identifier.replace(/[ \u0009\u000d\u000a]/g, '');
    return new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(id)));
  }
  const uuid = [pkg.meta.identifier, ...pkg.identifiers].map((i) => i.replace(/^urn:uuid:/i, '').replace(/-/g, '')).find((i) => /^[0-9a-f]{32}$/i.test(i));
  return uuid ? Uint8Array.from(uuid.match(/../g)!, (b) => parseInt(b, 16)) : null;
}

export async function openEpub(file: File): Promise<Book> {
  const archive = await openArchive(file);
  try {
    const entries = new Map<string, Entry>();
    const lower = new Map<string, Entry>();
    for (const e of archive.entries) {
      entries.set(e.dir + e.name, e);
      lower.set((e.dir + e.name).toLowerCase(), e);
    }
    // Some packers get the case of file names wrong in links.
    const find = (path: string) => entries.get(path) ?? lower.get(path.toLowerCase());
    const readBytes = async (path: string) => {
      const entry = find(path);
      return entry ? new Uint8Array(await (await entry.read()).arrayBuffer()) : null;
    };
    const readText = async (path: string) => {
      const bytes = await readBytes(path);
      return bytes ? decodeMarkup(bytes) : null;
    };

    const container = await readText('META-INF/container.xml');
    const containerDoc = container ? parseXml(container) : null;
    const rootfile = containerDoc && byName(containerDoc, 'rootfile').find((r) => (r.getAttribute('media-type') ?? 'application/oebps-package+xml') === 'application/oebps-package+xml');
    const opfPath = rootfile?.getAttribute('full-path') ?? [...entries.keys()].find((p) => p.toLowerCase().endsWith('.opf'));
    const opf = opfPath ? await readText(opfPath) : null;
    if (!opfPath || !opf) throw new Error('This is not an EPUB e-book: its package document (.opf) is missing.');

    const encryption = parseEncryption(await readText('META-INF/encryption.xml'));
    if (hasDrm(encryption)) throw new Error(DRM_MESSAGE);
    const pkg = parsePackage(opf, opfPath);
    if (!pkg.spine.length) throw new Error('The e-book has no chapters to show.');

    let toc: TocEntry[] = [];
    if (pkg.navPath) toc = parseNav((await readText(pkg.navPath)) ?? '', pkg.navPath);
    if (!toc.length && pkg.ncxPath) toc = parseNcx((await readText(pkg.ncxPath)) ?? '', pkg.ncxPath);

    const types = new Map([...pkg.manifest.values()].map((i) => [i.path, i.mediaType]));
    const keys = new Map<string, Promise<Uint8Array | null>>();
    return {
      format: `EPUB ${pkg.version || '2.0'}`,
      meta: pkg.meta,
      spine: pkg.spine.map((s) => ({ path: s.path, mediaType: s.mediaType, fixed: s.fixed, size: find(s.path)?.size ?? 0 })),
      toc,
      cover: pkg.cover,
      stylesheets: [...pkg.manifest.values()].filter((i) => i.mediaType === 'text/css').map((i) => i.path),
      direction: pkg.direction,
      mediaType: (path) => types.get(path) ?? mediaTypeOf(path),
      has: (path) => !!find(path),
      text: readText,
      bytes: async (path) => {
        const bytes = await readBytes(path);
        const algorithm = encryption.get(path);
        if (!bytes || !algorithm) return bytes;
        if (!keys.has(algorithm)) keys.set(algorithm, obfuscationKey(algorithm, pkg));
        const key = await keys.get(algorithm)!;
        if (!key) return null;
        const length = Math.min(bytes.length, algorithm === IDPF_FONTS ? 1040 : 1024);
        for (let i = 0; i < length; i++) bytes[i] ^= key[i % key.length];
        return bytes;
      },
      close: () => archive.close(),
    };
  } catch (error) {
    await archive.close();
    throw error;
  }
}
