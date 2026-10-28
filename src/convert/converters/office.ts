// SPDX-License-Identifier: GPL-3.0-or-later
// Word and PowerPoint to PDF through ooxml-pages: the pages are drawn as in the viewer, then written as PDF with real
// text, embedded fonts and vector graphics. Office's own fonts may not be shipped, but open ones with the same widths
// may (Carlito for Calibri, Caladea for Cambria, Arimo, Tinos and Cousine for Arial, Times New Roman and Courier
// New), plus symbol and math fonts. They come with the site and are fetched only for the fonts a document uses.
import { type PdfFontSource, type PdfProgress, docxToPdf, pptxToPdf } from 'ooxml-pages/pdf';
import 'ooxml-pages/docx.css';
import 'ooxml-pages/pptx.css';
import { resultName } from '../files';
import type { ConvertContext, ConvertResult } from '../types';

// URLs only; each font is split into files by script (latin, cyrillic, greek …), which together make the font.
const FILES = import.meta.glob('../../../node_modules/@fontsource/{carlito,caladea,arimo,tinos,cousine,noto-sans-symbols,noto-sans-symbols-2,noto-sans-math,stix-two-math}/files/*.woff', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const SYMBOLS = ['noto-sans-symbols-2', 'noto-sans-symbols', 'noto-sans-math'];

/** Office fonts, their open substitutes and the generic families → font packages. */
const FAMILIES: Record<string, string[]> = {
  calibri: ['carlito'],
  carlito: ['carlito'],
  cambria: ['caladea'],
  caladea: ['caladea'],
  arial: ['arimo'],
  helvetica: ['arimo'],
  arimo: ['arimo'],
  'liberation sans': ['arimo'],
  'times new roman': ['tinos'],
  times: ['tinos'],
  tinos: ['tinos'],
  'liberation serif': ['tinos'],
  'courier new': ['cousine'],
  courier: ['cousine'],
  cousine: ['cousine'],
  'liberation mono': ['cousine'],
  'cambria math': ['stix-two-math', ...SYMBOLS],
  'segoe ui symbol': SYMBOLS,
  'segoe ui emoji': SYMBOLS,
  'sans-serif': ['carlito'],
  serif: ['tinos'],
  monospace: ['cousine'],
  symbol: SYMBOLS,
};

const fonts: PdfFontSource = async (name, { bold, italic }) => {
  const packages = FAMILIES[name.toLowerCase()];
  if (!packages) return null;
  const suffix = `-${bold ? 700 : 400}-${italic ? 'italic' : 'normal'}.woff`;
  const urls = packages.flatMap((p) => Object.entries(FILES).filter(([path]) => path.includes(`/@fontsource/${p}/files/`) && path.endsWith(suffix)).map(([, url]) => url));
  return Promise.all(urls.map(async (url) => new Uint8Array(await (await fetch(url)).arrayBuffer())));
};

const STEPS: Record<PdfProgress['phase'], string> = {
  fonts: 'Loading fonts …',
  layout: 'Laying out pages …',
  pages: 'Writing PDF pages …',
};

export async function convert({ file, viewer, progress }: ConvertContext): Promise<ConvertResult> {
  const options = {
    fonts,
    title: file.name.replace(/\.[^.]+$/, ''),
    creator: 'Peekbean',
    onProgress: ({ phase, fraction }: PdfProgress) => progress(STEPS[phase], fraction),
  };
  const { pdf, notes } = viewer === 'pptx' ? await pptxToPdf(file, options) : await docxToPdf(file, options);
  return { files: [new File([pdf as Uint8Array<ArrayBuffer>], resultName(file.name, 'pdf'), { type: 'application/pdf' })], notes };
}
