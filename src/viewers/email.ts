// SPDX-License-Identifier: GPL-3.0-or-later
// E-mails: .eml and Outlook .msg, read by email/read.ts (also used by the converter).
import { formatBytes } from '../core/bytes';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { hasRemoteResources, sandboxedFrame } from '../core/sandbox';
import type { ViewerContext } from '../core/types';
import { formatMailboxes, picturesInBody, readMail, resolveInlineImages } from './email/read';

function download(file: File): void {
  const url = URL.createObjectURL(file);
  h('a', { href: url, download: file.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function mount({ file, container, toolbar, openFile, progress }: ViewerContext) {
  progress('Reading e-mail …');
  const mail = await readMail(file.name, await file.arrayBuffer());

  const field = (label: string, value: string) => (value ? h('div', { class: 'mail-field' }, h('span', { class: 'c3' }, label), h('span', {}, value)) : null);
  const header = h(
    'div',
    { class: 'mail-head' },
    h('h2', {}, mail.subject || '(no subject)'),
    field('From', formatMailboxes(mail.from)),
    field('To', formatMailboxes(mail.to)),
    field('Cc', formatMailboxes(mail.cc)),
    field('Date', mail.date ? mail.date.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' }) : ''),
  );

  const usedInline = picturesInBody(mail);
  // Messages attached to an Outlook message are not listed.
  const listed = mail.attachments.filter((a) => !usedInline.has(a) && !a.message);
  if (listed.length) {
    header.append(
      h(
        'div',
        { class: 'mail-attachments' },
        ...listed.map((a) => {
          const asFile = () => new File([a.data as Uint8Array<ArrayBuffer>], a.name, { type: a.mimeType });
          return h(
            'div',
            { class: 'chip' },
            icon('paperclip', 13),
            h('button', { type: 'button', class: 'chip-name', title: 'Open in a new tab', onclick: () => openFile(asFile()) }, a.name),
            h('span', { class: 'c3' }, formatBytes(a.data.length)),
            h('button', { type: 'button', class: 'ibtn s', title: 'Save', 'aria-label': `Save ${a.name}`, onclick: () => download(asFile()) }, icon('download', 13)),
          );
        }),
      ),
    );
  }

  // Outlook messages may keep their formatted text only as compressed RTF; the converter's reader takes it out.
  let { html, text } = mail;
  if (!html && mail.outlook?.compressedRtf) {
    progress('Reading the formatted text …');
    ({ html, text } = await (await import('../convert/email/body')).bodyOf(mail));
  }

  container.classList.add('mail');
  container.append(header);
  if (html) {
    if (hasRemoteResources(html)) {
      container.append(h('div', { class: 'banner' }, 'External images and content were blocked. They would tell the sender that the e-mail was opened.'));
    }
    container.append(sandboxedFrame(resolveInlineImages(html, mail.attachments), 'E-mail content'));
  } else {
    container.append(h('pre', { class: 'mail-text' }, text ?? ''));
  }

  if (listed.length) toolbar.append(h('span', { class: 'meta' }, `${listed.length} ${listed.length === 1 ? 'attachment' : 'attachments'}`));
  return { destroy: () => {} };
}
