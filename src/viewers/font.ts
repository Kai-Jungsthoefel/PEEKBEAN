// SPDX-License-Identifier: GPL-3.0-or-later
// Renders with the browser's own font engine; names and glyph counts come from opentype.js (MIT).
import opentype from 'opentype.js';
import { h } from '../core/dom';
import type { ViewerContext } from '../core/types';

const SAMPLE = 'The quick brown fox jumps over the lazy dog.';
const SIZES = [12, 16, 24, 32, 48, 72];
const CHARACTERS = [
  'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz', '0123456789', 'ÄÖÜäöüß ÀÉÈÇÑØÅ àéèçñøå',
  '.,:;!?¡¿ \'"«»„“”‚‘’ ()[]{} /\\|', '@#&%‰§¶*+−±×÷=≠≈<>≤≥ €$£¥¢ ~^°_–—…•',
].join('');

interface FontInfo {
  family?: string;
  style?: string;
  version?: string;
  copyright?: string;
  license?: string;
  glyphs?: number;
}

function readInfo(buffer: ArrayBuffer): FontInfo {
  try {
    const font = opentype.parse(buffer);
    const name = (key: string) => font.names?.[key]?.en ?? Object.values(font.names?.[key] ?? {})[0];
    return {
      family: name('fontFamily'),
      style: name('fontSubfamily'),
      version: name('version'),
      copyright: name('copyright'),
      license: name('license'),
      glyphs: font.numGlyphs,
    };
  } catch {
    // WOFF2 and some collections are beyond opentype.js; the browser can still render them.
    return {};
  }
}

export async function mount({ file, container, toolbar }: ViewerContext) {
  const buffer = await file.arrayBuffer();
  const family = `everything-viewer-font-${crypto.randomUUID()}`;
  const face = new FontFace(family, buffer);
  try {
    await face.load();
  } catch {
    throw new Error('The font file is damaged, or this browser does not support it.');
  }
  document.fonts.add(face);
  const info = readInfo(buffer);

  const fontStyle = `font-family:"${family}"`;
  const sampleInput = h('input', { class: 'font-sample-input', value: SAMPLE, title: 'Type your own sample text' });
  const lines = SIZES.map((size) => h('div', { class: 'font-line' }, h('span', { class: 'font-size c3' }, `${size}`), h('span', { style: `${fontStyle};font-size:${size}px` }, SAMPLE)));
  sampleInput.addEventListener('input', () => {
    for (const line of lines) (line.lastChild as HTMLElement).textContent = sampleInput.value || SAMPLE;
  });

  const facts = [
    ['Style', info.style],
    ['Version', info.version],
    ['Glyphs', info.glyphs?.toLocaleString('en-US')],
    ['Copyright', info.copyright],
    ['License', info.license],
  ].filter(([, value]) => value) as [string, string][];

  container.append(
    h(
      'div',
      { class: 'font-view' },
      h('h1', { class: 'font-title', style: `${fontStyle};font-size:44px` }, info.family ?? file.name),
      facts.length ? h('dl', { class: 'font-facts' }, ...facts.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])) : null,
      sampleInput,
      h('div', { class: 'font-lines' }, ...lines),
      h('div', { class: 'font-grid', style: fontStyle }, ...Array.from(CHARACTERS).filter((c) => c !== ' ').map((c) => h('span', { title: `U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}` }, c))),
    ),
  );
  toolbar.append(h('span', { class: 'meta' }, [info.family, info.style].filter(Boolean).join(' ') || 'Font'));

  return { destroy: () => document.fonts.delete(face) };
}
