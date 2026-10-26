// SPDX-License-Identifier: GPL-3.0-or-later
import { h } from './dom';

// Inside the frame: no scripts, no requests anywhere. Only inline styles and embedded (data:) images and fonts.
const FRAME_CSP = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src data:; media-src data: blob:";

/** True when the markup references remote resources that the frame will block. */
export function hasRemoteResources(html: string): boolean {
  return /\b(?:src|background|poster)\s*=\s*["']?\s*(?:https?:)?\/\//i.test(html) || /url\(\s*["']?\s*(?:https?:)?\/\//i.test(html);
}

/**
 * Shows untrusted HTML in a sandboxed frame: scripts, forms and top navigation are blocked by the
 * sandbox, every network request by the frame's own Content Security Policy. Links open in a new tab.
 */
export function sandboxedFrame(html: string, title: string): HTMLIFrameElement {
  const head = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${FRAME_CSP}"><base target="_blank">`;
  const doc = /<head[^>]*>/i.test(html)
    ? html.replace(/<head[^>]*>/i, (tag) => `${tag}${head}`)
    : `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
  const frame = h('iframe', { class: 'sandbox-frame', title, referrerPolicy: 'no-referrer' });
  // allow-popups lets links open in a new tab; without allow-scripts and allow-same-origin nothing runs.
  frame.setAttribute('sandbox', 'allow-popups allow-popups-to-escape-sandbox');
  frame.srcdoc = doc;
  return frame;
}
