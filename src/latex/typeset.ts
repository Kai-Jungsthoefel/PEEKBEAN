// SPDX-License-Identifier: GPL-3.0-or-later
// LaTeX to PDF with TeX Live in a worker (workers/latex.worker.ts), for the LaTeX viewer and the converter. A project
// is a single .tex file or an archive of one (as Overleaf and most editors export them).
import { extensionOf, startsWith } from '../core/bytes';
import type { LatexRequest, LatexResponse } from '../workers/latex.worker';
import { documentsOf, type Engine, isDocument, latexErrors, missingFiles } from './project';

export interface LatexProject {
  files: Record<string, Uint8Array>;
  main: string;
  /** Every document of the project, the main file first; a folder may hold an article and its slides */
  documents: string[];
}

export interface Typeset {
  pdf: Uint8Array | null;
  log: string;
  engine: Engine;
  /** What the reader should know: files that were missing, what could not be done */
  notes: string[];
}

const ARCHIVES = ['zip', '7z', 'rar', 'tar', 'tgz', 'gz'];
// Folders and files of editors and operating systems, never part of the document
const JUNK = /(^|\/)(__MACOSX|\.git|\.DS_Store$|\._)/;
const MAX_FILE = 200 * 1024 * 1024;

export async function isArchive(file: File): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  return startsWith(head, 'PK\x03\x04') || startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) || startsWith(head, 'Rar!') || ARCHIVES.includes(extensionOf(file.name));
}

/** The project in a file: the .tex file alone, or every file of an archive with the document among them */
export async function readProject(file: File): Promise<LatexProject> {
  if (!(await isArchive(file))) {
    const data = new Uint8Array(await file.arrayBuffer());
    return { files: { [file.name]: data }, main: file.name, documents: isDocument(new TextDecoder('latin1').decode(data)) ? [file.name] : [] };
  }
  const { openArchive } = await import('../viewers/archive');
  const archive = await openArchive(file);
  const files: Record<string, Uint8Array> = {};
  try {
    for (const entry of archive.entries) {
      const path = entry.dir + entry.name;
      if (JUNK.test(path) || entry.encrypted || entry.symlink || entry.size > MAX_FILE) continue;
      files[path] = new Uint8Array(await (await entry.read()).arrayBuffer());
    }
  } finally {
    await archive.close();
  }
  // A project packed with its folder: everything inside one top folder is read as if it were not there
  const top = Object.keys(files).map((path) => path.split('/')[0]);
  const prefix = top.length && Object.keys(files).every((path) => path.includes('/')) && top.every((t) => t === top[0]) ? `${top[0]}/` : '';
  const unpacked = Object.fromEntries(Object.entries(files).map(([path, data]) => [path.slice(prefix.length), data]));
  const decoder = new TextDecoder('latin1');
  const texts = Object.fromEntries(Object.entries(unpacked).filter(([path]) => /\.(tex|ltx|latex)$/i.test(path)).map(([path, data]) => [path, decoder.decode(data)]));
  const documents = documentsOf(texts, file.name.replace(/\.[^.]+$/, ''));
  if (!documents.length) throw new Error('The archive contains no LaTeX document (a .tex file with \\documentclass and \\begin{document}).');
  return { files: unpacked, main: documents[0], documents };
}

/** Typesets the project; the worker ends with it, or when the signal aborts */
export function typeset(project: Pick<LatexProject, 'files' | 'main'>, progress: (message: string, fraction?: number) => void, signal?: AbortSignal): Promise<Typeset> {
  const worker = new Worker(new URL('../workers/latex.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<Typeset>((resolve, reject) => {
    signal?.addEventListener('abort', () => {
      worker.terminate();
      reject(new DOMException('Typesetting was cancelled.', 'AbortError'));
    });
    worker.onmessage = ({ data }: MessageEvent<LatexResponse>) => {
      if (data.kind === 'progress') return progress(data.message, data.fraction);
      worker.terminate();
      if (data.kind === 'error') return reject(new Error(data.message));
      const notes = [...data.notes];
      const missing = missingFiles(data.log).filter((name) => !(name in project.files));
      if (missing.length) {
        const single = Object.keys(project.files).length === 1;
        notes.unshift(`Not found: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` and ${missing.length - 5} more` : ''}.${single ? ' Open the whole project as a ZIP archive to typeset it with its pictures and the files it includes.' : ''}`);
      }
      resolve({ pdf: data.pdf, log: data.log, engine: data.engine, notes });
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'TeX stopped unexpectedly.'));
    };
    const request: LatexRequest = { base: new URL('texlive/', document.baseURI).href, files: project.files, main: project.main };
    worker.postMessage(request);
  });
}

/** The first errors of a run, for a message in place of the PDF */
export function errorSummary(log: string, limit = 3): string[] {
  return latexErrors(log).slice(0, limit).map((e) => (e.line ? `Line ${e.line}: ${e.message}` : e.message));
}
