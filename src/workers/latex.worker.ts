// SPDX-License-Identifier: GPL-3.0-or-later
// Typesets a LaTeX document with TeX Live compiled to WebAssembly (busytex: pdfTeX, XeTeX, BibTeX, xdvipdfmx). The
// TeX Live tree comes from peekbean-texlive and is served by the site itself (texlive/, see vite.config.ts): one
// gzipped bundle per package, larger packages in parts. Every file of the tree is visible to TeX at once, but a
// folder's entries are made only when TeX looks into it, and a file's bundle is fetched and unpacked the first time TeX
// reads it (a synchronous request, which workers may make). Unpacked bundles stay for the worker's lifetime.
import { gunzipSync } from 'fflate';
import { engineFor, type Engine } from '../latex/project';

export interface LatexRequest {
  /** URL of the site's texlive/ folder, with trailing slash */
  base: string;
  /** The project's files by path, the main file among them */
  files: Record<string, Uint8Array>;
  main: string;
}

export type LatexResponse =
  | { kind: 'progress'; message: string; fraction?: number }
  | { kind: 'done'; pdf: Uint8Array | null; log: string; engine: Engine; notes: string[] }
  | { kind: 'error'; message: string };

interface Index {
  bundles: Record<string, { size: number; gz: number; files: number }>;
  files: Record<string, [string, number, number]>;
}

// The parts of Emscripten's file system that are used here
interface FsNode {
  node_ops: Record<string, (...args: never[]) => unknown>;
  contents?: unknown;
}
interface FS {
  mkdirTree(path: string): void;
  mkdir(path: string): FsNode;
  create(path: string, mode: number): FsNode;
  lookupPath(path: string): { node: FsNode };
  writeFile(path: string, data: Uint8Array): void;
  readFile(path: string): Uint8Array;
  readdir(path: string): string[];
  stat(path: string): { mode: number };
  isDir(mode: number): boolean;
  chdir(path: string): void;
}
interface EngineModule {
  FS: FS;
  thisProgram: string;
  callMain(args: string[]): number;
  _flush_streams?: () => void;
}
type Factory = (config: Record<string, unknown>) => Promise<EngineModule>;

const TREE = '/texlive/texmf-dist';
const WORK = '/work';
const FORMATS: Record<Engine, string> = { pdflatex: 'pdftex/pdflatex.fmt', xelatex: 'xetex/xelatex.fmt' };
/** Files of a run that the next run reads; when one changes, cross-references may still be wrong */
const AUXILIARY = /\.(aux|toc|lof|lot|out|nav|snm|bbl|ind|gls|loa|thm)$/;
const MAX_RUNS = 5;

let base = '';
let index: Index | null = null;
/** Folder (relative to the tree) → its entries: true for a folder, the file's place for a file */
let folders: Map<string, Map<string, true | [string, number, number]>> | null = null;
/** File name → path, for fetching the bundles of the packages a document names before TeX asks for them */
let byName: Map<string, string> | null = null;
let wasm: WebAssembly.Module | null = null;
let factory: Factory | null = null;
const unpacked = new Map<string, Uint8Array>();
let downloaded = 0;

