// SPDX-License-Identifier: GPL-3.0-or-later
// Sound to WAV: decoded by the browser (MP3, AAC, Ogg Vorbis and Opus, FLAC, and the sound track of videos) at the
// sample rate the file was recorded with, then written as PCM.
import { resultName } from '../files';
import { sampleRate, writeWav } from '../audio/wav';
import type { ConvertContext, ConvertResult } from '../types';

const rates = new Intl.NumberFormat('en-US');

export async function convert({ file, options, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading file …');
  const data = await file.arrayBuffer();
  const stated = sampleRate(new Uint8Array(data));
  const rate = stated ?? 48000;
  progress('Decoding sound …');
  let sound: AudioBuffer;
  try {
    // Offline, so nothing is played; the length does not matter for decoding.
    sound = await new OfflineAudioContext(1, 1, rate).decodeAudioData(data);
  } catch {
    throw new Error('This browser cannot decode the sound of this file, or the file has no sound track.');
  }
  progress('Writing WAV …');
  const bits = Number(options.bits) as 16 | 24 | 32;
  const wav = writeWav(sound, bits);
  const channels = sound.numberOfChannels === 1 ? 'mono' : sound.numberOfChannels === 2 ? 'stereo' : `${sound.numberOfChannels} channels`;
  const notes = [`${rates.format(sound.sampleRate)} Hz, ${channels}, ${bits === 32 ? '32-bit float' : `${bits}-bit`}.`];
  if (!stated) notes.push('The file does not state its sample rate where it could be read; the sound was decoded at 48,000 Hz.');
  return { files: [new File([wav], resultName(file.name, 'wav'), { type: 'audio/wav' })], notes };
}
