// SPDX-License-Identifier: GPL-3.0-or-later
// Reading e-mails, for the viewer and the converter: .eml via postal-mime (MIT-0), Outlook .msg via msgreader
// (Apache-2.0). Both become the same model; what only an Outlook message has stays in `outlook`.
import PostalMime from 'postal-mime';
import MsgReaderModule, { type FieldsData } from '@kenjiuno/msgreader';
import { extensionOf, startsWith } from '../../core/bytes';

// msgreader is CommonJS. The production build reads it the way Node does ("type": "module"), so the default import is
// the exports object there and the class only in development.
const MsgReader = (MsgReaderModule as unknown as { default?: typeof MsgReaderModule }).default ?? MsgReaderModule;

export interface Mailbox {
  name: string;
  address: string;
}

export interface MailAttachment {
  name: string;
  mimeType: string;
  data: Uint8Array;
  contentId?: string;
  inline: boolean;
  /** An Outlook message attached to an Outlook message; `data` is that message as a .msg file of its own. */
  message?: boolean;
}

export interface Mail {
  subject: string;
  from: Mailbox[];
  to: Mailbox[];
  cc: Mailbox[];
  bcc: Mailbox[];
  replyTo: Mailbox[];
  date: Date | null;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  html: string | null;
  text: string | null;
  /** postal-mime writes HTML for a message that has only text; true then. */
  htmlFromText: boolean;
  attachments: MailAttachment[];
  /** Attachments that hold no file (OLE objects, links to files) and were left out. */
  skipped: string[];
  outlook?: OutlookExtras;
}

export interface OutlookExtras {
  messageClass?: string;
  /** When the sender sent it; `date` prefers when it arrived. */
  sent: Date | null;
  /** The header block the message arrived with, when Outlook kept it. */
  headers?: string;
  /** The body as compressed RTF (MS-OXRTFCP), the only body of some messages. */
  compressedRtf?: Uint8Array;
  /** The sender has only an Exchange address, no internet address. */
  exchangeSender: boolean;
}

const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

export const isOutlookMessage = (name: string, head: Uint8Array) => extensionOf(name) === 'msg' || startsWith(head, OLE_SIGNATURE);

/** "Name <address>", or whichever of the two is known. */
export function formatMailbox({ name, address }: Mailbox): string {
  return name && address && name !== address ? `${name} <${address}>` : name || address;
}

export const formatMailboxes = (list: Mailbox[]) => list.map(formatMailbox).join(', ');

const toBytes = (content: ArrayBuffer | Uint8Array | string) =>
  typeof content === 'string' ? new TextEncoder().encode(content) : content instanceof Uint8Array ? content : new Uint8Array(content);

const validDate = (value: string | undefined) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : null;
};

// Extensions for attachments that come without a name.
const EXTENSIONS: Record<string, string> = {
  'message/rfc822': 'eml',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/calendar': 'ics',
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
};

// ---- EML ------------------------------------------------------------------------------------------------------------

type Address = NonNullable<Awaited<ReturnType<typeof PostalMime.parse>>['from']>;

const mailboxes = (list: Address[] | Address | undefined): Mailbox[] =>
  (Array.isArray(list) ? list : list ? [list] : []).flatMap((a) => (a.group ? a.group : [a])).map((a) => ({ name: a.name ?? '', address: a.address ?? '' }));

async function readEml(buffer: ArrayBuffer): Promise<Mail> {
  const email = await PostalMime.parse(buffer);
  // Only the presence of an HTML part is looked for, so the whole message can be read as single bytes.
  const htmlPart = /^content-type:\s*text\/html/im.test(new TextDecoder('latin1').decode(buffer));
  return {
    subject: email.subject ?? '',
    from: mailboxes(email.from),
    to: mailboxes(email.to),
    cc: mailboxes(email.cc),
    bcc: mailboxes(email.bcc),
    replyTo: mailboxes(email.replyTo),
    date: validDate(email.date),
    messageId: email.messageId,
    inReplyTo: email.inReplyTo,
    references: email.references,
    html: email.html ?? null,
    text: email.text ?? null,
    htmlFromText: !htmlPart,
    attachments: email.attachments.map((a, i) => ({
      name: a.filename ?? `attachment-${i + 1}${EXTENSIONS[a.mimeType] ? `.${EXTENSIONS[a.mimeType]}` : ''}`,
      mimeType: a.mimeType,
      data: toBytes(a.content),
      contentId: a.contentId?.replace(/^<|>$/g, ''),
      inline: a.disposition === 'inline' || Boolean(a.related),
    })),
    skipped: [],
  };
}

// ---- Outlook MSG ----------------------------------------------------------------------------------------------------

// Windows code pages of PR_INTERNET_CPID, the encoding of the binary HTML body.
function codepageLabel(cp: number): string | null {
  if (cp >= 1250 && cp <= 1258) return `windows-${cp}`;
  if (cp >= 28591 && cp <= 28606) return `iso-8859-${cp - 28590}`;
  const named: Record<number, string> = {
    65001: 'utf-8', 1200: 'utf-16le', 1201: 'utf-16be', 20127: 'us-ascii', 874: 'windows-874', 866: 'ibm866', 932: 'shift_jis',
    936: 'gbk', 949: 'euc-kr', 950: 'big5', 20866: 'koi8-r', 21866: 'koi8-u', 20932: 'euc-jp', 51932: 'euc-jp', 50220: 'iso-2022-jp',
    50221: 'iso-2022-jp', 50222: 'iso-2022-jp', 51949: 'euc-kr', 52936: 'hz-gb-2312', 54936: 'gb18030', 10000: 'macintosh',
  };
  return named[cp] ?? null;
}

