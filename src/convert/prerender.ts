// SPDX-License-Identifier: GPL-3.0-or-later
// The converter's pages as the build writes them (vite.config.ts): title, description and a plain version of the
// content for search engines and for browsers without JavaScript. The page script replaces that content on load.
import { CONVERTERS, PAIRS, pairPage, type ConversionPair } from './catalog';
import { formatPageFor, formatPagePath } from '../format-pages';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ESCAPES[c]);

export function pageTitle(pair: ConversionPair | null): string {
  return pair
    ? `${pair.source.label} to ${pair.target.label} converter: free, private, no upload | Peekbean`
    : 'File converter: free, private, no upload | Peekbean';
}

export function pageDescription(pair: ConversionPair | null): string {
  return pair
    ? `Convert ${pair.source.label} to ${pair.target.label} in your browser. Free and open source: files are converted on your device and never uploaded.`
    : 'Convert images, PDFs, spreadsheets, 3D models and CAD drawings in your browser. Free and open source: files never leave your device.';
}

const link = (pair: ConversionPair) => `<li><a href="${pairPage(pair)}">${escape(pair.source.label)} to ${escape(pair.target.label)}</a></li>`;

function content(pair: ConversionPair | null): string {
  const intro = pair
    ? `<h1>Convert ${escape(pair.source.label)} to ${escape(pair.target.label)}</h1><p>${escape(pageDescription(pair))}</p>` +
      [pair.source.note, pair.target.loss].filter(Boolean).map((note) => `<p>${escape(note!)}</p>`).join('')
    : `<h1>File converter</h1><p>${escape(pageDescription(null))}</p>`;
  // A conversion's page links its neighbors: the same file type to other formats, other file types to the same one.
  const lists = pair
    ? `<h2>Related conversions</h2><ul>${PAIRS.filter((p) => p !== pair && p.converter === pair.converter && (p.source === pair.source || p.target === pair.target)).map(link).join('')}</ul>` +
      `<p><a href="convert.html">All conversions</a>${viewerLink(pair)}</p>`
    : CONVERTERS.map((c) => `<h2>${escape(c.label)}</h2><ul>${PAIRS.filter((p) => p.converter === c).map(link).join('')}</ul>`).join('');
  return `<main class="prerender">${intro}<noscript><p>The converter runs in your browser and needs JavaScript.</p></noscript>${lists}</main>`;
}

/** The viewer's page of the source format, for those who only want to look at their file. */
function viewerLink(pair: ConversionPair): string {
  const page = formatPageFor(pair.source.extensions);
  return page ? ` · <a href="${formatPagePath(page)}">View ${escape(page.label)} files</a>` : '';
}

function replaceOnce(html: string, pattern: RegExp, replacement: string): string {
  if (!pattern.test(html)) throw new Error(`convert.html has no match for ${pattern}; the converter pages cannot be written.`);
  return html.replace(pattern, () => replacement);
}

/** convert.html turned into the page of one conversion, or into the general converter page for `null`. */
export function converterPageHtml(html: string, pair: ConversionPair | null): string {
  const title = escape(pageTitle(pair));
  const description = escape(pageDescription(pair));
  html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${title}</title>`);
  html = replaceOnce(html, /<meta name="description" content="[^"]*"/, `<meta name="description" content="${description}"`);
  html = replaceOnce(html, /<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${title}"`);
  html = replaceOnce(html, /<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${description}"`);
  html = replaceOnce(html, /<html lang="en"[^>]*>/, pair ? `<html lang="en" data-convert="${pair.slug}">` : '<html lang="en">');
  if (pair && !pair.indexed) html = replaceOnce(html, /<\/head>/, '  <meta name="robots" content="noindex" />\n  </head>');
  return replaceOnce(html, /<!--prerender-->[\s\S]*?<!--\/prerender-->/, `<!--prerender-->${content(pair)}<!--/prerender-->`);
}
