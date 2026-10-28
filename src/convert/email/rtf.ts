// SPDX-License-Identifier: GPL-3.0-or-later
// The RTF body of an Outlook message: compressed RTF (MS-OXRTFCP) is unpacked, and HTML or plain text that Outlook
// wrapped into RTF (MS-OXRTFEX, \fromhtml1 and \fromtext) is taken out again as it was.

const PREBUF =
  '{\\rtf1\\ansi\\mac\\deff0\\deftab720{\\fonttbl;}{\\f0\\fnil \\froman \\fswiss \\fmodern \\fscript \\fdecor MS Sans SerifSymbolArialTimes New RomanCourier{\\colortbl\\red0\\green0\\blue0\r\n\\par \\pard\\plain\\f0\\fs20\\b\\i\\u\\tab\\tx';

const COMPRESSED = 0x75465a4c; // "LZFu"
const UNCOMPRESSED = 0x414c454d; // "MELA"

/** Unpacks PR_RTF_COMPRESSED: a 4 KiB dictionary that starts with common RTF, and references into it. */
export function decompressRtf(data: Uint8Array): Uint8Array {
  if (data.length < 16) throw new Error('The RTF body is too short.');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const size = view.getUint32(0, true) + 4;
  const rawSize = view.getUint32(4, true);
  const type = view.getUint32(8, true);
  if (type === UNCOMPRESSED) return data.slice(16, 16 + rawSize);
  if (type !== COMPRESSED) throw new Error('The RTF body is compressed in an unknown way.');

  const dict = new Uint8Array(4096);
  for (let i = 0; i < PREBUF.length; i++) dict[i] = PREBUF.charCodeAt(i);
  let write = PREBUF.length;
  // The size in the header is a hint; the output grows if it was wrong.
  let out = new Uint8Array(Math.min(Math.max(rawSize, 1024), 64 << 20));
  let length = 0;
  const put = (byte: number) => {
    if (length === out.length) {
      const bigger = new Uint8Array(out.length * 2);
      bigger.set(out);
      out = bigger;
    }
    out[length++] = byte;
    dict[write] = byte;
    write = (write + 1) & 4095;
  };

  const end = Math.min(data.length, size);
  let pos = 16;
  run: while (pos < end) {
    const control = data[pos++];
    for (let bit = 0; bit < 8 && pos < end; bit++) {
      if (!(control & (1 << bit))) {
        put(data[pos++]);
        continue;
      }
      if (pos + 1 >= end) break run;
      const word = (data[pos] << 8) | data[pos + 1];
      pos += 2;
      const offset = word >> 4;
      // A reference to the write position ends the data.
      if (offset === write) break run;
      const count = (word & 15) + 2;
      for (let i = 0; i < count; i++) put(dict[(offset + i) & 4095]);
    }
  }
  return out.subarray(0, length);
}

// ---- De-encapsulation -------------------------------------------------------------------------------------------------

// Destinations whose text is not part of the message.
const SKIPPED = new Set([
  'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'footer', 'headerl', 'headerr', 'footerl', 'footerr',
  'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'xmlnstbl', 'themedata', 'colorschememapping', 'latentstyles',
  'datastore', 'fldinst', 'filetbl', 'revtbl', 'pgdsctbl', 'bkmkstart', 'bkmkend', 'nonshppict', 'shppict', 'mmathPr',
]);

const SYMBOLS: Record<string, string> = {
  par: '\r\n', line: '\r\n', tab: '\t', emdash: '—', endash: '–', lquote: '‘', rquote: '’',
  ldblquote: '“', rdblquote: '”', bullet: '•', emspace: ' ', enspace: ' ', qmspace: ' ',
};

function decoderFor(codepage: number): TextDecoder {
  const label = codepage >= 1250 && codepage <= 1258 ? `windows-${codepage}` : ({ 932: 'shift_jis', 936: 'gbk', 949: 'euc-kr', 950: 'big5', 874: 'windows-874', 65001: 'utf-8' } as Record<number, string>)[codepage];
  try {
    return new TextDecoder(label ?? 'windows-1252');
  } catch {
    return new TextDecoder('windows-1252');
  }
}

interface GroupState {
  /** Inside a destination whose text is left out. */
  skip: boolean;
  /** Inside \*\htmltag: the text is HTML markup. */
  tag: boolean;
  /** \htmlrtf: RTF that only stands in for the HTML, left out. */
  rtfOnly: boolean;
  /** Characters to skip after \uN. */
  uc: number;
}

/**
 * The HTML (\fromhtml1) or plain text (\fromtext) that Outlook wrapped into the RTF body; null for RTF of its own,
 * which then is the message's formatting.
 */
