// SPDX-License-Identifier: GPL-3.0-or-later
// Links to the project on GitHub. Issue links carry only the format, viewer and version, never the file name or its
// content: GitHub receives the link as soon as it opens, before anyone presses "Submit".
import { extensionOf } from './core/bytes';
import { hexViewer, textViewer } from './core/registry';
import type { ViewerDefinition } from './core/types';

/** Repository home; empty when package.json names no repository, and then every GitHub link is left out. */
export const REPO_URL = __SOURCE_URL__;

/** The exact source of this build, which the GPL asks to offer. */
export const SOURCE_URL = REPO_URL && `${REPO_URL}/tree/${__GIT_COMMIT__}`;

/**
 * New issue, filled in: a format request on the start page and for files no viewer knows (shown as text or hex),
 * a problem report otherwise. `title` is the tooltip for the link.
 */
export function issueLink(file?: File, detected?: ViewerDefinition, shown?: ViewerDefinition): { href: string; title: string } {
  const ext = file ? extensionOf(file.name) : '';
  const format = ext ? `.${ext}` : 'files without extension';
  const request = !file || detected === textViewer || detected === hexViewer;
  const heading = !file ? 'Format request: ' : request ? `Format request: ${format}` : `Problem with ${format}${detected ? ` (${detected.label})` : ''}`;
  const ask = request
    ? 'Which program makes these files, and what would you like to see? A sample file you may share helps a lot.'
    : 'What went wrong, and what did you expect? A sample file you may share helps a lot.';
  const facts = [
    file && `Format: ${format}${detected ? `, detected as ${detected.label}` : ''}`,
    shown && shown !== detected && `Shown as: ${shown.label}`,
  ];
  return newIssue(heading, ask, facts, request ? 'Suggest a format on GitHub' : 'Report a problem with this file type on GitHub');
}

/**
 * New issue about the converter, filled in the same way: a converter request without a conversion (on the start
 * page, for files no converter takes), a problem report for a conversion otherwise, with its formats and options.
 */
export function conversionIssueLink(file?: File, kind?: string, conversion?: { from: string; to: string; options: string[] }): { href: string; title: string } {
  const ext = file ? extensionOf(file.name) : '';
  const format = ext ? `.${ext}` : 'files without extension';
  const heading = conversion ? `Problem converting ${conversion.from} to ${conversion.to}` : file ? `Converter request: ${format}${kind ? ` (${kind})` : ''}` : 'Converter request: ';
  const ask = conversion
    ? 'What went wrong, and what did you expect? A sample file you may share helps a lot.'
    : 'Which format should these files become, and what for? A sample file you may share helps a lot.';
  const facts = [
    file && `Format: ${format}${kind ? `, detected as ${kind}` : ''}`,
    conversion && `Conversion: ${conversion.from} to ${conversion.to}${conversion.options.length ? ` (${conversion.options.join(', ')})` : ''}`,
  ];
  return newIssue(heading, ask, facts, conversion ? 'Report a problem with this conversion on GitHub' : 'Suggest a converter on GitHub');
}

function newIssue(heading: string, ask: string, facts: (string | false | undefined)[], title: string): { href: string; title: string } {
  const lines = [...facts, `Version: ${__APP_VERSION__} (${__GIT_COMMIT__})`].filter(Boolean);
  const body = `<!-- ${ask} -->\n\n\n---\n${lines.join('\n')}\n`;
  return { href: `${REPO_URL}/issues/new?${new URLSearchParams({ title: heading, body })}`, title };
}
