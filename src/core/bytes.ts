// SPDX-License-Identifier: GPL-3.0-or-later

export function startsWith(head: Uint8Array, signature: string | number[], offset = 0): boolean {
  const bytes = typeof signature === 'string' ? Array.from(signature, (c) => c.charCodeAt(0)) : signature;
  if (head.length < offset + bytes.length) return false;
  return bytes.every((b, i) => head[offset + i] === b);
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = size;
  let unit = -1;
  do {
    value /= 1024;
    unit++;
  } while (value >= 1024 && unit < units.length - 1);
  return `${value.toLocaleString('de-DE', { maximumFractionDigits: value < 10 ? 1 : 0 })} ${units[unit]}`;
}

/** Heuristic: does this look like text rather than binary data? */
export function looksLikeText(head: Uint8Array): boolean {
  if (head.length === 0) return true;
  if (startsWith(head, [0xef, 0xbb, 0xbf]) || startsWith(head, [0xff, 0xfe]) || startsWith(head, [0xfe, 0xff])) {
    return true;
  }
  let suspicious = 0;
  for (const b of head) {
    if (b === 0) return false;
    // Control characters other than tab, line feed, form feed, carriage return and escape.
    if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0c && b !== 0x0d && b !== 0x1b) suspicious++;
  }
  return suspicious / head.length < 0.02;
}