export function unwrapRtf(rtf: Uint8Array): { kind: 'html' | 'text'; content: string } | null {
  const head = new TextDecoder('latin1').decode(rtf.subarray(0, 4096));
  const kind = /\\fromhtml1/.test(head) ? 'html' : /\\fromtext/.test(head) ? 'text' : null;
  if (!kind) return null;
  let decoder = decoderFor(Number(/\\ansicpg(\d+)/.exec(head)?.[1] ?? 1252));

  let output = '';
  const bytes: number[] = [];
  const flush = () => {
    if (bytes.length) output += decoder.decode(new Uint8Array(bytes));
    bytes.length = 0;
  };
  const stack: GroupState[] = [];
  let state: GroupState = { skip: false, tag: false, rtfOnly: false, uc: 1 };
  let pendingSkip = 0;
  // After \*\mhtmltagN (the tag with its cid: links) the \*\htmltagN that repeats it is left out.
  let skipTag: number | null = null;
  let destination = false;
  let groupStart = false;

  const visible = () => !state.skip && (state.tag || !state.rtfOnly);
  const emitByte = (byte: number) => {
    if (pendingSkip > 0) {
      pendingSkip--;
      return;
    }
    if (visible()) bytes.push(byte);
  };
  const emitText = (text: string) => {
    if (!visible()) return;
    flush();
    output += text;
  };

  let i = 0;
  while (i < rtf.length) {
    const c = rtf[i];
    if (c === 0x7b) {
      // {
      stack.push(state);
      state = { ...state };
      groupStart = true;
      destination = false;
      i++;
      continue;
    }
    if (c === 0x7d) {
      // }
      if (state.tag) flush();
      state = stack.pop() ?? state;
      groupStart = false;
      destination = false;
      pendingSkip = 0;
      i++;
      continue;
    }
    if (c === 0x0d || c === 0x0a) {
      i++;
      continue;
    }
    if (c !== 0x5c) {
      // Plain text.
      groupStart = false;
      emitByte(c);
      i++;
      continue;
    }
    // A backslash: control word or symbol.
    const next = rtf[i + 1];
    if (next === undefined) break;
    if (next === 0x27) {
      // \'hh
      const byte = parseInt(String.fromCharCode(rtf[i + 2], rtf[i + 3]), 16);
      if (!Number.isNaN(byte)) emitByte(byte);
      i += 4;
      groupStart = false;
      continue;
    }
    const isLetter = (b: number) => (b >= 0x61 && b <= 0x7a) || (b >= 0x41 && b <= 0x5a);
    if (!isLetter(next)) {
      i += 2;
      if (next === 0x2a) {
        // \* marks the group as a destination; the next control word names it.
        destination = true;
        continue;
      }
      groupStart = false;
      if (next === 0x5c || next === 0x7b || next === 0x7d) emitByte(next);
      else if (next === 0x7e) emitText(' ');
      else if (next === 0x5f) emitText('‑');
      else if (next === 0x0d || next === 0x0a) emitText('\r\n');
      continue;
    }
    let j = i + 1;
    while (j < rtf.length && isLetter(rtf[j])) j++;
    const word = String.fromCharCode(...rtf.subarray(i + 1, j));
    let k = j;
    if (rtf[k] === 0x2d) k++;
    while (k < rtf.length && rtf[k] >= 0x30 && rtf[k] <= 0x39) k++;
    const param = k > j ? Number(String.fromCharCode(...rtf.subarray(j, k))) : null;
    if (rtf[k] === 0x20) k++;
    i = k;

    const first = groupStart;
    groupStart = false;
    if (state.skip) continue;
    if (first && (destination || SKIPPED.has(word))) {
      destination = false;
      if (word === 'mhtmltag') {
        flush();
        state.tag = true;
        skipTag = param;
      } else if (word === 'htmltag' && (skipTag === null || skipTag !== param)) {
        flush();
        state.tag = true;
        skipTag = null;
      } else {
        if (word === 'htmltag') skipTag = null;
        state.skip = true;
      }
      continue;
    }
    switch (word) {
      case 'htmlrtf':
        state.rtfOnly = param !== 0;
        break;
      case 'uc':
        state.uc = param ?? 1;
        break;
      case 'u':
        if (param !== null) emitText(String.fromCharCode(param < 0 ? param + 65536 : param));
        pendingSkip = state.uc;
        break;
      case 'ansicpg':
        if (param) {
          flush();
          decoder = decoderFor(param);
        }
        break;
      case 'bin':
        i += Math.max(0, param ?? 0);
        break;
      default:
        if (SYMBOLS[word]) emitText(SYMBOLS[word]);
    }
  }
  flush();
  return { kind, content: output };
}
