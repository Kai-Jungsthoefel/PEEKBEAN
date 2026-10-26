// SPDX-License-Identifier: GPL-3.0-or-later
// E-mails: .eml via postal-mime (MIT-0), Outlook .msg via msgreader (Apache-2.0).
import PostalMime from 'postal-mime';
import MsgReader from '@kenjiuno/msgreader';
import { extensionOf, formatBytes, startsWith } from '../core/bytes';
import { h } from '../core/dom';
import { icon } from '../core/icons';
import { hasRemoteResources, sandboxedFrame } from '../core/sandbox';
import type { ViewerContext } from '../core/types';

interface MailAttachment {
  name: string;
  mimeType: string;
  data: Uint8Array;
  contentId?: string;
  inline: boolean;
}

interface Mail {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  date: Date | null;
  html: string | null;
  text: string | null;
  attachments: MailAttachment[];
}

const toBytes = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === 'string' ? new TextEncoder().encode(content) : content instanceof Uint8Array ? content : new Uint8Array(content);

type Address = NonNullable<Awaited<ReturnType<typeof PostalMime.parse>>['from']>;

function formatAddress(address: Address): string[] {
  if (address.group) return address.group.flatMap(formatAddress);
  return [address.name ? `${address.name} <${address.address}>` : address.address];
}

async function parseEml(file: File): Promise<Mail> {
  const email = await PostalMime.parse(await file.arrayBuffer());
  const date = email.date ? new Date(email.date) : null;
  return {
    subject: email.subject ?? '',
    from: email.from ? formatAddress(email.from).join(', ') : '',
    to: (email.to ?? []).flatMap(formatAddress),
    cc: (email.cc ?? []).flatMap(formatAddress),
    date: date && !Number.isNaN(date.getTime()) ? date : null,
    html: email.html ?? null,
    text: email.text ?? null,
    attachments: email.attachments.map((a, i) => ({
      name: a.filename ?? `anhang-${i + 1}`,
      mimeType: a.mimeType,
      data: toBytes(a.content),
      contentId: a.contentId?.replace(/^<|>$/g, ''),
      inline: a.disposition === 'inline' || Boolean(a.related),
    })),
  };
}

function parseMsg(buffer: ArrayBuffer): Mail {
  const reader = new MsgReader(buffer);
  const data = reader.getFileData();
  if (data.error) throw new Error(`The Outlook message is damaged: ${data.error}`);
  const recipients = (type: string) =>
    (data.recipients ?? [])
      .filter((r) => (r.recipType ?? 'to') === type)
      .map((r) => {
        const address = r.smtpAddress ?? r.email ?? '';
        return r.name && r.name !== address ? `${r.name} <${address}>` : address;
      });
  const html = data.bodyHtml ?? (data.html ? new TextDecoder().decode(data.html) : null);
  const time = data.messageDeliveryTime ?? data.clientSubmitTime ?? data.creationTime;
  return {
    subject: data.subject ?? '',
    from: data.senderName ? `${data.senderName}${data.senderEmail ? ` <${data.senderEmail}>` : ''}` : (data.senderEmail ?? ''),
    to: recipients('to'),
    cc: recipients('cc'),
    date: time ? new Date(time) : null,
    html,
    text: data.body ?? null,
    attachments: (data.attachments ?? [])
      .filter((a) => !a.innerMsgContent)
      .map((a) => {
        const attachment = reader.getAttachment(a);
        return {
          name: attachment.fileName,
          mimeType: a.attachMimeTag ?? 'application/octet-stream',
          data: attachment.content,
          contentId: a.pidContentId,
          inline: Boolean(a.attachmentHidden),
        };
      }),
  };
}

const toDataUrl = (a: MailAttachment) => {
  let binary = '';
  for (let i = 0; i < a.data.length; i += 0x8000) binary += String.fromCharCode(...a.data.subarray(i, i + 0x8000));
  return `data:${a.mimeType};base64,${btoa(binary)}`;
};

/** Inline images (cid:) become data: URLs, the only kind of image the frame may load. */
function resolveInlineImages(html: string, attachments: MailAttachment[]): string {
  const byCid = new Map(attachments.filter((a) => a.contentId).map((a) => [a.contentId!, a]));
  return html.replace(/cid:([^"'\s)>]+)/gi, (match, cid: string) => {
    const attachment = byCid.get(decodeURIComponent(cid));
    return attachment ? toDataUrl(attachment) : match;
  });
}

function download(file: File): void {
  const url = URL.createObjectURL(file);
  h('a', { href: url, download: file.name }).click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function mount({ file, container, toolbar, openFile, progress }: ViewerContext) {
  progress('Reading e-mail …');
  const buffer = await file.arrayBuffer();
  const isMsg = extensionOf(file.name) === 'msg' || startsWith(new Uint8Array(buffer, 0, 8), [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  const mail = isMsg ? parseMsg(buffer) : await parseEml(file);

  const field = (label: string, value: string) => (value ? h('div', { class: 'mail-field' }, h('span', { class: 'c3' }, label), h('span', {}, value)) : null);
  const header = h(
    'div',
    { class: 'mail-head' },
    h('h2', {}, mail.subject || '(no subject)'),
    field('From', mail.from),
    field('To', mail.to.join(', ')),
    field('Cc', mail.cc.join(', ')),
    field('Date', mail.date ? mail.date.toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'short' }) : ''),
  );

  const usedInline = new Set<MailAttachment>();
  if (mail.html) {
    for (const a of mail.attachments) if (a.contentId && mail.html.includes(`cid:${a.contentId}`)) usedInline.add(a);
  }
  const listed = mail.attachments.filter((a) => !usedInline.has(a));
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

  container.classList.add('mail');
  container.append(header);
  if (mail.html) {
    if (hasRemoteResources(mail.html)) {
      container.append(h('div', { class: 'banner' }, 'External images and content were blocked. They would tell the sender that the e-mail was opened.'));
    }
    container.append(sandboxedFrame(resolveInlineImages(mail.html, mail.attachments), 'E-mail content'));
  } else {
    container.append(h('pre', { class: 'mail-text' }, mail.text ?? ''));
  }

  if (listed.length) toolbar.append(h('span', { class: 'meta' }, `${listed.length} ${listed.length === 1 ? 'attachment' : 'attachments'}`));
  return { destroy: () => {} };
}
