// SPDX-License-Identifier: GPL-3.0-or-later
// A message as a web page of its own: a header block, then the body. Mail HTML is untrusted: it is sanitized with
// DOMPurify (Apache-2.0 or MPL-2.0), pictures from elsewhere lose their address, and the page's Content Security
// Policy lets it load nothing at all, so a tracking pixel stays silent whenever the file is opened later.
// Pictures of the message itself (cid:) become data: URLs.
import DOMPurify from 'dompurify';
import { formatBytes } from '../../core/bytes';
import { dataUrl, formatMailboxes, picturesInBody, type Mail, type MailAttachment } from '../../viewers/email/read';
import type { Body } from './body';

const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:; form-action 'none'; base-uri 'none'";

const PURIFY = {
  WHOLE_DOCUMENT: true,
  RETURN_DOM: true as const,
  FORBID_TAGS: ['form', 'input', 'button', 'textarea', 'select', 'option', 'base', 'meta', 'link', 'title', 'iframe', 'frame', 'frameset', 'object', 'embed', 'portal', 'dialog', 'template'],
  FORBID_ATTR: ['srcset', 'action', 'formaction', 'ping', 'autofocus', 'popover'],
};

const REMOTE = /^\s*(?:https?:)?\/\//i;
// Also taken out of style sheets, for programs that open the page without heeding its Content Security Policy.
const REMOTE_URL = /url\(\s*(["']?)\s*(?:https?:)?\/\/[^)]*?\1\s*\)/gi;
const IMPORT = /@import\b[^;]*;?/gi;

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

// The header block resets whatever the message's style sheet says about its elements.
const HEAD_CSS = `
#opsis-mail-head, #opsis-mail-head * { all: revert; }
#opsis-mail-head { display: block; box-sizing: border-box; margin: 0 0 16px; padding: 16px 20px; background: #fff; color: #1b1e23; border-bottom: 1px solid #d9dce1; font: 14px/1.45 system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif; text-align: left; color-scheme: light; }
#opsis-mail-head h1 { margin: 0 0 10px; font-size: 20px; line-height: 1.3; font-weight: 600; overflow-wrap: anywhere; }
#opsis-mail-head table { border-collapse: collapse; }
#opsis-mail-head th { padding: 2px 14px 2px 0; text-align: left; vertical-align: top; font-weight: 400; color: #5b636e; white-space: nowrap; }
#opsis-mail-head td { padding: 2px 0; overflow-wrap: anywhere; }
#opsis-mail-head p { margin: 10px 0 0; font-size: 12px; color: #5b636e; }
#opsis-mail-text { box-sizing: border-box; margin: 0; padding: 0 20px 20px; white-space: pre-wrap; overflow-wrap: anywhere; font: 13px/1.5 ui-monospace, Consolas, monospace; }`;

const DATE_FORMAT: Intl.DateTimeFormatOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' };

function decodeCid(cid: string): string {
  try {
    return decodeURIComponent(cid);
  } catch {
    return cid;
  }
}

interface Sanitized {
  styles: string;
  bodyAttributes: string;
  body: string;
  blocked: number;
}

function sanitize(html: string, attachments: MailAttachment[]): Sanitized {
  const purify = DOMPurify(window);
  let blocked = 0;
  purify.addHook('afterSanitizeAttributes', (node) => {
    const link = node.tagName === 'A' || node.tagName === 'AREA';
    // href only where it loads something: pictures of SVG (<image>, <use>, <feImage>), not links.
    for (const name of ['src', 'background', 'poster', ...(link ? [] : ['href', 'xlink:href'])]) {
      const value = node.getAttribute(name);
      if (value && REMOTE.test(value)) {
        node.setAttribute(`data-blocked-${name.replace(':', '-')}`, value);
        node.removeAttribute(name);
        blocked++;
      }
    }
    if (link && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  const root = purify.sanitize(html, PURIFY) as HTMLElement;

  const byCid = new Map(attachments.filter((a) => a.contentId).map((a) => [a.contentId!, a]));
  const resolve = (url: string) => {
    const match = /^\s*cid:(.+?)\s*$/i.exec(url);
    const attachment = match ? byCid.get(decodeCid(match[1])) : undefined;
    return attachment ? dataUrl(attachment) : null;
  };
  const css = (text: string) =>
    text
      .replace(IMPORT, () => {
        blocked++;
        return '';
      })
      .replace(REMOTE_URL, () => {
        blocked++;
        return 'url("data:,")';
      })
      .replace(/url\(\s*(["']?)\s*cid:([^"')\s]+)\s*\1\s*\)/gi, (match, _quote, cid: string) => {
        const url = resolve(`cid:${cid}`);
        return url ? `url("${url}")` : match;
      });
  for (const el of root.querySelectorAll('[src], [background]')) {
    for (const name of ['src', 'background']) {
      const url = resolve(el.getAttribute(name) ?? '');
      if (url) el.setAttribute(name, url);
    }
  }
  for (const el of root.querySelectorAll<HTMLElement>('[style]')) el.setAttribute('style', css(el.getAttribute('style')!));
  for (const style of root.querySelectorAll('style')) style.textContent = css(style.textContent ?? '');

  const head = root.querySelector('head');
  const body = root.querySelector('body');
  const styles = [...(head?.querySelectorAll('style') ?? [])].map((s) => s.outerHTML).join('\n');
  const bodyAttributes = [...(body?.attributes ?? [])].map((a) => ` ${a.name}="${escapeHtml(a.value)}"`).join('');
  return { styles, bodyAttributes, body: body?.innerHTML ?? '', blocked };
}

/** The page as HTML text, and how many remote pictures and style sheet links were blocked. */
export function mailPage(mail: Mail, body: Body): { html: string; blocked: number } {
  const content = body.html !== null ? sanitize(body.html, mail.attachments) : null;
  const shown = picturesInBody({ html: body.html, attachments: mail.attachments });
  const attachments = mail.attachments.filter((a) => !shown.has(a));

  const row = (label: string, value: string) => (value ? `<tr><th>${label}</th><td>${escapeHtml(value)}</td></tr>` : '');
  const rows = [
    row('From', formatMailboxes(mail.from)),
    row('To', formatMailboxes(mail.to)),
    row('Cc', formatMailboxes(mail.cc)),
    row('Bcc', formatMailboxes(mail.bcc)),
    row('Date', mail.date ? mail.date.toLocaleString('en-US', DATE_FORMAT) : ''),
    row('Attachments', attachments.map((a) => `${a.name} (${formatBytes(a.data.length)})`).join(', ')),
  ].join('');
  const notes = [
    attachments.length > 0 && 'The attachments are not part of this page.',
    content && content.blocked > 0 && 'External images and content were blocked. They would tell the sender that the e-mail was opened.',
  ].filter(Boolean);
  const subject = mail.subject || '(no subject)';
  const head = `<header id="opsis-mail-head"><h1>${escapeHtml(subject)}</h1><table>${rows}</table>${notes.map((n) => `<p>${n}</p>`).join('')}</header>`;

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(subject)}</title>
<style>${HEAD_CSS}
</style>
${content?.styles ?? ''}
</head>
<body${content?.bodyAttributes ?? ''}>
${head}
${content ? content.body : `<pre id="opsis-mail-text">${escapeHtml(body.text ?? '')}</pre>`}
</body>
</html>
`;
  return { html, blocked: content?.blocked ?? 0 };
}
