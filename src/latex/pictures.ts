// SPDX-License-Identifier: GPL-3.0-or-later
// The pictures a LaTeX project shows with \includegraphics, for Word: PNG, JPEG and GIF as they are, PDF figures
// rendered by pdf.js (first page). Found as pdfLaTeX finds them: in the main file's folder and the \graphicspath
// folders, with the extensions it tries.
import { projectFile } from './project';

export interface Picture {
  data: Uint8Array;
  type: 'png' | 'jpg' | 'gif';
  /** Natural size in points */
  width: number;
  height: number;
}

const EXTENSIONS = ['pdf', 'png', 'jpg', 'jpeg', 'gif'];
/** PDF figures are rendered at twice their size, sharp enough for print at the size they have in the document */
const PDF_SCALE = 2;

const withoutComments = (source: string) => source.replace(/(^|[^\\])%.*$/gm, '$1');

/** The names of the pictures the source shows with \includegraphics */
export const pictureNames = (source: string) => [...new Set([...withoutComments(source).matchAll(/\\includegraphics\s*\*?\s*(?:\[[^\]]*\]\s*)*\{([^{}]+)\}/g)].map((m) => m[1].trim()))];

/** Every picture the source shows that is in the project, by the name it is given in \includegraphics */
export async function loadPictures(files: Record<string, Uint8Array>, main: string, source: string): Promise<Map<string, Picture>> {
  const folders = [''];
  for (const m of withoutComments(source).matchAll(/\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/g)) for (const f of m[1].matchAll(/\{([^{}]*)\}/g)) folders.push(f[1]);
  const pictures = new Map<string, Picture>();
  for (const name of pictureNames(source)) {
    // Names with spaces may stand in quotes: \includegraphics{"Motoren übersicht"}
    const path = folders.map((folder) => projectFile(files, main, folder + name.replace(/^"(.*)"$/, '$1'), EXTENSIONS)).find(Boolean);
    if (!path) continue;
    const picture = await load(files[path], path.slice(path.lastIndexOf('.') + 1).toLowerCase()).catch(() => null);
    if (picture) pictures.set(name, picture);
  }
  return pictures;
}

async function load(data: Uint8Array, extension: string): Promise<Picture | null> {
  if (extension === 'pdf') return renderPdf(data);
  const type = extension === 'png' ? 'png' : extension === 'gif' ? 'gif' : extension === 'jpg' || extension === 'jpeg' ? 'jpg' : null;
  if (!type) return null;
  const bitmap = await createImageBitmap(new Blob([data as BlobPart]));
  // Pixels count as points, as pdfLaTeX takes pictures without a resolution of their own
  const picture = { data, type, width: bitmap.width, height: bitmap.height } as const;
  bitmap.close();
  return picture;
}

async function renderPdf(data: Uint8Array): Promise<Picture> {
  const pdfjsLib = await import('pdfjs-dist');
  const { default: workerUrl } = await import('pdfjs-dist/build/pdf.worker.min.mjs?url');
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
  const assetUrl = (dir: string) => new URL(`pdfjs/${dir}/`, document.baseURI).href;
  // pdf.js takes over the buffer it is given
  const task = pdfjsLib.getDocument({ data: data.slice(), cMapUrl: assetUrl('cmaps'), cMapPacked: true, standardFontDataUrl: assetUrl('standard_fonts'), wasmUrl: assetUrl('wasm'), iccUrl: assetUrl('iccs') });
  try {
    const page = await (await task.promise).getPage(1);
    const size = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: PDF_SCALE });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    // Figures are often transparent; Word shows them on white paper
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport }).promise;
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('The figure could not be rendered.');
    return { data: new Uint8Array(await blob.arrayBuffer()), type: 'png', width: size.width, height: size.height };
  } finally {
    await task.destroy();
  }
}
