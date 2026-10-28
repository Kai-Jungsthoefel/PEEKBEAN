// SPDX-License-Identifier: GPL-3.0-or-later
// Writing Internet messages (RFC 5322 and MIME): headers with encoded words (RFC 2047) and parameters (RFC 2231),
// bodies as quoted-printable or base64, CRLF line ends and lines of at most 78 characters where it can be helped,
// so that the message is 7-bit clean and survives any mail program.
import type { Mailbox } from '../../viewers/email/read';

export const CRLF = '\r\n';
const utf8 = new TextEncoder();

export type Chunk = string | Uint8Array;

/** A MIME entity: header lines (folded, without line ends) and the body as it goes into the message. */
export interface Part {
  headers: string[];
  body: Chunk[];
}

const hex = (byte: number) => byte.toString(16).toUpperCase().padStart(2, '0');
const isAscii = (text: string) => /^[\x20-\x7e]*$/.test(text);

// ---- Headers --------------------------------------------------------------------------------------------------------

/** Folds a header line before white space, so that lines stay at 78 characters where the words allow it. */
export function fold(line: string, limit = 78): string {
  if (line.length <= limit) return line;
  const pieces = line.split(/(?=[ \t])/);
  let out = '';
  let current = pieces[0];
  for (let i = 1; i < pieces.length; i++) {
    // The first line keeps at least the field name and one word.
    if (i > 1 && current.length + pieces[i].length > limit && current.trim()) {
      out += current + CRLF;
      current = pieces[i];
    } else {
      current += pieces[i];
    }
  }
  return out + current;
}

export const header = (name: string, value: string) => fold(`${name}: ${value}`);

