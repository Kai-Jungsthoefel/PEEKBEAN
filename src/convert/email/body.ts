// SPDX-License-Identifier: GPL-3.0-or-later
// The text of a message for converting. Outlook messages without an HTML body may keep their formatted text as
// compressed RTF only: HTML or text that Outlook wrapped into it is taken out, real rich text goes through the RTF
// reader (viewers/rtf/parse.ts) and becomes HTML with its pictures as data: URLs.
import { dataUrl, type Mail } from '../../viewers/email/read';
import { decompressRtf, unwrapRtf } from './rtf';

export interface Body {
  html: string | null;
  text: string | null;
  /** The HTML was made from rich text; its pictures are data: URLs. */
  fromRtf: boolean;
  notes: string[];
}

// The rules of styles.css that rich text needs outside the viewer.
const RTF_CSS =
  '.rtf-p{margin:0;white-space:pre-wrap}.rtf-tab{display:inline-block;width:36pt;overflow:hidden;white-space:pre}' +
  '.rtf-pic{max-width:100%;height:auto;vertical-align:bottom}.rtf-table{border-collapse:collapse;table-layout:fixed}' +
  '.rtf-table td{vertical-align:top}.rtf-gap{border:0;padding:0}.rtf-header,.rtf-footer{display:none}';

async function rtfToHtml(rtf: Uint8Array): Promise<string> {
  const { parseRtf } = await import('../../viewers/rtf/parse');
  const doc = parseRtf(rtf);
  try {
    await doc.drawPictures();
    for (const img of doc.sheets.flatMap((sheet) => [...sheet.querySelectorAll('img')])) {
      const src = img.getAttribute('src') ?? '';
      if (!src.startsWith('blob:')) continue;
      const blob = await (await fetch(src)).blob();
      img.setAttribute('src', dataUrl({ mimeType: blob.type || 'image/png', data: new Uint8Array(await blob.arrayBuffer()) }));
    }
    const sheets = doc.sheets.map((sheet) => sheet.innerHTML).join('<hr>');
    return `<!doctype html><html><head><meta charset="utf-8"><style>${RTF_CSS}</style></head><body style="font:12pt 'Times New Roman',serif">${sheets}</body></html>`;
  } finally {
    doc.destroy();
  }
}

export async function bodyOf(mail: Mail): Promise<Body> {
  const plain = { html: mail.htmlFromText ? null : mail.html, text: mail.text, fromRtf: false, notes: [] };
  const compressed = mail.outlook?.compressedRtf;
  if (plain.html || !compressed) return plain;
  let rtf: Uint8Array;
  try {
    rtf = decompressRtf(compressed);
  } catch {
    return { ...plain, notes: ['The formatted text (RTF) of the message could not be read; only its plain text is kept.'] };
  }
  const unwrapped = unwrapRtf(rtf);
  if (unwrapped?.kind === 'html') return { ...plain, html: unwrapped.content };
  if (unwrapped) return { ...plain, text: mail.text ?? unwrapped.content };
  try {
    return { ...plain, html: await rtfToHtml(rtf), fromRtf: true, notes: ['The message was written as rich text (RTF); its formatting was turned into HTML.'] };
  } catch {
    return { ...plain, notes: ['The formatted text (RTF) of the message could not be read; only its plain text is kept.'] };
  }
}