function decodeHtml(bytes: Uint8Array, codepage: number | undefined): string {
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(new TextDecoder('latin1').decode(bytes.subarray(0, 2048)))?.[1];
  for (const label of [codepage ? codepageLabel(codepage) : null, meta, 'utf-8']) {
    if (!label) continue;
    try {
      return new TextDecoder(label).decode(bytes);
    } catch {
      // Not a label this browser knows; try the next.
    }
  }
  return new TextDecoder().decode(bytes);
}

/** A string property by its id, Unicode (001f) or 8-bit (001e). */
const rawProp = (fields: FieldsData, id: string) => {
  const value = fields.rawProps?.find((p) => p.propertyTag === `${id}001f` || p.propertyTag === `${id}001e`)?.value;
  return typeof value === 'string' && value ? value : undefined;
};

function readMsg(buffer: ArrayBuffer): Mail {
  const reader = new MsgReader(buffer);
  // In-Reply-To and References have no names in msgreader; they are read from the raw properties.
  reader.parserConfig = { includeRawProps: true };
  const data = reader.getFileData();
  if (data.error) throw new Error(`The Outlook message is damaged: ${data.error}`);
  const recipients = (type: string) =>
    (data.recipients ?? [])
      .filter((r) => (r.recipType ?? 'to') === type)
      .map((r) => ({ name: r.name ?? '', address: r.smtpAddress ?? r.email ?? '' }));
  // An Exchange sender has an X.500 name in senderEmail; the internet address is in other properties, if at all.
  const exchange = data.senderAddressType === 'EX';
  const senderAddress = data.senderSmtpAddress ?? data.sentRepresentingSmtpAddress ?? (exchange ? undefined : data.senderEmail);
  // Without both, the X.500 name stands in for the name.
  const sender = { name: data.senderName || (senderAddress ? '' : (data.senderEmail ?? '')), address: senderAddress ?? '' };
  const html = data.bodyHtml ?? (data.html ? decodeHtml(data.html, data.internetCodepage) : null);
  const time = data.messageDeliveryTime ?? data.clientSubmitTime ?? data.creationTime;
  const attachments: MailAttachment[] = [];
  const skipped: string[] = [];
  (data.attachments ?? []).forEach((a, i) => {
    const name = a.fileName ?? a.fileNameShort ?? a.name ?? `attachment-${i + 1}`;
    try {
      const attachment = reader.getAttachment(a);
      if (a.innerMsgContent) {
        attachments.push({ name: attachment.fileName, mimeType: 'application/vnd.ms-outlook', data: attachment.content, inline: false, message: true });
      } else if (attachment.content) {
        attachments.push({ name, mimeType: a.attachMimeTag ?? 'application/octet-stream', data: attachment.content, contentId: a.pidContentId, inline: Boolean(a.attachmentHidden) });
      } else {
        skipped.push(name);
      }
    } catch {
      skipped.push(name);
    }
  });
  return {
    subject: data.subject ?? '',
    from: sender.name || sender.address ? [sender] : [],
    to: recipients('to'),
    cc: recipients('cc'),
    bcc: recipients('bcc'),
    replyTo: [],
    date: validDate(time),
    messageId: data.messageId,
    inReplyTo: rawProp(data, '1042'),
    references: rawProp(data, '1039'),
    html,
    text: data.body ?? null,
    htmlFromText: false,
    attachments,
    skipped,
    outlook: {
      messageClass: data.messageClass,
      sent: validDate(data.clientSubmitTime),
      headers: data.headers,
      compressedRtf: data.compressedRtf,
      exchangeSender: Boolean(!senderAddress && data.senderEmail),
    },
  };
}

/** Reads an .eml or Outlook .msg file; which one is told by the extension or the compound file signature. */
export async function readMail(name: string, buffer: ArrayBuffer): Promise<Mail> {
  return isOutlookMessage(name, new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength))) ? readMsg(buffer) : readEml(buffer);
}

// ---- Inline pictures ------------------------------------------------------------------------------------------------

export function dataUrl(a: Pick<MailAttachment, 'mimeType' | 'data'>): string {
  let binary = '';
  for (let i = 0; i < a.data.length; i += 0x8000) binary += String.fromCharCode(...a.data.subarray(i, i + 0x8000));
  return `data:${a.mimeType};base64,${btoa(binary)}`;
}

/** Inline images (cid:) become data: URLs, the only kind of image a sandboxed frame or an exported page may load. */
export function resolveInlineImages(html: string, attachments: MailAttachment[]): string {
  const byCid = new Map(attachments.filter((a) => a.contentId).map((a) => [a.contentId!, a]));
  return html.replace(/cid:([^"'\s)>]+)/gi, (match, cid: string) => {
    const attachment = byCid.get(decodeCid(cid));
    return attachment ? dataUrl(attachment) : match;
  });
}

function decodeCid(cid: string): string {
  try {
    return decodeURIComponent(cid);
  } catch {
    return cid;
  }
}

/** Attachments the HTML body shows as pictures (cid:), and so are no attachments to list. */
export function picturesInBody(mail: Pick<Mail, 'html' | 'attachments'>): Set<MailAttachment> {
  const used = new Set<MailAttachment>();
  if (mail.html) {
    for (const a of mail.attachments) if (a.contentId && mail.html.includes(`cid:${a.contentId}`)) used.add(a);
  }
  return used;
}