/** Encoded words (RFC 2047) of at most 75 characters, cut between characters; Q for mostly Latin text, B otherwise. */
export function encodedWords(text: string, phrase = false): string {
  const bytes = utf8.encode(text);
  const high = bytes.reduce((n, b) => n + (b >= 0x80 ? 1 : 0), 0);
  const base64 = high * 3 > bytes.length;
  const safe = phrase ? /[A-Za-z0-9!*+\-/]/ : /[A-Za-z0-9!*+\-/.,:;()<>@[\]"]/;
  const words: string[] = [];
  let word = '';
  let pending: number[] = [];
  const flush = () => {
    if (base64) word = btoa(String.fromCharCode(...pending));
    if (word) words.push(`=?UTF-8?${base64 ? 'B' : 'Q'}?${word}?=`);
    word = '';
    pending = [];
  };
  for (const char of text) {
    const charBytes = utf8.encode(char);
    if (base64) {
      if (pending.length + charBytes.length > 45) flush();
      pending.push(...charBytes);
    } else {
      const encoded = char === ' ' ? '_' : charBytes.length === 1 && safe.test(char) ? char : [...charBytes].map((b) => `=${hex(b)}`).join('');
      if (word.length + encoded.length > 63) flush();
      word += encoded;
    }
  }
  flush();
  return words.join(' ');
}

/** Free text such as the subject: words with other than printable ASCII become encoded words, runs of them together. */
export function unstructured(text: string): string {
  const words = text.replace(/[\r\n]+[ \t]*/g, ' ').split(' ');
  const needsEncoding = (word: string) => !isAscii(word) || word.includes('=?') || word.length > 70;
  const out: string[] = [];
  let run: string[] = [];
  for (const word of words) {
    if (needsEncoding(word)) {
      run.push(word);
      continue;
    }
    if (run.length) out.push(encodedWords(run.join(' ')));
    run = [];
    out.push(word);
  }
  if (run.length) out.push(encodedWords(run.join(' ')));
  return out.join(' ');
}

/** A display name: as it is, quoted, or as encoded words. */
export function phrase(name: string): string {
  if (/^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+( [A-Za-z0-9!#$%&'*+\-/=?^_`{|}~]+)*$/.test(name) && !name.includes('=?')) return name;
  if (isAscii(name) && !name.includes('=?')) return `"${name.replace(/["\\]/g, '\\$&')}"`;
  return encodedWords(name, true);
}

/** One address; an Exchange-only sender has no internet address and keeps only the name. */
export function mailbox({ name, address }: Mailbox): string {
  const addr = address.includes('@') ? address.trim() : '';
  if (!name) return addr;
  return `${phrase(name)} <${addr}>`;
}

export const addressList = (list: Mailbox[]) => list.map(mailbox).filter(Boolean).join(', ');

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** RFC 5322 date in UTC, e.g. "Mon, 26 Oct 2026 08:30:00 +0000". */
export function messageDate(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  const time = `${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())}`;
  return `${DAYS[date.getUTCDay()]}, ${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()} ${time} +0000`;
}

/** A message id in angle brackets. */
export const msgId = (id: string) => (id.trim().startsWith('<') ? id.trim() : `<${id.trim()}>`);

// ---- Parameters -----------------------------------------------------------------------------------------------------

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const ATTR_CHAR = /[!#$&+\-.^_`|~0-9A-Za-z]/;

/** A parameter; non-ASCII values as RFC 2231 UTF-8, in continuations that keep the lines short. */
export function param(name: string, value: string): string[] {
  if (TOKEN.test(value)) return [`${name}=${value}`];
  if (isAscii(value)) return [`${name}="${value.replace(/["\\]/g, '\\$&')}"`];
  const pieces: string[] = [];
  let piece = '';
  // Cut between characters only: some readers decode every piece on its own.
  for (const char of value) {
    const encoded = ATTR_CHAR.test(char) ? char : [...utf8.encode(char)].map((b) => `%${hex(b)}`).join('');
    if (piece.length + encoded.length > 48) {
      pieces.push(piece);
      piece = '';
    }
    piece += encoded;
  }
  pieces.push(piece);
  if (pieces.length === 1) return [`${name}*=UTF-8''${pieces[0]}`];
  return pieces.map((p, i) => `${name}*${i}*=${i === 0 ? "UTF-8''" : ''}${p}`);
}

/** The name parameter of Content-Type, which mail programs read as encoded words when it is not ASCII. */
export const nameParam = (value: string) => (isAscii(value) ? param('name', value) : [`name="${encodedWords(value)}"`]);

/** A header with parameters, each starting a new line when the line would get too long. */
export function paramHeader(name: string, value: string, params: string[]): string {
  let out = `${name}: ${value}`;
  let line = out.length;
  for (const p of params) {
    if (line + 2 + p.length > 78) {
      out += `;${CRLF} ${p}`;
      line = p.length + 1;
    } else {
      out += `; ${p}`;
      line += p.length + 2;
    }
  }
  return out;
}

// ---- Bodies ---------------------------------------------------------------------------------------------------------

/** Base64 in lines of 76 characters. */
export function base64Lines(data: Uint8Array): string[] {
  const lines: string[] = [];
  // Blocks of a multiple of 57 bytes: whole lines, and no padding but at the end.
  const block = 57 * 256;
  for (let i = 0; i < data.length; i += block) {
    const slice = data.subarray(i, i + block);
    let binary = '';
    for (let j = 0; j < slice.length; j += 0x8000) binary += String.fromCharCode(...slice.subarray(j, j + 0x8000));
    const encoded = btoa(binary);
    for (let j = 0; j < encoded.length; j += 76) lines.push(encoded.slice(j, j + 76));
  }
  return [lines.join(CRLF)];
}

/** Quoted-printable (RFC 2045) of UTF-8 text whose line ends are CRLF already. */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.split(CRLF)) {
    const bytes = utf8.encode(line);
    let current = '';
    bytes.forEach((b, i) => {
      let encoded: string;
      if (b === 0x20 || b === 0x09) encoded = i === bytes.length - 1 ? `=${hex(b)}` : String.fromCharCode(b);
      else if (b >= 0x21 && b <= 0x7e && b !== 0x3d) encoded = String.fromCharCode(b);
      else encoded = `=${hex(b)}`;
      // "From " at the start of a line gets changed by mbox files; an encoded F is left alone.
      if (i === 0 && line.startsWith('From ')) encoded = '=46';
      if (current.length + encoded.length > 75) {
        out.push(`${current}=`);
        current = '';
      }
      current += encoded;
    });
    out.push(current);
  }
  return out.join(CRLF);
}

/** A text/plain or text/html part in UTF-8: quoted-printable, or base64 when most of it is not Latin. */
export function textPart(subtype: 'plain' | 'html', text: string): Part {
  const normalized = text.replace(/\r\n|\r|\n/g, CRLF);
  const bytes = utf8.encode(normalized);
  const high = bytes.reduce((n, b) => n + (b >= 0x80 ? 1 : 0), 0);
  const base64 = high * 3 > bytes.length;
  return {
    headers: [`Content-Type: text/${subtype}; charset=utf-8`, `Content-Transfer-Encoding: ${base64 ? 'base64' : 'quoted-printable'}`],
    body: base64 ? base64Lines(bytes) : [quotedPrintable(normalized)],
  };
}

function boundary(): string {
  const random = crypto.getRandomValues(new Uint8Array(12));
  // "=_" can occur in neither quoted-printable nor base64.
  return `----=_Part_${[...random].map(hex).join('')}`;
}

export function multipart(subtype: string, parts: Part[], params: string[] = []): Part {
  const b = boundary();
  const body: Chunk[] = [];
  for (const part of parts) body.push(`--${b}${CRLF}`, ...entity(part), CRLF);
  body.push(`--${b}--${CRLF}`);
  return { headers: [paramHeader('Content-Type', `multipart/${subtype}`, [`boundary="${b}"`, ...params])], body };
}

/** Headers, empty line, body. */
export const entity = (part: Part): Chunk[] => [part.headers.join(CRLF) + CRLF + CRLF, ...part.body];

/** True when every byte is ASCII, so that the chunks can go into a message/rfc822 part as 7bit. */
export function sevenBit(chunks: Chunk[]): boolean {
  return chunks.every((c) => (typeof c === 'string' ? !/[^\x00-\x7f]/.test(c) : c.every((b) => b < 0x80)));
}
