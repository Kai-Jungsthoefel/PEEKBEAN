// SPDX-License-Identifier: GPL-3.0-or-later
// WAV files from decoded sound, and the sample rate a compressed file was recorded with. The browser's decoder
// resamples to the rate it is asked for, so that rate is read from the file's header first.

/** Speaker positions of the usual layouts (front left and right, center, LFE, back, side), by channel count. */
const CHANNEL_MASKS = [0, 0x4, 0x3, 0x7, 0x33, 0x37, 0x3f, 0x13f, 0x63f];

/**
 * A RIFF WAVE file: integer PCM with 16 or 24 bits, or 32-bit float. More than two channels need the extensible
 * header, which says which speaker each channel is for.
 */
export function writeWav(sound: AudioBuffer, bits: 16 | 24 | 32): Uint8Array<ArrayBuffer> {
  const channels = sound.numberOfChannels;
  const bytes = bits / 8;
  const size = sound.length * channels * bytes;
  const extensible = channels > 2;
  const header = extensible ? 68 : 44;
  if (header + size > 0xffffffff) throw new Error('The sound is too long for a WAV file (more than 4 GB).');
  const out = new Uint8Array(header + size);
  const view = new DataView(out.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((c, i) => (out[offset + i] = c.charCodeAt(0)));
  // 1 is integer PCM, 3 IEEE float; 0xfffe the extensible header with that code in its sub-format.
  const format = bits === 32 ? 3 : 1;
  ascii(0, 'RIFF');
  view.setUint32(4, header - 8 + size, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, extensible ? 40 : 16, true);
  view.setUint16(20, extensible ? 0xfffe : format, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sound.sampleRate, true);
  view.setUint32(28, sound.sampleRate * channels * bytes, true);
  view.setUint16(32, channels * bytes, true);
  view.setUint16(34, bits, true);
  if (extensible) {
    view.setUint16(36, 22, true);
    view.setUint16(38, bits, true);
    view.setUint32(40, CHANNEL_MASKS[channels] ?? 0, true);
    // The sub-format GUID 0000000X-0000-0010-8000-00AA00389B71.
    view.setUint32(44, format, true);
    out.set([0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71], 48);
  }
  ascii(header - 8, 'data');
  view.setUint32(header - 4, size, true);
  const data = Array.from({ length: channels }, (_, c) => sound.getChannelData(c));
  let offset = header;
  for (let i = 0; i < sound.length; i++) {
    for (let c = 0; c < channels; c++) {
      const sample = data[c][i];
      if (bits === 32) {
        view.setFloat32(offset, sample, true);
      } else {
        // Decoders may overshoot a little; clipped rather than wrapped around.
        const clipped = Math.max(-1, Math.min(1, sample));
        const max = bits === 16 ? 0x7fff : 0x7fffff;
        const value = Math.round(clipped < 0 ? clipped * (max + 1) : clipped * max);
        if (bits === 16) view.setInt16(offset, value, true);
        else {
          out[offset] = value & 0xff;
          out[offset + 1] = (value >> 8) & 0xff;
          out[offset + 2] = (value >> 16) & 0xff;
        }
      }
      offset += bytes;
    }
  }
  return out;
}

const MP3_RATES = [
  [11025, 12000, 8000],
  [0, 0, 0],
  [22050, 24000, 16000],
  [44100, 48000, 32000],
];
const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

const plausible = (rate: number) => (Number.isInteger(rate) && rate >= 8000 && rate <= 384000 ? rate : null);

/** Index of an ASCII text in the bytes, or -1. */
function find(bytes: Uint8Array, text: string, from = 0, to = bytes.length): number {
  const first = text.charCodeAt(0);
  const end = Math.min(to, bytes.length) - text.length;
  outer: for (let i = from; i <= end; i++) {
    if (bytes[i] !== first) continue;
    for (let j = 1; j < text.length; j++) if (bytes[i + j] !== text.charCodeAt(j)) continue outer;
    return i;
  }
  return -1;
}

/** The sample rate the file states in its header; null for formats or files where it is not found. */
export function sampleRate(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = (text: string, offset = 0) => find(bytes, text, offset, offset + text.length) === offset;
  if (bytes.length < 64) return null;
  if (at('RIFF') && at('WAVE', 8)) {
    const fmt = find(bytes, 'fmt ', 12, 4096);
    return fmt < 0 ? null : plausible(view.getUint32(fmt + 12, true));
  }
  if (at('fLaC')) return plausible((bytes[18] << 12) | (bytes[19] << 4) | (bytes[20] >> 4));
  if (at('OggS')) {
    if (find(bytes, 'OpusHead', 0, 512) >= 0) return 48000;
    const vorbis = find(bytes, '\x01vorbis', 0, 512);
    if (vorbis >= 0) return plausible(view.getUint32(vorbis + 12, true));
    const flac = find(bytes, 'fLaC', 0, 512);
    return flac < 0 ? null : plausible((bytes[flac + 18] << 12) | (bytes[flac + 19] << 4) | (bytes[flac + 20] >> 4));
  }
  if (at('ftyp', 4)) {
    // The sample entry of the sound track, searched in the movie box only: the same four letters may well occur in
    // the media data. The movie box may sit at the end of the file.
    let moov = 0;
    let end = 0;
    for (let box = 0; box + 16 <= bytes.length; ) {
      const size32 = view.getUint32(box);
      const size = size32 === 1 ? Number(view.getBigUint64(box + 8)) : size32 === 0 ? bytes.length - box : size32;
      if (size < 8) return null;
      if (at('moov', box + 4)) {
        [moov, end] = [box, Math.min(bytes.length, box + size)];
        break;
      }
      box += size;
    }
    if (!end) return null;
    for (const [type, fixed] of [['mp4a', 0], ['alac', 0], ['fLaC', 0], ['Opus', 48000], ['ac-3', 0], ['ec-3', 0]] as const) {
      const entry = find(bytes, type, moov, end);
      if (entry < 4 || entry + 30 > bytes.length) continue;
      if (fixed) return fixed;
      // QuickTime's version 2 sound description keeps the rate as a float elsewhere.
      if (view.getUint16(entry + 12) === 2) return entry + 44 <= bytes.length ? plausible(view.getFloat64(entry + 36)) : null;
      return plausible(view.getUint16(entry + 28));
    }
    return null;
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    // Matroska and WebM: the SamplingFrequency element (0xB5) of the audio track, a 4- or 8-byte float.
    const limit = Math.min(bytes.length - 10, 4 << 20);
    for (let i = 0; i < limit; i++) {
      if (bytes[i] !== 0xb5) continue;
      const rate = bytes[i + 1] === 0x88 ? view.getFloat64(i + 2) : bytes[i + 1] === 0x84 ? view.getFloat32(i + 2) : 0;
      if (plausible(rate)) return rate;
    }
    return null;
  }
  // MP3 and ADTS AAC: the first frame header, after an ID3 tag.
  let offset = at('ID3') ? 10 + ((bytes[6] << 21) | (bytes[7] << 14) | (bytes[8] << 7) | bytes[9]) + (bytes[5] & 0x10 ? 10 : 0) : 0;
  for (const end = Math.min(bytes.length - 4, offset + 65536); offset < end; offset++) {
    if (bytes[offset] !== 0xff || (bytes[offset + 1] & 0xe0) !== 0xe0) continue;
    const b1 = bytes[offset + 1];
    const b2 = bytes[offset + 2];
    const layer = (b1 >> 1) & 3;
    if ((b1 & 0xf6) === 0xf0) {
      const index = (b2 >> 2) & 0xf;
      if (index < ADTS_RATES.length) return ADTS_RATES[index];
    } else if (layer !== 0 && ((b1 >> 3) & 3) !== 1 && (b2 >> 4) !== 15 && ((b2 >> 2) & 3) !== 3) {
      return MP3_RATES[(b1 >> 3) & 3][(b2 >> 2) & 3];
    }
  }
  return null;
}
