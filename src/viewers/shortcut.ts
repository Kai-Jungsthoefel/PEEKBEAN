// SPDX-License-Identifier: GPL-3.0-or-later
// Shortcuts: Windows .lnk (Shell Link, [MS-SHLLINK]), Internet shortcuts (.url), Linux .desktop entries and macOS
// .webloc. Shows what the shortcut points to and what it would run; nothing is opened unless a link is clicked.
import { startsWith } from '../core/bytes';
import { h } from '../core/dom';
import { decodeText } from '../core/text';
import type { ViewerContext } from '../core/types';
import { guardLinks } from './paged';

type Row = [string, string | Node | null | undefined];

interface Shortcut {
  kind: string;
  title: string;
  rows: Row[];
  /** A note under the card, e.g. what opening it would do. */
  note?: string;
}

const LNK_SIGNATURE = [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0x00];
const SHOW: Record<number, string> = { 1: 'Normal window', 3: 'Maximized', 7: 'Minimized' };
const DRIVES: Record<number, string> = { 2: 'Removable drive', 3: 'Fixed drive', 4: 'Network drive', 5: 'CD/DVD', 6: 'RAM disk' };
const ansi = new TextDecoder('windows-1252');
const utf16 = new TextDecoder('utf-16le');

function link(href: string): Node {
  return /^(https?|mailto|ftp):/i.test(href) ? h('a', { href }, href) : document.createTextNode(href);
}

function parseLnk(buffer: ArrayBuffer): Shortcut {
  const v = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const u16 = (o: number) => v.getUint16(o, true);
  const u32 = (o: number) => v.getUint32(o, true);
  const zString = (o: number, unicode: boolean) => {
    if (o <= 0 || o >= bytes.length) return '';
    if (!unicode) return ansi.decode(bytes.subarray(o, bytes.indexOf(0, o) < 0 ? bytes.length : bytes.indexOf(0, o)));
    let end = o;
    while (end + 1 < bytes.length && (bytes[end] || bytes[end + 1])) end += 2;
    return utf16.decode(bytes.subarray(o, end));
  };
  const fileTime = (o: number) => {
    const ms = (u32(o + 4) * 2 ** 32 + u32(o)) / 1e4 - 11644473600000;
    return ms > 0 ? new Date(ms).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : null;
  };

  const flags = u32(20);
  const attributes = u32(24);
  const unicode = Boolean(flags & 0x80);
  let at = 76;
  if (flags & 0x1) at += 2 + u16(at); // LinkTargetIDList: the shell's item IDs; LinkInfo holds the same path as text

  let target = '';
  let volume = '';
  if (flags & 0x2) {
    const info = at;
    const size = u32(info);
    const headerSize = u32(info + 4);
    const infoFlags = u32(info + 8);
    const suffix = headerSize >= 0x24 && u32(info + 32) ? zString(info + u32(info + 32), true) : zString(info + u32(info + 24), false);
    if (infoFlags & 0x1) {
      const base = headerSize >= 0x24 && u32(info + 28) ? zString(info + u32(info + 28), true) : zString(info + u32(info + 16), false);
      target = base + suffix;
      const vol = info + u32(info + 12);
      const label = zString(vol + u32(vol + 12), false);
      volume = [label && `“${label}”`, DRIVES[u32(vol + 4)], `serial ${u32(vol + 8).toString(16).toUpperCase().padStart(8, '0').replace(/(.{4})/, '$1-')}`].filter(Boolean).join(', ');
    } else if (infoFlags & 0x2) {
      const net = info + u32(info + 20);
      const share = zString(net + u32(net + 8), false);
      target = suffix ? `${share}\\${suffix}` : share;
      volume = 'Network share';
    }
    at += size;
  }

  const strings: string[] = [];
  for (const bit of [0x4, 0x8, 0x10, 0x20, 0x40]) {
    if (!(flags & bit)) {
      strings.push('');
      continue;
    }
    const count = u16(at);
    at += 2;
    const length = unicode ? count * 2 : count;
    strings.push((unicode ? utf16 : ansi).decode(bytes.subarray(at, at + length)));
    at += length;
  }
  const [description, relativePath, workingDir, args, icon] = strings;

  // Extra data: the target with environment variables (used when there is no LinkInfo).
  let envTarget = '';
  while (at + 8 <= bytes.length) {
    const size = u32(at);
    if (size < 4) break;
    if (u32(at + 4) === 0xa0000001) envTarget = zString(at + 268, true) || zString(at + 8, false);
    at += size;
  }
  target ||= envTarget || relativePath;

  const name = target.split(/[\\/]/).pop() || 'Shortcut';
  const isFolder = Boolean(attributes & 0x10);
  const runs = /\.(exe|com|bat|cmd|ps1|vbs|js|jse|wsf|msi|scr|hta|cpl)$/i.test(target);
  return {
    kind: 'Windows shortcut',
    title: name,
    rows: [
      ['Target', target],
      ['Arguments', args],
      ['Start in', workingDir],
      ['Description', description],
      ['Relative path', relativePath && relativePath !== target ? relativePath : null],
      ['Environment target', envTarget && envTarget !== target ? envTarget : null],
      ['Volume', volume],
      ['Kind', isFolder ? 'Folder' : 'File'],
      ['Target size', !isFolder && u32(52) ? `${u32(52).toLocaleString('en-US')} bytes` : null],
      ['Target modified', fileTime(44)],
      ['Target created', fileTime(28)],
      ['Window', SHOW[u32(60)] ?? null],
      ['Icon', icon ? `${icon}${u32(56) ? `, index ${u32(56)}` : ''}` : null],
    ],
    note: runs
      ? 'Opening this shortcut in Windows starts the program above with these arguments. Here it is only shown.'
      : undefined,
  };
}

