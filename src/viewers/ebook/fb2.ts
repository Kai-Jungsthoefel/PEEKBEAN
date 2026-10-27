// SPDX-License-Identifier: GPL-3.0-or-later
// FictionBook 2 (.fb2): the whole book in one XML file, pictures as base64 <binary> elements. Every top-level section
// becomes an XHTML chapter, the notes a chapter of their own, so the e-book reader shows it like an EPUB.
import { type Book, type BookMeta, type TocEntry, byName, childrenByName, decodeMarkup, emptyMeta, mediaTypeOf, parseXml, squash } from './book';

const XLINK = 'http://www.w3.org/1999/xlink';
const DIR = 'fb2/';

const STYLES = `
.fb2-title { text-align: center; margin: 1.6em 0 1em; }
.fb2-subtitle { text-align: center; font-weight: bold; margin: 1em 0; }
.fb2-epigraph { margin: 1em 0 1.5em auto; max-width: 70%; font-style: italic; }
.fb2-cite { margin: 1em 2em; }
.fb2-author { text-align: right; font-style: italic; }
.fb2-poem { margin: 1em 2em; }
.fb2-stanza { margin-bottom: 1em; }
.fb2-v { margin: 0; text-indent: 0; }
.fb2-empty { margin: 0; }
.fb2-image { text-align: center; margin: 1em 0; }
.fb2-annotation { font-style: italic; }
p { margin: 0 0 .4em; text-indent: 1.5em; }
`;

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function link(el: Element): string {
  return el.getAttributeNS(XLINK, 'href') ?? el.getAttribute('l:href') ?? el.getAttribute('xlink:href') ?? el.getAttribute('href') ?? '';
}

function person(el: Element): string {
  const part = (name: string) => squash(childrenByName(el, name)[0]?.textContent);
  return [part('first-name'), part('middle-name'), part('last-name')].filter(Boolean).join(' ') || part('nickname');
}

function readMeta(root: Element): BookMeta {
  const info = byName(root, 'title-info')[0];
  const publish = byName(root, 'publish-info')[0];
  const docInfo = byName(root, 'document-info')[0];
  const text = (parent: Element | undefined, name: string) => squash(parent && childrenByName(parent, name)[0]?.textContent);
  const sequence = info && childrenByName(info, 'sequence')[0];
  return {
    ...emptyMeta(),
    title: text(info, 'book-title'),
    creators: info ? childrenByName(info, 'author').map(person).filter(Boolean) : [],
    language: text(info, 'lang'),
    publisher: text(publish, 'publisher'),
    date: (info && childrenByName(info, 'date')[0]?.getAttribute('value')) || text(info, 'date') || text(publish, 'year'),
    description: text(info, 'annotation'),
    identifier: text(publish, 'isbn') || text(docInfo, 'id'),
    subjects: info ? childrenByName(info, 'genre').map((g) => squash(g.textContent)).filter(Boolean) : [],
    series: sequence ? [sequence.getAttribute('name'), sequence.getAttribute('number')].filter(Boolean).join(' ') : '',
  };
}

