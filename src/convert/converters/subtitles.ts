// SPDX-License-Identifier: GPL-3.0-or-later
// Subtitles between SubRip (SRT) and WebVTT. Both are cues with a start, an end and text; WebVTT adds positions,
// styles and voice tags, which SRT has no place for (the target's note in the catalog says so).
import { readText } from '../../core/text';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

interface Cue {
  start: number;
  end: number;
  text: string;
}

// 00:01:02,345 or, in WebVTT, also 01:02.345 without hours.
const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;
const TIMING = new RegExp(`^\\s*${TIME.source}\\s*-->\\s*${TIME.source}`);

const ms = (h: string | undefined, m: string, s: string, f: string) => ((Number(h ?? 0) * 60 + Number(m)) * 60 + Number(s)) * 1000 + Number(f.padEnd(3, '0'));

function stamp(time: number, separator: string): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  const h = Math.floor(time / 3_600_000);
  const m = Math.floor(time / 60_000) % 60;
  const s = Math.floor(time / 1000) % 60;
  return `${pad(h)}:${pad(m)}:${pad(s)}${separator}${pad(time % 1000, 3)}`;
}

/** The cues of either format: blocks separated by blank lines, each with a timing line. */
function readCues(text: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of text.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((line) => TIMING.test(line));
    // WebVTT's header, notes, styles and regions have no timing line; cue settings after it are left out.
    if (at < 0) continue;
    const m = TIMING.exec(lines[at])!;
    cues.push({ start: ms(m[1], m[2], m[3], m[4]), end: ms(m[5], m[6], m[7], m[8]), text: lines.slice(at + 1).join('\n').trim() });
  }
  return cues;
}

/** WebVTT text for SRT: voice and class tags go, the speaker stays in front; <i>, <b> and <u> are the same in both. */
function srtText(text: string): string {
  return text
    .replace(/<v(?:\.[\w.-]+)?\s+([^>]+)>/g, '$1: ')
    .replace(/<\/?(?:c|v|lang|ruby|rt)(?:[.\s][^>]*)?>/g, '')
    .replace(/<\d{2}:[\d:.]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

export async function convert({ file, target, progress }: ConvertContext): Promise<ConvertResult> {
  progress('Reading subtitles …');
  const cues = readCues((await readText(file)).text);
  if (cues.length === 0) throw new Error('The file contains no subtitles.');
  const output =
    target === 'vtt'
      ? // A cue's text may not contain "-->" in WebVTT.
        `WEBVTT\n\n${cues.map((c, i) => `${i + 1}\n${stamp(c.start, '.')} --> ${stamp(c.end, '.')}\n${c.text.replace(/-->/g, '--&gt;')}`).join('\n\n')}\n`
      : `${cues.map((c, i) => `${i + 1}\n${stamp(c.start, ',')} --> ${stamp(c.end, ',')}\n${srtText(c.text)}`).join('\n\n')}\n`;
  const notes = [`${cues.length.toLocaleString('en-US')} subtitles.`];
  return { files: [new File([output], resultName(file.name, target), { type: target === 'vtt' ? 'text/vtt' : 'application/x-subrip' })], notes };
}
