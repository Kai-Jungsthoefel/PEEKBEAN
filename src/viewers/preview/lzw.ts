// SPDX-License-Identifier: GPL-3.0-or-later
// Unix compress (.Z) LZW decoding, as Creo uses it for sections of its files. Codes are packed LSB first in groups of
// n_bits bytes; widening the codes or a clear code discards the rest of the current group, as ncompress does.

export function isCompress(bytes: Uint8Array): boolean {
  return bytes.length > 3 && bytes[0] === 0x1f && bytes[1] === 0x9d;
}

export function uncompress(input: Uint8Array, limit = 256 * 1024 * 1024): Uint8Array {
  if (!isCompress(input)) throw new Error('Not LZW compressed.');
  const maxBits = Math.min(16, Math.max(9, input[2] & 0x1f));
  const blockMode = (input[2] & 0x80) !== 0;
  const maxMaxCode = 1 << maxBits;
  const prefix = new Uint16Array(maxMaxCode);
  const suffix = new Uint8Array(maxMaxCode);
  for (let i = 0; i < 256; i++) suffix[i] = i;
  const totalBits = input.length * 8;

  let bit = 24;
  let groupStart = bit;
  let bits = 9;
  let maxCode = (1 << bits) - 1;
  let free = blockMode ? 257 : 256;
  let clear = false;

  const read = (): number => {
    if (clear || free > maxCode) {
      // Skip to the end of the current group of `bits` bytes.
      const group = bits * 8;
      const used = (bit - groupStart) % group;
      if (used) bit += group - used;
      groupStart = bit;
      if (free > maxCode) {
        bits++;
        maxCode = bits === maxBits ? maxMaxCode : (1 << bits) - 1;
      }
      if (clear) {
        bits = 9;
        maxCode = (1 << bits) - 1;
        clear = false;
      }
    }
    if (bit + bits > totalBits) return -1;
    let code = 0;
    for (let i = 0; i < bits; i++) {
      const b = bit + i;
      if (input[b >> 3] & (1 << (b & 7))) code |= 1 << i;
    }
    bit += bits;
    return code;
  };

  const out: number[] = [];
  const chunks: Uint8Array[] = [];
  let written = 0;
  const flush = () => {
    chunks.push(Uint8Array.from(out));
    written += out.length;
    out.length = 0;
  };
  let old = read();
  if (old < 0) return new Uint8Array(0);
  let finChar = old;
  out.push(old);
  const stack: number[] = [];
  for (let code = read(); code >= 0; code = read()) {
    if (code === 256 && blockMode) {
      free = 256;
      clear = true;
      code = read();
      if (code < 0) break;
    }
    const incoming = code;
    if (code >= free) {
      // The code being defined right now: the previous string plus its own first byte.
      stack.push(finChar);
      code = old;
    }
    while (code >= 256) {
      stack.push(suffix[code]);
      code = prefix[code];
      // A chain longer than the dictionary only comes from damaged data.
      if (stack.length > maxMaxCode) throw new Error('Damaged LZW data.');
    }
    finChar = suffix[code];
    stack.push(finChar);
    while (stack.length) out.push(stack.pop()!);
    if (free < maxMaxCode) {
      prefix[free] = old;
      suffix[free] = finChar;
      free++;
    }
    old = incoming;
    if (out.length > 65536) flush();
    if (written + out.length > limit) throw new Error('LZW data too large.');
  }
  flush();
  const result = new Uint8Array(written);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
