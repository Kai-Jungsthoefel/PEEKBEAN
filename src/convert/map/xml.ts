// SPDX-License-Identifier: GPL-3.0-or-later
// Text in the KML and GPX writers.

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
/** Control characters and unpaired surrogates, which XML does not allow even escaped. */
const INVALID = /[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text for XML content and attribute values. */
export function xmlText(text: string): string {
  return text.replace(INVALID, '').replace(/[&<>"]/g, (c) => ESCAPES[c]);
}

/** An element with text content, or nothing when there is no text. */
export function element(name: string, text: string | undefined): string {
  return text ? `<${name}>${xmlText(text)}</${name}>` : '';
}

const DATE_TIME = /^-?\d{4,}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})?$/;

/** A time as xsd:dateTime: kept as written when it is one, else converted when it can be read, else undefined. */
export function dateTime(value: unknown): string | undefined {
  if (typeof value !== 'string' && !(value instanceof Date)) return undefined;
  const text = typeof value === 'string' ? value.trim() : '';
  if (DATE_TIME.test(text)) return text;
  const ms = value instanceof Date ? value.getTime() : Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}
