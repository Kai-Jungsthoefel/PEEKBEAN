// SPDX-License-Identifier: GPL-3.0-or-later
// An Outlook message as an Internet message (.eml). The header block the message arrived with is kept where Outlook
// stored it; otherwise From, To, Subject and the rest are written from the message's properties. The body becomes
// multipart/alternative (text and HTML), pictures of the HTML multipart/related, attachments multipart/mixed, and
// attached Outlook messages message/rfc822 parts of their own. S/MIME messages are put back together byte for byte.
import { readMail, type Mail, type MailAttachment } from '../../viewers/email/read';
import { bodyOf } from './body';
import {
  CRLF, addressList, base64Lines, entity, fold, header, messageDate, msgId, multipart, nameParam, param, paramHeader, sevenBit, textPart, unstructured,
  type Chunk, type Part,
} from './mime';

export interface Eml {
  chunks: Chunk[];
  notes: string[];
}

/** Attached messages are converted up to this depth, deeper ones stay .msg files. */
const MAX_DEPTH = 4;

const latin1 = (bytes: Uint8Array) => new TextDecoder('latin1').decode(bytes);

// ---- Headers --------------------------------------------------------------------------------------------------------

interface RawHeader {
  name: string;
  /** The field as it was, with its folded lines. */
  lines: string[];
}

function headerBlock(text: string): RawHeader[] {
  const fields: RawHeader[] = [];
  let current: RawHeader | null = null;
  for (const line of text.split(/\r\n|\r|\n/)) {
    if (line === '') {
      if (fields.length) break;
      continue;
    }
    if (/^[ \t]/.test(line)) {
      current?.lines.push(line);
      continue;
    }
    const colon = line.indexOf(':');
    const name = line.slice(0, Math.max(colon, 0));
    current = colon > 0 && /^[\x21-\x39\x3b-\x7e]+$/.test(name) ? { name, lines: [line] } : null;
    if (current) fields.push(current);
  }
  return fields;
}

// Fields this writer knows from the message's properties; the transport headers' own version wins when there is one.
const OWN = ['from', 'to', 'cc', 'bcc', 'reply-to', 'subject', 'date', 'message-id', 'in-reply-to', 'references'];

function headers(mail: Mail): string[] {
  const own = new Map<string, string>();
  const set = (name: string, value: string | undefined) => {
    if (value) own.set(name.toLowerCase(), header(name, value));
  };
  const date = mail.outlook?.sent ?? mail.date;
  set('Date', date ? messageDate(date) : undefined);
  set('From', addressList(mail.from));
  set('Reply-To', addressList(mail.replyTo));
  set('Subject', mail.subject ? unstructured(mail.subject) : undefined);
  set('To', addressList(mail.to));
  set('Cc', addressList(mail.cc));
  set('Bcc', addressList(mail.bcc));
  set('Message-ID', mail.messageId ? msgId(mail.messageId) : undefined);
  set('In-Reply-To', mail.inReplyTo?.replace(/\s+/g, ' ').trim());
  set('References', mail.references?.replace(/\s+/g, ' ').trim());

  const lines: string[] = [];
  const taken = new Set<string>();
  for (const field of headerBlock(mail.outlook?.headers ?? '')) {
    const key = field.name.toLowerCase();
    // The message's structure is written anew.
    if (key.startsWith('content-') || key === 'mime-version') continue;
    if (OWN.includes(key)) {
      if (taken.has(key)) continue;
      taken.add(key);
    }
    const ascii = field.lines.every((line) => /^[\x20-\x7e\t]*$/.test(line) && line.length <= 998);
    if (ascii) {
      lines.push(field.lines.join(CRLF));
    } else {
      // Unencoded 8-bit text that Outlook decoded: the field is written from the properties, or encoded.
      const value = field.lines.join(' ').slice(field.name.length + 1).replace(/\s+/g, ' ').trim();
      lines.push(own.get(key) ?? fold(`${field.name}: ${unstructured(value)}`));
    }
  }
  for (const [key, line] of own) if (!taken.has(key)) lines.push(line);
  return lines;
}

