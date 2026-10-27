// SPDX-License-Identifier: GPL-3.0-or-later
// One chapter of a book as DOM for a shadow root. The markup is sanitized with DOMPurify (Apache-2.0 or MPL-2.0);
// pictures and media come from the book as blob: URLs, everything else that would load from elsewhere is removed.
// Style sheets are parsed by the browser and written out again without @import, remote URLs or selectors that reach
// outside the chapter (:host). Embedded fonts are registered under names of their own, so a book cannot replace the
// fonts of the app.
import DOMPurify from 'dompurify';
import { type Book, type SpineItem, resolvePath } from './book';

export interface Chapter {
  /** An <html> element with the chapter's <body>, for the shadow root. */
  html: HTMLElement;
  sheets: CSSStyleSheet[];
  /** Page size of a fixed-layout chapter, from <meta name="viewport">. */
  viewport: { width: number; height: number } | null;
}

const XLINK = 'http://www.w3.org/1999/xlink';

const PURIFY = {
  RETURN_DOM_FRAGMENT: true as const,
  // The content goes into a shadow root, where ids cannot clobber document properties; links need the ids.
  SANITIZE_DOM: false,
  FORBID_TAGS: ['style', 'link', 'meta', 'base', 'title', 'form', 'input', 'button', 'textarea', 'select', 'option', 'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'dialog', 'template'],
  FORBID_ATTR: ['srcset', 'background', 'action', 'formaction', 'ping', 'autofocus', 'popover', 'target'],
};

// Plain black text and white backgrounds restate the defaults; they give way to the dark theme.
const BLACK = new Set(['black', '#000', '#000000', 'rgb(0, 0, 0)', 'rgba(0, 0, 0, 1)', 'windowtext']);
const WHITE = new Set(['white', '#fff', '#ffffff', 'rgb(255, 255, 255)', 'rgba(255, 255, 255, 1)', 'window']);
const NEUTRAL = new Set(['', 'inherit', 'initial', 'unset', 'revert', 'currentcolor', 'transparent', 'none']);

const URL_PATTERN = /url\(\s*(["']?)([^"')]*)\1\s*\)/gi;
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const XML_ENTITIES = new Set(['amp', 'lt', 'gt', 'quot', 'apos']);

// An inert document: style attributes parsed here load nothing.
const inert = document.implementation.createHTMLDocument('');
const entities = new Map<string, string>();

/** HTML entities like &nbsp; are not defined in XHTML without its DTD; they become numeric references. */
function numericEntities(text: string): string {
  return text.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => {
    if (XML_ENTITIES.has(name)) return whole;
    let value = entities.get(name);
    if (value === undefined) {
      const probe = inert.createElement('textarea');
      probe.innerHTML = whole;
      value = probe.value === whole ? whole : Array.from(probe.value, (c) => `&#${c.codePointAt(0)};`).join('');
      entities.set(name, value);
    }
    return value;
  });
}

function parseChapter(text: string, mediaType: string): Document {
  if (mediaType !== 'text/html') {
    const xml = new DOMParser().parseFromString(numericEntities(text), 'application/xhtml+xml');
    // Without the XHTML namespace the elements would not be HTML elements; such files are read as HTML.
    if (!xml.getElementsByTagName('parsererror').length && xml.documentElement.namespaceURI === 'http://www.w3.org/1999/xhtml') return xml;
  }
  // Not well-formed: read it as HTML, keeping XML's <a id="x"/> from swallowing what follows.
  const html = text.replace(/<([a-zA-Z][\w:-]*)(\s[^<>]*?)?\s*\/>/g, (whole, tag: string, attrs = '') => (VOID.has(tag.toLowerCase()) ? whole : `<${tag}${attrs}></${tag}>`));
  return new DOMParser().parseFromString(html, 'text/html');
}

/** Splits a selector list at the commas between selectors, not those inside :is(…) or [attr="a,b"]. */
function splitSelectors(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

export class ChapterRenderer {
  private readonly urls = new Map<string, Promise<string | null>>();
  private readonly sheets = new Map<string, Promise<CSSStyleSheet[]>>();
  /** Font family of the book (lower case) → the name it is registered under. */
  private readonly families = new Map<string, string>();
  private readonly faces: FontFace[] = [];
  private readonly created: string[] = [];
  /** The book colors text or backgrounds itself (beyond plain black on white). */
  colors = false;

  constructor(private readonly book: Book, private readonly prefix: string) {}

  /** Finds the font families the book embeds, so every style sheet can use their new names. */
  async prepare(): Promise<void> {
    for (const path of this.book.stylesheets) this.collectFamilies((await this.book.text(path)) ?? '');
  }

  private collectFamilies(css: string): void {
    for (const m of css.matchAll(/@font-face\s*\{[^}]*?font-family\s*:\s*(["']?)([^;"'}]+)\1/gi)) {
      const family = m[2].trim().toLowerCase();
      if (!this.families.has(family)) this.families.set(family, `${this.prefix}-font-${this.families.size + 1}`);
    }
  }

  /** blob: URL of a file in the book, created once. */
  resource(path: string): Promise<string | null> {
    let url = this.urls.get(path);
    if (!url) {
      url = this.book
        .bytes(path)
        .then((bytes) => {
          if (!bytes) return null;
          const created = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: this.book.mediaType(path) }));
          this.created.push(created);
          return created;
        })
        .catch(() => null);
      this.urls.set(path, url);
    }
    return url;
  }

  // ---- Style sheets ----

  private stylesheet(path: string, depth = 0): Promise<CSSStyleSheet[]> {
    let sheets = this.sheets.get(path);
    if (!sheets) {
      sheets = this.book.text(path).then((text) => (text ? this.css(text, path, depth) : []));
      this.sheets.set(path, sheets);
    }
    return sheets;
  }

  private async css(text: string, base: string, depth = 0): Promise<CSSStyleSheet[]> {
    const result: CSSStyleSheet[] = [];
    // Local @imports become sheets of their own (their URLs are relative to them); remote ones are dropped.
    const imports: string[] = [];
    const body = text.replace(/@import\s+(?:url\(\s*)?(["']?)([^"')\s;]+)\1\s*\)?[^;]*;?/gi, (_, _q, href: string) => {
      const path = resolvePath(base, href);
      if (path) imports.push(path);
      return '';
    });
    if (depth < 4) for (const path of imports) result.push(...(await this.stylesheet(path, depth + 1)));
    this.collectFamilies(body);

    const parsed = new CSSStyleSheet();
    try {
      parsed.replaceSync(body);
    } catch {
      return result;
    }
    // Pictures used by the rules are unpacked first, then every rule is written out again in one pass.
    const paths = new Set<string>();
    const collect = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) {
          for (const m of rule.style.cssText.matchAll(URL_PATTERN)) paths.add(resolvePath(base, m[2]));
        } else if (rule instanceof CSSGroupingRule) {
          collect(rule.cssRules);
        }
      }
    };
    collect(parsed.cssRules);
    const urls = new Map(await Promise.all([...paths].filter(Boolean).map(async (p) => [p, await this.resource(p)] as const)));
    const out = new CSSStyleSheet();
    out.replaceSync(this.rules(parsed.cssRules, base, urls));
    result.push(out);
    return result;
  }

  private rules(list: CSSRuleList, base: string, urls: Map<string, string | null>): string {
    let out = '';
    for (const rule of list) {
      if (rule instanceof CSSStyleRule) {
        // :host would style the element around the chapter, ::part and ::slotted reach out of it.
        const selectors = splitSelectors(rule.selectorText).filter((s) => !/:host|::slotted|::part/i.test(s)).map((s) => s.replace(/:root\b/g, 'html'));
        if (!selectors.length) continue;
        const links = selectors.every((s) => /(?:^|[\s>+~])a(?![\w-])[^\s>+~]*$/i.test(s));
        const declarations = this.declarations(rule.style, base, urls, links);
        if (declarations) out += `${selectors.join(',')}{${declarations}}`;
      } else if (rule instanceof CSSMediaRule) {
        out += `@media ${rule.conditionText}{${this.rules(rule.cssRules, base, urls)}}`;
      } else if (rule instanceof CSSSupportsRule) {
        out += `@supports ${rule.conditionText}{${this.rules(rule.cssRules, base, urls)}}`;
      } else if (rule instanceof CSSFontFaceRule) {
        this.fontFace(rule, base);
      } else if (rule instanceof CSSKeyframesRule && !rule.cssText.includes('url(')) {
        out += rule.cssText;
      }
      // @page, @namespace, @property, @layer and the like are left out.
    }
    return out;
  }

  /** Declarations with resolved URLs, renamed fonts and rem in the reader's text size. */
  private declarations(style: CSSStyleDeclaration, base: string, urls: Map<string, string | null>, links: boolean): string {
    let out = '';
    for (let i = 0; i < style.length; i++) {
      const property = style[i];
      let value = style.getPropertyValue(property);
      if (property === 'color' || property === 'background-color') {
        const plainValue = value.trim().toLowerCase();
        // Links follow the reader's theme.
        if (links && property === 'color') continue;
        if ((property === 'color' && BLACK.has(plainValue)) || (property === 'background-color' && WHITE.has(plainValue))) continue;
        if (!NEUTRAL.has(plainValue)) this.colors = true;
      }
      if (/image-set\(|element\(/i.test(value)) continue;
      if (value.includes('url(')) {
        let ok = true;
        value = value.replace(URL_PATTERN, (whole, _q, href: string) => {
          // References inside the document (SVG filters, masks) and embedded pictures stay.
          if (href.startsWith('#') || /^data:image\//i.test(href)) return whole;
          const url = urls.get(resolvePath(base, href));
          if (!url) ok = false;
          return `url("${url}")`;
        });
        if (!ok) continue;
      }
      if (property === 'font-family') value = this.renameFamilies(value);
      value = value.replace(/(-?(?:\d+\.?\d*|\.\d+))rem\b/gi, 'calc($1 * var(--ebook-rem, 1em))');
      out += `${property}:${value}${style.getPropertyPriority(property) ? ' !important' : ''};`;
    }
    return out;
  }

  private renameFamilies(value: string): string {
    return splitSelectors(value)
      .map((f) => {
        const own = this.families.get(f.replace(/^["']|["']$/g, '').trim().toLowerCase());
        return own ? `"${own}"` : f;
      })
      .join(', ');
  }

  /** Embedded fonts load from their bytes (no request) under the book's own family name. */
  private fontFace(rule: CSSFontFaceRule, base: string): void {
    const style = rule.style;
    const name = this.families.get(style.getPropertyValue('font-family').replace(/^["']|["']$/g, '').trim().toLowerCase());
    if (!name) return;
    const src = [...style.getPropertyValue('src').matchAll(URL_PATTERN)].map((m) => resolvePath(base, m[2])).find((p) => p && this.book.has(p));
    if (!src) return;
    const descriptors: FontFaceDescriptors = {};
    for (const [key, property] of [['weight', 'font-weight'], ['style', 'font-style'], ['stretch', 'font-stretch'], ['unicodeRange', 'unicode-range']] as const) {
      const value = style.getPropertyValue(property);
      if (value) descriptors[key] = value;
    }
    void this.book
      .bytes(src)
      .then((bytes) => {
        if (!bytes) return;
        const face = new FontFace(name, bytes as Uint8Array<ArrayBuffer>, descriptors);
        this.faces.push(face);
        document.fonts.add(face);
        return face.load();
      })
      // A damaged or unsupported font: the text keeps the fallback font.
      .catch(() => {});
  }

  // ---- Chapters ----

  async chapter(item: SpineItem): Promise<Chapter> {
    const isPicture = item.mediaType.startsWith('image/');
    const text = isPicture
      ? `<html xmlns="http://www.w3.org/1999/xhtml"><body><img src="${encodeURI(item.path.split('/').pop()!)}" alt=""/></body></html>`
      : ((await this.book.text(item.path)) ?? '');
    const doc = parseChapter(text, item.mediaType);

    const sheets: CSSStyleSheet[] = [];
    for (const el of doc.querySelectorAll('link, style')) {
      if (el.localName === 'style') {
        sheets.push(...(await this.css(el.textContent ?? '', item.path)));
        continue;
      }
      const rel = el.getAttribute('rel') ?? '';
      const path = resolvePath(item.path, el.getAttribute('href') ?? '');
      if (/\bstylesheet\b/i.test(rel) && !/\balternate\b/i.test(rel) && path) sheets.push(...(await this.stylesheet(path)));
    }
    const viewportMeta = [...doc.querySelectorAll('meta')].find((m) => m.getAttribute('name') === 'viewport')?.getAttribute('content') ?? '';
    const width = Number(/width\s*=\s*(\d+)/.exec(viewportMeta)?.[1]);
    const height = Number(/height\s*=\s*(\d+)/.exec(viewportMeta)?.[1]);

    const html = document.createElement('html');
    const body = document.createElement('body');
    html.append(body);
    const sourceBody = doc.body ?? doc.getElementsByTagName('body')[0];
    if (sourceBody) {
      const fragment = DOMPurify.sanitize(sourceBody, PURIFY);
      await this.resources(fragment, item.path);
      body.append(fragment);
      for (const [from, to] of [[doc.documentElement, html], [sourceBody, body]] as const) {
        const lang = from.getAttribute('lang') ?? from.getAttribute('xml:lang');
        if (lang) to.lang = lang;
        const dir = from.getAttribute('dir');
        if (dir === 'rtl' || dir === 'ltr') to.dir = dir;
        const className = from.getAttribute('class');
        if (className) to.className = className;
      }
      const id = sourceBody.getAttribute('id');
      if (id) body.id = id;
      const style = sourceBody.getAttribute('style');
      if (style) {
        const probe = inert.createElement('div');
        probe.setAttribute('style', style);
        const urls = await this.preload([probe], item.path);
        body.setAttribute('style', this.declarations(probe.style, item.path, urls, false));
      }
    }
    return { html, sheets, viewport: width > 0 && height > 0 ? { width, height } : null };
  }

  /** Unpacks the pictures that style attributes refer to. */
  private async preload(elements: Element[], base: string): Promise<Map<string, string | null>> {
    const paths = new Set<string>();
    for (const el of elements) {
      for (const m of (el.getAttribute('style') ?? '').matchAll(URL_PATTERN)) paths.add(resolvePath(base, m[2]));
    }
    return new Map(await Promise.all([...paths].filter(Boolean).map(async (p) => [p, await this.resource(p)] as const)));
  }

  /** Points pictures and media at blob: URLs of the book's files; drops whatever is not in the book. */
  private async resources(fragment: DocumentFragment, base: string): Promise<void> {
    const jobs: Promise<void>[] = [];
    const point = (el: Element, attribute: string, namespace: string | null = null) => {
      const value = (namespace ? el.getAttributeNS(namespace, 'href') : el.getAttribute(attribute))?.trim() ?? '';
      if (/^data:(image|audio|video)\//i.test(value) || (attribute !== 'src' && attribute !== 'poster' && value.startsWith('#'))) return;
      const path = resolvePath(base, value);
      const remove = () => (namespace ? el.removeAttributeNS(namespace, 'href') : el.removeAttribute(attribute));
      if (!path || !this.book.has(path)) {
        remove();
        return;
      }
      jobs.push(
        this.resource(path).then((url) => {
          if (!url) remove();
          else if (namespace) el.setAttributeNS(namespace, 'xlink:href', url);
          else el.setAttribute(attribute, url);
        }),
      );
    };
    const styled: Element[] = [];
    for (const el of fragment.querySelectorAll('*')) {
      for (const attribute of ['src', 'poster']) if (el.hasAttribute(attribute)) point(el, attribute);
      if (el.namespaceURI === 'http://www.w3.org/2000/svg' && el.localName !== 'a') {
        if (el.hasAttributeNS(XLINK, 'href')) point(el, 'xlink:href', XLINK);
        if (el.hasAttribute('href')) point(el, 'href');
      }
      if (el.hasAttribute('style')) styled.push(el);
    }
    const urls = await this.preload(styled, base);
    for (const el of styled) {
      const style = (el as HTMLElement).style;
      if (style) el.setAttribute('style', this.declarations(style, base, urls, false));
    }
    await Promise.all(jobs);
  }

  dispose(): void {
    for (const face of this.faces) document.fonts.delete(face);
    for (const url of this.created) URL.revokeObjectURL(url);
  }
}