/** Key/value lines of an INI-style section ([InternetShortcut], [Desktop Entry]). */
function iniSection(text: string, section: string): Map<string, string> {
  const values = new Map<string, string>();
  let inside = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[(.+)\]\s*$/.exec(line);
    if (header) {
      inside = header[1].toLowerCase() === section.toLowerCase();
      continue;
    }
    const pair = /^\s*([^=#;]+?)\s*=\s*(.*)$/.exec(line);
    if (inside && pair && !values.has(pair[1])) values.set(pair[1], pair[2]);
  }
  return values;
}

function parseUrl(text: string): Shortcut {
  const v = iniSection(text, 'InternetShortcut');
  const url = v.get('URL') ?? '';
  return {
    kind: 'Internet shortcut',
    title: url.replace(/^\w+:\/\//, '').split('/')[0] || 'Internet shortcut',
    rows: [
      ['Address', url ? link(url) : null],
      ['Icon', v.get('IconFile')],
      ['Working folder', v.get('WorkingDirectory')],
    ],
  };
}

function parseDesktop(text: string): Shortcut {
  const v = iniSection(text, 'Desktop Entry');
  const url = v.get('URL');
  return {
    kind: `Desktop entry (${v.get('Type') ?? 'Application'})`,
    title: v.get('Name') ?? 'Desktop entry',
    rows: [
      ['Command', v.get('Exec')],
      ['Address', url ? link(url) : null],
      ['Comment', v.get('Comment')],
      ['Start in', v.get('Path')],
      ['In a terminal', v.get('Terminal') === 'true' ? 'Yes' : null],
      ['Categories', v.get('Categories')?.split(';').filter(Boolean).join(', ')],
      ['Icon', v.get('Icon')],
    ],
    note: v.get('Exec') ? 'Opening this entry starts the command above. Here it is only shown.' : undefined,
  };
}

function parseWebloc(text: string): Shortcut {
  const url = /<key>\s*URL\s*<\/key>\s*<string>([^<]*)<\/string>/i.exec(text)?.[1]?.replace(/&amp;/g, '&') ?? '';
  if (!url) throw new Error('Only .webloc files in XML form can be read; this one is binary or empty.');
  return { kind: 'macOS web location', title: url.replace(/^\w+:\/\//, '').split('/')[0] || 'Web location', rows: [['Address', link(url)]] };
}

export async function mount({ file, container }: ViewerContext) {
  const buffer = await file.arrayBuffer();
  const head = new Uint8Array(buffer, 0, Math.min(64, buffer.byteLength));
  let shortcut: Shortcut;
  if (startsWith(head, LNK_SIGNATURE)) shortcut = parseLnk(buffer);
  else {
    const { text } = decodeText(new Uint8Array(buffer));
    if (/\[InternetShortcut\]/i.test(text)) shortcut = parseUrl(text);
    else if (/\[Desktop Entry\]/i.test(text)) shortcut = parseDesktop(text);
    else if (/<plist/i.test(text)) shortcut = parseWebloc(text);
    else throw new Error('The shortcut format was not recognized.');
  }

  const list = h('dl');
  for (const [label, value] of shortcut.rows) {
    if (value === null || value === undefined || value === '') continue;
    list.append(h('dt', {}, label), h('dd', {}, value));
  }
  const card = h(
    'div',
    { class: 'record' },
    h('div', { class: 'record-hd' }, h('b', {}, shortcut.title), h('span', { class: 'when' }, shortcut.kind)),
    list,
  );
  guardLinks(card);
  container.append(
    h('div', { class: 'records' }, h('div', { class: 'records-list' }, card, shortcut.note ? h('p', { class: 'records-note' }, shortcut.note) : null)),
  );
  return { destroy: () => {} };
}
