// SPDX-License-Identifier: GPL-3.0-or-later
// The container of SolidWorks 2015 and later: after an 8-byte header, a run of ZIP-like local records whose names are
// nibble-swapped and whose payloads are raw DEFLATE (cadmpeg's format notes, CC-BY-4.0). Index records in between
// reuse the same field marker but scale their size fields; they fail the checks below and are skipped.

export interface SwRecord {
  name: string;
  offset: number;
  compressed: number;
  size: number;
}

const MARKER = [0x14, 0x00, 0x06, 0x00, 0x08, 0x00];

/** SolidWorks 2015+: a per-file random first word, then version 4 as a big-endian word. */
export function isSwContainer(head: Uint8Array): boolean {
  return head.length >= 8 && head[4] === 0 && head[5] === 0 && head[6] === 0 && head[7] === 4;
}

export function swRecords(data: Uint8Array): SwRecord[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const records: SwRecord[] = [];
  let p = 8;
  while (p + 30 <= data.length) {
    const m = data.indexOf(MARKER[0], p + 4);
    if (m < 0 || m + 26 > data.length) break;
    if (MARKER.some((b, i) => data[m + i] !== b)) {
      p = m - 3;
      continue;
    }
    const start = m - 4;
    const crc = view.getUint32(start + 14, true);
    const compressed = view.getUint32(start + 18, true);
    const size = view.getUint32(start + 22, true);
    const nameLength = view.getUint16(start + 26, true);
    const extraLength = view.getUint16(start + 28, true);
    const dataStart = start + 30 + nameLength + extraLength;
    // Index cells hold one length L three times: 2L in the CRC field, L/2 as compressed and L as uncompressed size.
    const indexCell = crc === 2 * size && compressed === Math.floor(size / 2);
    const plausible = !indexCell && nameLength > 0 && nameLength < 500 && dataStart + compressed <= data.length && compressed > 0;
    let name = '';
    if (plausible) {
      for (let i = 0; i < nameLength; i++) {
        const b = data[start + 30 + i];
        name += String.fromCharCode(((b & 0x0f) << 4) | (b >> 4));
      }
    }
    if (plausible && /^[\x20-\x7e]+$/.test(name)) {
      records.push({ name, offset: dataStart, compressed, size });
      p = dataStart + compressed;
    } else {
      p = m + 2;
    }
  }
  return records;
}

export async function inflateRaw(bytes: Uint8Array, expected?: number): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  if (expected !== undefined && expected > 0 && out.length !== expected) throw new Error('Damaged SolidWorks record.');
  return out;
}

export async function readSwRecord(data: Uint8Array, record: SwRecord): Promise<Uint8Array> {
  return inflateRaw(data.subarray(record.offset, record.offset + record.compressed), record.size);
}
