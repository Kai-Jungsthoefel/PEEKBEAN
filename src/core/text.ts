// SPDX-License-Identifier: GPL-3.0-or-later
import { startsWith } from './bytes';

/** Decodes text by BOM, then strict UTF-8, falling back to Windows-1252 (legacy Windows text). */
export function decodeText(bytes: Uint8Array): { text: string; encoding: string } {
  if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8 (BOM)' };
  if (startsWith(bytes, [0xff, 0xfe])) return { text: new TextDecoder('utf-16le').decode(bytes), encoding: 'UTF-16 LE' };
  if (startsWith(bytes, [0xfe, 0xff])) return { text: new TextDecoder('utf-16be').decode(bytes), encoding: 'UTF-16 BE' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(bytes), encoding: 'Windows-1252' };
  }
}

export async function readText(file: File): Promise<{ text: string; encoding: string }> {
  return decodeText(new Uint8Array(await file.arrayBuffer()));
}
