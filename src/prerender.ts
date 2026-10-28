// SPDX-License-Identifier: GPL-3.0-or-later
// The viewer's pages as the build writes them (vite.config.ts): title, description and a plain version of the content
// for search engines and for browsers without JavaScript. The page script replaces that content on load.
import { pairPage } from './convert/catalog';
import { CATEGORY_TITLES, FORMAT_PAGES, formatConversions, formatPageName, formatPagePath, type FormatPage } from './format-pages';
import type { FormatCategory } from './core/types';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ESCAPES[c]);

export function pageTitle(page: FormatPage | null): string {
  return page ? `${formatPageName(page)}: free, private, no upload | Peekbean` : 'File viewer for any format: free, private, no upload | Peekbean';
}

export function pageDescription(page: FormatPage | null): string {
  return page
    ? `Open ${page.noun} in your browser. Free and open source: files are opened on your device and never uploaded.`
    : 'View PDFs, Office documents, CAD drawings, 3D models, photos and hundreds of other formats in your browser. Free and open source: files never leave your device.';
}

const link = (page: FormatPage) => `<li><a href="${formatPagePath(page)}">${escape(formatPageName(page))}</a></li>`;

function content(page: FormatPage | null): string {
  const intro = page
    ? `<h1>View ${escape(page.label)} files</h1><p>${escape(pageDescription(page))}</p>` +
      (page.limits ? `<p>${escape(page.limits)}</p>` : '') +
      `<h2>About ${escape(page.label)} files</h2><p>${escape(page.about)}</p><ul>${page.features.map((f) => `<li>${escape(f)}</li>`).join('')}</ul>`
    : `<h1>File viewer</h1><p>${escape(pageDescription(null))}</p>`;
  const conversions = page ? formatConversions(page) : [];
  const convert = conversions.length
    ? `<h2>Convert ${escape(page!.label)} files</h2><ul>${conversions.map((p) => `<li><a href="${pairPage(p)}">${escape(p.source.label)} to ${escape(p.target.label)}</a></li>`).join('')}</ul>`
    : '';
  // Every page links all formats, grouped as on the start page, so each is reachable from any other.
  const lists = (Object.keys(CATEGORY_TITLES) as FormatCategory[])
    .map((category) => `<h2>${CATEGORY_TITLES[category]}</h2><ul>${FORMAT_PAGES.filter((p) => p.category === category && p !== page).map(link).join('')}</ul>`)
    .join('');
  const more = `<p><a href="./">All formats</a> · <a href="convert.html">File converter</a></p>`;
  return `<main class="prerender">${intro}<noscript><p>The viewer runs in your browser and needs JavaScript.</p></noscript>${convert}${lists}${more}</main>`;
}

function replaceOnce(html: string, pattern: RegExp, replacement: string): string {
  if (!pattern.test(html)) throw new Error(`index.html has no match for ${pattern}; the viewer pages cannot be written.`);
  return html.replace(pattern, () => replacement);
}

/** index.html turned into the page of one format, or into the general start page for `null`. */
export function viewerPageHtml(html: string, page: FormatPage | null): string {
  const title = escape(pageTitle(page));
  const description = escape(pageDescription(page));
  html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${title}</title>`);
  html = replaceOnce(html, /<meta name="description" content="[^"]*"/, `<meta name="description" content="${description}"`);
  html = replaceOnce(html, /<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${title}"`);
  html = replaceOnce(html, /<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${description}"`);
  html = replaceOnce(html, /<html lang="en"[^>]*>/, page ? `<html lang="en" data-view="${page.slug}">` : '<html lang="en">');
  return replaceOnce(html, /<!--prerender-->[\s\S]*?<!--\/prerender-->/, `<!--prerender-->${content(page)}<!--/prerender-->`);
}