// ---- Parts ----------------------------------------------------------------------------------------------------------

const cleanName = (name: string) => name.replace(/[\x00-\x1f\x7f]/g, '').trim() || 'attachment';

function filePart(a: MailAttachment, disposition: 'inline' | 'attachment'): Part {
  const type = /^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType.trim()) ? a.mimeType.trim().toLowerCase() : 'application/octet-stream';
  const name = cleanName(a.name);
  const lines = [paramHeader('Content-Type', type, nameParam(name)), 'Content-Transfer-Encoding: base64'];
  const cid = a.contentId?.replace(/[\s<>]/g, '');
  if (cid) lines.push(header('Content-ID', `<${cid}>`));
  lines.push(paramHeader('Content-Disposition', disposition, param('filename', name)));
  return { headers: lines, body: base64Lines(a.data) };
}

async function messagePart(a: MailAttachment, depth: number, notes: string[]): Promise<Part> {
  if (depth < MAX_DEPTH) {
    try {
      const inner = await readMail('attached.msg', a.data.slice().buffer as ArrayBuffer);
      const eml = await mailToEml(inner, depth + 1);
      notes.push(...eml.notes);
      const name = `${cleanName(a.name).replace(/\.msg$/i, '')}.eml`;
      return {
        headers: [
          paramHeader('Content-Type', 'message/rfc822', nameParam(name)),
          `Content-Transfer-Encoding: ${sevenBit(eml.chunks) ? '7bit' : '8bit'}`,
          paramHeader('Content-Disposition', 'attachment', param('filename', name)),
        ],
        body: eml.chunks,
      };
    } catch (error) {
      console.warn('Attached message not converted:', error);
    }
  }
  notes.push(`The attached message "${a.name}" stays an Outlook file (.msg).`);
  return filePart(a, 'attachment');
}