const post = (message: LatexResponse) => self.postMessage(message);
const progress = (message: string, fraction?: number) => post({ kind: 'progress', message, fraction });
const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toLocaleString('en-US', { maximumFractionDigits: 1 })} MB`;

async function setup(): Promise<void> {
  if (index) return;
  progress('Loading TeX Live …');
  const response = await fetch(`${base}index.json`);
  if (!response.ok) throw new Error('This copy of Peekbean was built without TeX Live, so it cannot typeset LaTeX.');
  index = (await response.json()) as Index;
  folders = new Map([['', new Map()]]);
  byName = new Map();
  for (const [path, place] of Object.entries(index.files)) {
    const parts = path.split('/');
    let dir = '';
    for (const part of parts.slice(0, -1)) {
      const child = dir ? `${dir}/${part}` : part;
      if (!folders.has(child)) {
        folders.set(child, new Map());
        folders.get(dir)!.set(part, true);
      }
      dir = child;
    }
    folders.get(dir)!.set(parts[parts.length - 1], place);
    byName.set(parts[parts.length - 1], path);
  }
  // The engine's WebAssembly is split in two for hosts with a file size limit
  const parts = await Promise.all(['busytex.part1.wasm', 'busytex.part2.wasm'].map(async (name) => new Uint8Array(await (await fetch(`${base}engine/${name}`)).arrayBuffer())));
  const bytes = new Uint8Array(parts[0].length + parts[1].length);
  bytes.set(parts[0]);
  bytes.set(parts[1], parts[0].length);
  wasm = await WebAssembly.compile(bytes);
  // busytex.mjs is the engine's script with an export added (vite.config.ts)
  factory = ((await import(/* @vite-ignore */ `${base}engine/busytex.mjs`)) as { default: Factory }).default;
}

function store(name: string, gz: Uint8Array): Uint8Array {
  // Some servers send .gz files with Content-Encoding: gzip, and the browser has unpacked them already. The signature
  // cannot tell: a format file is gzipped itself.
  const data = gz.length === index!.bundles[name]?.size && gz.length !== index!.bundles[name]?.gz ? gz : gunzipSync(gz);
  unpacked.set(name, data);
  downloaded += gz.length;
  return data;
}

/** A bundle while TeX runs: TeX waits for the file it reads */
function bundleSync(name: string): Uint8Array {
  const done = unpacked.get(name);
  if (done) return done;
  progress(`Loading ${name.replace(/~\d+$/, '')} (${megabytes(downloaded)} so far) …`);
  const request = new XMLHttpRequest();
  request.open('GET', `${base}bundles/${encodeURIComponent(name)}.gz`, false);
  request.responseType = 'arraybuffer';
  request.send();
  if (request.status !== 200) throw new Error(`TeX Live package ${name} could not be loaded (HTTP ${request.status}).`);
  return store(name, new Uint8Array(request.response as ArrayBuffer));
}

/** Bundles fetched together before a run, so TeX seldom waits for one at a time; a package's name means all its parts */
async function prefetch(names: Iterable<string>): Promise<void> {
  const all = Object.keys(index!.bundles);
  const parts = (name: string) => (index!.bundles[name] ? [name] : all.filter((bundle) => bundle.startsWith(`${name}~`)));
  const missing = [...new Set([...names].flatMap(parts))].filter((name) => !unpacked.has(name));
  if (!missing.length) return;
  const total = missing.reduce((sum, name) => sum + index!.bundles[name].gz, 0);
  let loaded = 0;
  const queue = [...missing];
  const worker = async () => {
    for (let name = queue.shift(); name; name = queue.shift()) {
      const response = await fetch(`${base}bundles/${encodeURIComponent(name)}.gz`);
      if (!response.ok) continue;
      store(name, new Uint8Array(await response.arrayBuffer()));
      loaded += index!.bundles[name].gz;
      progress(`Loading LaTeX packages (${megabytes(loaded)} of ${megabytes(total)}) …`, loaded / total);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
}

/** The bundles holding the classes and packages a document names, and what every document needs */
function bundlesFor(files: Record<string, Uint8Array>, engine: Engine): string[] {
  const names = new Set<string>();
  const bundleOf = (file: string) => {
    const path = byName!.get(file);
    if (path) names.add(index!.files[path][0]);
  };
  const decoder = new TextDecoder('latin1');
  for (const [path, data] of Object.entries(files)) {
    if (!/\.(tex|ltx|latex|sty|cls)$/i.test(path)) continue;
    const text = decoder.decode(data).replace(/(^|[^\\])%.*$/gm, '$1');
    for (const m of text.matchAll(/\\(documentclass|usepackage|RequirePackage|LoadClass)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g)) {
      const extension = m[1] === 'documentclass' || m[1] === 'LoadClass' ? 'cls' : 'sty';
      for (const name of m[2].split(',')) bundleOf(`${name.trim()}.${extension}`);
    }
  }
  // What every document reads: the configuration, the format, the article class and the default fonts
  const always = ['texmf.cnf', 'article.cls', 'size10.clo', ...(engine === 'xelatex' ? ['l3backend-xetex.def', 'lmroman10-regular.otf'] : ['l3backend-pdftex.def', 'cmr10.tfm', 'cmr10.pfb'])];
  always.forEach(bundleOf);
  return ['~config', `fmt-${engine}`, ...names];
}

/** A fresh engine for every run: pdfTeX keeps state in C globals that do not reset between runs */
async function engine(log: string[]): Promise<EngineModule> {
  return factory!({
    thisProgram: '/bin/busytex',
    noInitialRun: true,
    noExitRuntime: true,
    instantiateWasm: (imports: WebAssembly.Imports, ready: (instance: WebAssembly.Instance) => void) => {
      void WebAssembly.instantiate(wasm!, imports).then(ready);
      return {};
    },
    print: (text: string) => log.push(text),
    printErr: (text: string) => log.push(text),
    locateFile: (path: string) => path,
    preRun: [
      (module: { ENV: Record<string, string> }) => {
        // The tree is searched through its ls-R only (!!): a tree searched on disk is walked for every file that is
        // not there, and packages probe for many optional files. The user's trees point to nothing.
        Object.assign(module.ENV, {
          TEXMFCNF: `${TREE}/web2c`, TEXMFROOT: '/texlive', TEXMFDIST: TREE, TEXMFSYSVAR: `${TREE}/texmf-var`,
          TEXMFSYSCONFIG: TREE, TEXMFLOCAL: TREE, TEXMFVAR: '/user/texmf-var', TEXMFHOME: '/user/texmf',
          TEXMFCONFIG: '/user/texmf-config', TEXMF: `!!${TREE}`, TEXMFDOTDIR: '.',
        });
      },
    ],
  });
}

/** The tree in the engine's file system: a folder gets its entries when it is first looked into */
function mountTree(fs: FS): void {
  fs.mkdirTree(TREE);
  let creating = false;
  const lazy = (node: FsNode, dir: string) => {
    const ops = node.node_ops as unknown as { lookup(parent: FsNode, name: string): FsNode; readdir(node: FsNode): string[] };
    node.node_ops = {
      ...node.node_ops,
      lookup: (parent: FsNode, name: string) => (!creating && make(dir, name)) || ops.lookup(parent, name),
      readdir: (self: FsNode) => [...new Set([...ops.readdir(self), ...(folders!.get(dir)?.keys() ?? [])])],
    } as FsNode['node_ops'];
  };
  const make = (dir: string, name: string): FsNode | null => {
    const entry = folders!.get(dir)?.get(name);
    if (!entry) return null;
    const path = dir ? `${dir}/${name}` : name;
    creating = true;
    try {
      if (entry === true) {
        const node = fs.mkdir(`${TREE}/${path}`);
        lazy(node, path);
        return node;
      }
      const node = fs.create(`${TREE}/${path}`, 0o444 | 0o100000);
      const [bundle, start, end] = entry;
      let data: Uint8Array | null = null;
      Object.defineProperties(node, {
        contents: { get: () => (data ??= bundleSync(bundle).subarray(start, end)), set: () => {}, configurable: true },
        usedBytes: { get: () => end - start, set: () => {}, configurable: true },
      });
      return node;
    } finally {
      creating = false;
    }
  };
  lazy(fs.lookupPath(TREE).node, '');
}

/** One program of the engine on the project's files; returns its exit code and the files afterwards */
async function run(args: string[], files: Record<string, Uint8Array>): Promise<{ code: number; files: Record<string, Uint8Array>; output: string }> {
  const output: string[] = [];
  const module = await engine(output);
  const fs = module.FS;
  mountTree(fs);
  for (const [path, data] of Object.entries(files)) {
    const file = `${WORK}/${path}`;
    fs.mkdirTree(file.slice(0, file.lastIndexOf('/')));
    fs.writeFile(file, data);
  }
  fs.chdir(WORK);
  try {
    fs.mkdirTree('/bin');
    fs.writeFile('/bin/busytex', new Uint8Array());
  } catch {
    // already there
  }
  module.thisProgram = `/bin/${args[0]}`;
  let code: number;
  try {
    // callMain puts the program's path in front of the arguments it is given
    code = module.callMain([...args]);
  } catch (error) {
    // A program that calls exit() ends up here
    const status = (error as { status?: unknown }).status;
    if (typeof status !== 'number') throw error;
    code = status;
  }
  module._flush_streams?.();
  const after: Record<string, Uint8Array> = {};
  const walk = (dir: string) => {
    for (const name of fs.readdir(dir)) {
      if (name === '.' || name === '..') continue;
      const path = `${dir}/${name}`;
      if (fs.isDir(fs.stat(path).mode)) walk(path);
      else after[path.slice(WORK.length + 1)] = fs.readFile(path);
    }
  };
  walk(WORK);
  return { code, files: after, output: output.join('\n') };
}

const same = (a: Uint8Array | undefined, b: Uint8Array | undefined) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

async function typeset({ files, main }: LatexRequest): Promise<void> {
  const decoder = new TextDecoder('latin1');
  const source = decoder.decode(files[main]);
  const engineName = engineFor(source);
  await setup();
  await prefetch(bundlesFor(files, engineName));
  const stem = main.replace(/\.[^./]+$/, '');
  const notes: string[] = [];
  const latex = [engineName, `-progname=${engineName}`, `-fmt=${TREE}/texmf-var/web2c/${FORMATS[engineName]}`, '-interaction=nonstopmode'];
  // XeTeX writes XDV and leaves the PDF to xdvipdfmx, which it would start as a program of its own
  if (engineName === 'xelatex') latex.push('-no-pdf');
  latex.push(main);

  let current = files;
  let log = '';
  let bibliography = false;
  for (let pass = 1; pass <= MAX_RUNS; pass++) {
    progress(pass === 1 ? 'Typesetting …' : `Typesetting, pass ${pass} …`);
    const before = current;
    const result = await run(latex, current);
    current = result.files;
    log = decoder.decode(current[`${stem}.log`] ?? new Uint8Array()) || result.output;
    if (!current[`${stem}.${engineName === 'xelatex' ? 'xdv' : 'pdf'}`]) break;
    // After the first pass: the bibliography, with BibTeX where the document asks for it
    if (pass === 1) {
      const aux = decoder.decode(current[`${stem}.aux`] ?? new Uint8Array());
      if (/\\bibdata\{/.test(aux) && /\\citation\{/.test(aux)) {
        progress('Bibliography …');
        const bib = await run(['bibtex8', stem], current);
        current = bib.files;
        bibliography = true;
      } else if (current[`${stem}.bcf`]) {
        notes.push('The bibliography is made with Biber, which Peekbean cannot run yet; citations stay unresolved. Set backend=bibtex in the biblatex options to have it typeset.');
      }
    }
    const changed = Object.keys(current).some((path) => AUXILIARY.test(path) && !same(current[path], before[path]) && (!path.endsWith('.aux') || /\\(newlabel|bibcite|@writefile)/.test(decoder.decode(current[path]))));
    if (!(bibliography && pass < 3) && !changed && !/Rerun to get|Label\(s\) may have changed|Please rerun|rerunfilecheck Warning/i.test(log)) break;
  }

  let pdf = current[`${stem}.pdf`] ?? null;
  if (engineName === 'xelatex' && current[`${stem}.xdv`]) {
    progress('Writing PDF …');
    const result = await run(['xdvipdfmx', '-o', `${stem}.pdf`, `${stem}.xdv`], current);
    pdf = result.files[`${stem}.pdf`] ?? null;
  }
  if (/fontspec Error:.*cannot be found|The font ".*" cannot be found/i.test(log)) {
    notes.push('Fonts are found by their file name only (for example texgyrepagella-regular.otf); fonts installed on a computer, such as Arial, are not available here.');
  }
  post({ kind: 'done', pdf, log, engine: engineName, notes });
}

self.onmessage = async (event: MessageEvent<LatexRequest>) => {
  try {
    base = event.data.base;
    await typeset(event.data);
  } catch (error) {
    post({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
