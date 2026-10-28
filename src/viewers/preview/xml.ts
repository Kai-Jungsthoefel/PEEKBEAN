// SPDX-License-Identifier: GPL-3.0-or-later
// Just enough XML for the small, machine-written documents inside CAD and design files. The readers run in a worker,
// where DOMParser does not exist.

export interface XmlElement {
  attrs: Record<string, string>;
  /** Content between the tags; "" for an empty element. */
  inner: string;
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|amp|quot|apos);/gi, (whole, code: string) => {
    const lower = code.toLowerCase();
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'amp') return '&';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const n = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : whole;
  });
}

export function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[m[1]] = decodeEntities(m[2] ?? m[3] ?? '');
  return attrs;
}

/** Elements by tag name (with or without prefix); elements of the same name must not nest. */
export function elements(xml: string, name: string): XmlElement[] {
  const tag = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`<(?:[\\w.-]+:)?${tag}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</(?:[\\w.-]+:)?${tag}\\s*>)`, 'g');
  return [...xml.matchAll(pattern)].map((m) => ({ attrs: attributes(m[1] ?? ''), inner: m[2] ?? '' }));
}

/** Text content of the first element of that name, tags stripped. */
export function textOf(xml: string, name: string): string {
  const inner = elements(xml, name)[0]?.inner ?? '';
  return decodeEntities(inner.replace(/<[^>]*>/g, '')).trim();
}

/** Bytes as text from the first "<" on: some writers put a byte-order mark or a length byte in front. */
export function xmlFrom(bytes: Uint8Array): string {
  const text = new TextDecoder().decode(bytes);
  const start = text.indexOf('<');
  return start < 0 ? '' : text.slice(start);
}