/** Pictures of HTML made from rich text, data: URLs, become parts of their own: mail programs show cid: pictures. */
function dataPictures(html: string): { html: string; pictures: MailAttachment[] } {
  const pictures: MailAttachment[] = [];
  const tag = [...crypto.getRandomValues(new Uint8Array(6))].map((b) => b.toString(16).padStart(2, '0')).join('');
  const replaced = html.replace(/(<img\b[^>]*?\ssrc=")data:(image\/[\w.+-]+);base64,([A-Za-z0-9+/=]+)"/gi, (_match, start: string, type: string, data: string) => {
    const n = pictures.length + 1;
    const binary = atob(data);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const contentId = `picture${n}.${tag}@rtf`;
    pictures.push({ name: `picture${n}.${type.split('/')[1].replace('jpeg', 'jpg')}`, mimeType: type, data: bytes, contentId, inline: true });
    return `${start}cid:${contentId}"`;
  });
  return { html: replaced, pictures };
}

// ---- S/MIME ---------------------------------------------------------------------------------------------------------

/** Outlook keeps a signed or encrypted message as one attachment holding the MIME entity or the PKCS #7 data. */
export function smimeAttachment(mail: Mail): MailAttachment | null {
  if (!/^IPM\.Note\.SMIME/i.test(mail.outlook?.messageClass ?? '')) return null;
  return mail.attachments.find((a) => /^(multipart\/signed|application\/(x-)?pkcs7-mime)/i.test(a.mimeType) || /\.p7m$/i.test(a.name)) ?? null;
}

/** PKCS #7 data whose content type OID says encrypted (1.2.840.113549.1.7.3) rather than signed (…7.2). */
export function encrypted(a: MailAttachment): boolean {
  const oid = [0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x07];
  const at = a.data.subarray(0, 64).findIndex((_b, i) => oid.every((o, j) => a.data[i + j] === o));
  return at >= 0 && a.data[at + oid.length] === 0x03;
}

function smimePart(a: MailAttachment, notes: string[]): Part {
  const head = latin1(a.data.subarray(0, 8192));
  if (/^[\x21-\x39\x3b-\x7e]+:/.test(head)) {
    // The signed entity with its own headers: it goes in unchanged, or the signature would no longer verify.
    const end = head.search(/\r?\n\r?\n/);
    if (end > 0) {
      const gap = /\r?\n\r?\n/.exec(head.slice(end))![0].length;
      return { headers: head.slice(0, end).split(/\r?\n/), body: [a.data.subarray(end + gap)] };
    }
  }
  const boundary = /^--([^\r\n]+)/m.exec(head)?.[1];
  if (boundary && /^multipart\/signed/i.test(a.mimeType)) {
    return {
      headers: [paramHeader('Content-Type', 'multipart/signed', ['protocol="application/pkcs7-signature"', 'micalg=sha-256', `boundary="${boundary.trim()}"`])],
      body: [a.data],
    };
  }
  const kind = encrypted(a) ? 'enveloped-data' : 'signed-data';
  if (kind === 'enveloped-data') notes.push('The message is encrypted (S/MIME); it stays encrypted in the EML file.');
  return {
    headers: [
      paramHeader('Content-Type', 'application/pkcs7-mime', [`smime-type=${kind}`, ...param('name', 'smime.p7m')]),
      'Content-Transfer-Encoding: base64',
      paramHeader('Content-Disposition', 'attachment', param('filename', 'smime.p7m')),
    ],
    body: base64Lines(a.data),
  };
}

// ---- Message --------------------------------------------------------------------------------------------------------

async function content(mail: Mail, depth: number, notes: string[]): Promise<Part> {
  const smime = smimeAttachment(mail);
  if (smime) return smimePart(smime, notes);

  const body = await bodyOf(mail);
  notes.push(...body.notes);
  let html = body.html;
  const related: MailAttachment[] = [];
  if (html !== null) {
    // The HTML is written as UTF-8 now.
    html = html.replace(/(<meta\b[^>]*charset\s*=\s*["']?)[\w-]+/gi, '$1utf-8');
    if (body.fromRtf) {
      const extracted = dataPictures(html);
      html = extracted.html;
      related.push(...extracted.pictures);
    }
    for (const a of mail.attachments) if (a.contentId && !a.message && html.includes(`cid:${a.contentId}`)) related.push(a);
  }

  const text = body.text !== null ? textPart('plain', body.text) : null;
  const page = html !== null ? textPart('html', html) : null;
  let part = text && page ? multipart('alternative', [text, page]) : (page ?? text ?? textPart('plain', ''));
  if (page && related.length) {
    part = multipart('related', [part, ...related.map((a) => filePart(a, 'inline'))], [`type="${text ? 'multipart/alternative' : 'text/html'}"`]);
  }
  const attached: Part[] = [];
  for (const a of mail.attachments) {
    if (related.includes(a)) continue;
    attached.push(a.message ? await messagePart(a, depth, notes) : filePart(a, 'attachment'));
  }
  return attached.length ? multipart('mixed', [part, ...attached]) : part;
}

/** The message as EML: 7-bit text with CRLF line ends, as chunks for a Blob. */
export async function mailToEml(mail: Mail, depth = 0): Promise<Eml> {
  const notes: string[] = [];
  if (mail.outlook?.exchangeSender) notes.push('The sender has only an Exchange address; the EML file names the sender without an e-mail address.');
  if (mail.skipped.length) notes.push(`Left out, as they hold no file (embedded objects or links): ${mail.skipped.join(', ')}.`);
  const part = await content(mail, depth, notes);
  const head = [...headers(mail), 'MIME-Version: 1.0'].join(CRLF) + CRLF;
  return { chunks: [head, ...entity(part)], notes: [...new Set(notes)] };
}