export async function openFb2(file: File): Promise<Book> {
  const text = decodeMarkup(new Uint8Array(await file.arrayBuffer()));
  // Some writers use the l: or xlink: prefix without declaring it; declaring it lets the XML parser read the file.
  const doc =
    parseXml(text) ??
    parseXml(
      text.replace(/<FictionBook\b([^>]*)>/, (_, attrs: string) =>
        `<FictionBook${attrs}${['l', 'xlink'].filter((p) => !attrs.includes(`xmlns:${p}=`)).map((p) => ` xmlns:${p}="${XLINK}"`).join('')}>`,
      ),
    );
  const root = doc?.documentElement;
  if (!root || root.localName !== 'FictionBook') throw new Error('This is not a FictionBook (FB2) file, or its XML is damaged.');

  const binaries = new Map<string, { type: string; data: string }>();
  for (const bin of childrenByName(root, 'binary')) {
    const id = bin.getAttribute('id');
    if (id) binaries.set(DIR + id, { type: bin.getAttribute('content-type') ?? mediaTypeOf(id), data: bin.textContent ?? '' });
  }

  const bodies = childrenByName(root, 'body');
  const main = bodies.find((b) => !b.getAttribute('name')) ?? bodies[0];
  const notes = bodies.filter((b) => b !== main);

  // Chapters: the main body's top-level sections (what comes before them is a title page), then each notes body.
  const chapters: { path: string; nodes: Element[]; title: string; heading?: Element }[] = [];
  if (main) {
    const sections = childrenByName(main, 'section');
    const intro = [...main.children].filter((c) => c.localName !== 'section');
    if (intro.length || !sections.length) chapters.push({ path: '', nodes: intro.length ? intro : [...main.children], title: squash(childrenByName(main, 'title')[0]?.textContent) });
    for (const section of sections) chapters.push({ path: '', nodes: [section], title: squash(childrenByName(section, 'title')[0]?.textContent) });
  }
  for (const body of notes) chapters.push({ path: '', nodes: [...body.children], title: squash(childrenByName(body, 'title')[0]?.textContent) || 'Notes' });
  chapters.forEach((c, i) => (c.path = `${DIR}chapter-${i + 1}.xhtml`));

  // Links point at ids anywhere in the book; each id is looked up in its chapter.
  const where = new Map<string, string>();
  const ids = new WeakMap<Element, string>();
  let generated = 0;
  for (const chapter of chapters) {
    for (const node of chapter.nodes) {
      for (const el of [node, ...node.querySelectorAll('*')]) {
        let id = el.getAttribute('id');
        if (!id && el.localName === 'section' && childrenByName(el, 'title').length) id = `fb2-section-${++generated}`;
        if (!id) continue;
        ids.set(el, id);
        if (!where.has(id)) where.set(id, chapter.path);
      }
    }
  }
  const href = (raw: string) => {
    if (!raw.startsWith('#')) return /^(https?|mailto):/i.test(raw) ? raw : '';
    const chapter = where.get(raw.slice(1));
    return chapter ? `${chapter.slice(DIR.length)}${raw}` : '';
  };

  const convert = (node: Node, depth: number): string => {
    if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.CDATA_SECTION_NODE) return escape((node as Text).data);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const el = node as Element;
    const id = ids.get(el);
    const idAttr = id ? ` id="${escape(id)}"` : '';
    const inner = (d = depth) => [...el.childNodes].map((c) => convert(c, d)).join('');
    switch (el.localName) {
      case 'section':
        return `<section${idAttr}>${inner(depth + 1)}</section>`;
      case 'title': {
        const level = Math.min(6, Math.max(1, depth));
        const lines = [...el.children].filter((c) => c.localName === 'p').map((p) => [...p.childNodes].map((c) => convert(c, depth)).join(''));
        return `<h${level} class="fb2-title"${idAttr}>${lines.length ? lines.join('<br/>') : inner()}</h${level}>`;
      }
      case 'subtitle':
        return `<p class="fb2-subtitle"${idAttr}>${inner()}</p>`;
      case 'p':
        return `<p${idAttr}>${inner()}</p>`;
      case 'empty-line':
        return '<p class="fb2-empty">&#160;</p>';
      case 'emphasis':
        return `<em>${inner()}</em>`;
      case 'strong':
        return `<strong>${inner()}</strong>`;
      case 'strikethrough':
        return `<s>${inner()}</s>`;
      case 'sub':
      case 'sup':
      case 'code':
        return `<${el.localName}>${inner()}</${el.localName}>`;
      case 'a': {
        const target = href(link(el));
        const note = el.getAttribute('type') === 'note';
        const body = note ? `<sup>${inner()}</sup>` : inner();
        return target ? `<a href="${escape(target)}"${idAttr}>${body}</a>` : body;
      }
      case 'image': {
        const ref = link(el);
        const src = ref.startsWith('#') && binaries.has(DIR + ref.slice(1)) ? escape(ref.slice(1)) : '';
        if (!src) return '';
        const img = `<img src="${src}" alt="${escape(el.getAttribute('alt') ?? '')}"/>`;
        return el.parentElement?.localName === 'p' ? img : `<div class="fb2-image"${idAttr}>${img}</div>`;
      }
      case 'epigraph':
        return `<blockquote class="fb2-epigraph"${idAttr}>${inner()}</blockquote>`;
      case 'cite':
        return `<blockquote class="fb2-cite"${idAttr}>${inner()}</blockquote>`;
      case 'text-author':
        return `<p class="fb2-author">${inner()}</p>`;
      case 'poem':
        return `<div class="fb2-poem"${idAttr}>${inner()}</div>`;
      case 'stanza':
        return `<div class="fb2-stanza">${inner()}</div>`;
      case 'v':
        return `<p class="fb2-v">${inner()}</p>`;
      case 'date':
        return `<p class="fb2-author">${inner()}</p>`;
      case 'annotation':
        return `<div class="fb2-annotation">${inner()}</div>`;
      case 'table':
        return `<table${idAttr}>${inner()}</table>`;
      case 'tr':
        return `<tr>${inner()}</tr>`;
      case 'td':
      case 'th': {
        const span = ['colspan', 'rowspan'].map((a) => (el.getAttribute(a) && /^\d+$/.test(el.getAttribute(a)!) ? ` ${a}="${el.getAttribute(a)}"` : '')).join('');
        return `<${el.localName}${span}>${inner()}</${el.localName}>`;
      }
      default:
        return inner();
    }
  };

  const files = new Map<string, string>([[`${DIR}fb2.css`, STYLES]]);
  for (const chapter of chapters) {
    const body = chapter.nodes.map((n) => convert(n, 1)).join('');
    files.set(
      chapter.path,
      `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${escape(chapter.title)}</title>` +
        `<link rel="stylesheet" href="fb2.css"/></head><body class="fb2">${body}</body></html>`,
    );
  }

  const tocOf = (section: Element, path: string, top: boolean): TocEntry | null => {
    const title = squash(childrenByName(section, 'title')[0]?.textContent);
    const children = childrenByName(section, 'section').map((s) => tocOf(s, path, false)).filter((e): e is TocEntry => !!e);
    if (!title) return children.length === 1 ? children[0] : null;
    const id = ids.get(section);
    return { label: title, target: top || !id ? path : `${path}#${id}`, children };
  };
  const toc: TocEntry[] = chapters.flatMap((c) => {
    const section = c.nodes.length === 1 && c.nodes[0].localName === 'section' ? c.nodes[0] : null;
    const entry = section ? tocOf(section, c.path, true) : c.title ? { label: c.title, target: c.path, children: [] } : null;
    return entry ? [entry] : [];
  });

  const coverRef = byName(root, 'coverpage')[0];
  const coverImage = coverRef && byName(coverRef, 'image')[0];
  const cover = coverImage && link(coverImage).startsWith('#') ? DIR + link(coverImage).slice(1) : null;
  const decoded = new Map<string, Uint8Array>();
  return {
    format: 'FictionBook 2',
    meta: readMeta(root),
    spine: chapters.map((c) => ({ path: c.path, mediaType: 'application/xhtml+xml', size: files.get(c.path)!.length, fixed: false })),
    toc,
    cover: cover && binaries.has(cover) ? cover : null,
    stylesheets: [`${DIR}fb2.css`],
    direction: 'ltr',
    mediaType: (path) => binaries.get(path)?.type ?? mediaTypeOf(path),
    has: (path) => files.has(path) || binaries.has(path),
    text: async (path) => files.get(path) ?? null,
    bytes: async (path) => {
      const text = files.get(path);
      if (text !== undefined) return new TextEncoder().encode(text);
      const bin = binaries.get(path);
      if (!bin) return null;
      if (!decoded.has(path)) {
        try {
          decoded.set(path, Uint8Array.from(atob(bin.data.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));
        } catch {
          return null;
        }
      }
      return decoded.get(path)!;
    },
    close: async () => {},
  };
}
