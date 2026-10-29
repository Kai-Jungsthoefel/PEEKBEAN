// SPDX-License-Identifier: GPL-3.0-or-later
// Builds occt-import-js (LGPL-2.1, OpenCascade's STEP/IGES/BREP import for the browser) with Emscripten, so the CAD
// kernel may use 4 GB of memory instead of the 2 GB of the npm release.
//
//   node scripts/build-occt-wasm.mjs [--clean] [--jobs=N]
//
// Downloads the pinned, checksum-verified sources of occt-import-js and of the OpenCascade commit it was released
// with into target/occt-wasm/ (gitignored), compiles them with occt-import-js's own CMakeLists.txt and writes into
// src/wasm/occt/:
//   occt-import-js.js         Emscripten glue (ES module, no eval), with the heap watch described at patchGlue()
//   occt-import-js.wasm       the module itself
//   THIRD_PARTY_LICENSES.txt  license texts of everything compiled into occt-import-js.wasm
// The types (occt-import-js.d.ts) live next to them and are not touched.
//
// Needs the same tools as build-libarchive-wasm.mjs: Emscripten (emsdk) at $EMSDK or ~/emsdk, CMake and Ninja.
// OpenCascade has ~10,000 source files; the first run takes about an hour, later runs reuse target/occt-wasm/build/.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { EMSCRIPTEN_VERSION, findEmscripten, findPipTool, readTarGz, run } from './build-libarchive-wasm.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORK = path.resolve(process.env.OCCT_WASM_WORK ?? path.join(ROOT, 'target', 'occt-wasm'));
const DOWNLOADS = path.join(WORK, 'downloads');
const OUT = path.join(ROOT, 'src', 'wasm', 'occt');

/** The release on npm and the OpenCascade commit its `occt` submodule points to (7.6.1, from the GitHub mirror). */
const SOURCES = {
  'occt-import-js': {
    version: '0.0.23',
    url: 'https://github.com/kovacsv/occt-import-js/archive/refs/tags/0.0.23.tar.gz',
    file: 'occt-import-js-0.0.23.tar.gz',
    sha256: '89d1b75def80be77cec271da46cefced9614add5448d3408c705f2f440083dde',
    homepage: 'https://github.com/kovacsv/occt-import-js',
    license: 'LGPL-2.1',
    licenseFiles: ['LICENSE.md'],
    keep: (p) => p === 'CMakeLists.txt' || p === 'LICENSE.md' || p.startsWith('occt-import-js/src/'),
  },
  occt: {
    version: '7.6.1 (d2abb6d844231cb8f29be6894440874a4700e4a5)',
    url: 'https://github.com/Open-Cascade-SAS/OCCT/archive/d2abb6d844231cb8f29be6894440874a4700e4a5.tar.gz',
    file: 'occt-d2abb6d8.tar.gz',
    sha256: '2715d89a1bc44dfd34dab88f729c445ea93f6b57d6539b0c89614a80ae144a6c',
    homepage: 'https://dev.opencascade.org/',
    license: 'LGPL-2.1 with the Open CASCADE exception',
    licenseFiles: ['LICENSE_LGPL_21.txt', 'OCCT_LGPL_EXCEPTION.txt'],
    keep: (p) => !p.includes('/') || p.startsWith('src/'),
  },
};

// Added to occt-import-js's own link options. 4GB is the most a 32-bit WebAssembly memory can address; Emscripten's
// glue then reads pointers as unsigned. DYNAMIC_EXECUTION=0 keeps embind from building functions with `new Function`,
// which the CSP forbids.
const LINK_FLAGS = ['-sMAXIMUM_MEMORY=4GB', '-sDYNAMIC_EXECUTION=0', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,worker'];

function toSlash(p) {
  return p.replace(/\\/g, '/');
}

function log(msg) {
  console.log(`[occt-wasm] ${msg}`);
}

async function download(src) {
  const file = path.join(DOWNLOADS, src.file);
  const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === src.sha256) return file;
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  log(`downloading ${src.url}`);
  const res = await fetch(src.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${src.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== src.sha256) throw new Error(`${src.url}: SHA-256 mismatch (expected ${src.sha256}, got ${sha256(buf)})`);
  fs.writeFileSync(file, buf);
  return file;
}

/** Extracts the files a source needs into `dir` unless that already happened. */
async function extract(name, dir) {
  const src = SOURCES[name];
  const stamp = path.join(dir, `.extracted-${name}`);
  if (fs.existsSync(stamp)) return;
  const file = await download(src);
  log(`extracting ${src.file}`);
  for (const entry of readTarGz(file)) {
    if (entry.type !== '0' && entry.type !== '7') continue;
    if (!src.keep(entry.path)) continue;
    const target = path.join(dir, ...entry.path.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }
  fs.writeFileSync(stamp, `${src.url}\n${src.sha256}\n`);
}

/** Replaces each pattern exactly once; fails when an update moved the code a patch relies on. */
function patch(text, file, replacements) {
  for (const [pattern, replacement] of replacements) {
    if (text.split(pattern).length !== 2) throw new Error(`${file}: "${pattern}" not found exactly once`);
    text = text.replace(pattern, () => replacement);
  }
  return text;
}

/** Patches a source file in place, leaving out what an earlier run already changed. */
function patchFile(file, replacements) {
  const text = fs.readFileSync(file, 'utf8');
  const pending = replacements.filter(([, to]) => !text.includes(to));
  if (pending.length > 0) fs.writeFileSync(file, patch(text, path.basename(file), pending));
}

/**
 * OpenCascade catches a failed allocation itself and only reports that reading failed. The glue notes why the heap
 * could not grow, so the worker can say so: "limit" when 4 GB are not enough, "refused" when the browser did not
 * give more memory (other tabs, a low-memory device).
 */
function patchGlue(glue) {
  return patch(glue, 'occt-import-js.js', [
    ['if(requestedSize>maxHeapSize){return false}', 'if(requestedSize>maxHeapSize){Module["heapFull"]="limit";return false}'],
    ['if(replacement){return true}}return false}', 'if(replacement){return true}}Module["heapFull"]="refused";return false}'],
  ]);
}

async function main() {
  const args = process.argv.slice(2);
  const jobs = Number(args.find((a) => a.startsWith('--jobs='))?.slice(7)) || Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
  if (args.includes('--clean')) {
    fs.rmSync(path.join(WORK, 'build'), { recursive: true, force: true });
    fs.rmSync(path.join(WORK, 'src'), { recursive: true, force: true });
  }

  const em = findEmscripten();
  const cmake = findPipTool('cmake');
  const ninja = findPipTool('ninja');
  log(`Emscripten ${em.version} (pinned ${EMSCRIPTEN_VERSION}), ${jobs} jobs`);

  // occt-import-js's CMakeLists.txt expects OpenCascade in its `occt` folder.
  const src = path.join(WORK, 'src', `occt-import-js-${SOURCES['occt-import-js'].version}`);
  await extract('occt-import-js', src);
  await extract('occt', path.join(src, 'occt'));
  // --no-heap-copy is an option of the file packager, which is not used. Embind needs C++17, the rest stays C++11.
  const cpp17 = 'set_source_files_properties (occt-import-js/src/js-interface.cpp PROPERTIES COMPILE_OPTIONS -std=c++17)\n';
  patchFile(path.join(src, 'CMakeLists.txt'), [
    ['-sALLOW_MEMORY_GROWTH=1 --no-heap-copy', '-sALLOW_MEMORY_GROWTH=1'],
    ['PUBLIC --bind)', 'PUBLIC -lembind)'],
    ['source_group ("OCCT" FILES ${OcctSourceFiles})\n', `source_group ("OCCT" FILES \${OcctSourceFiles})\n${cpp17}`],
  ]);
  // Emscripten no longer defines EMSCRIPTEN, only __EMSCRIPTEN__; without it the JS interface compiles to nothing.
  patchFile(path.join(src, 'occt-import-js', 'src', 'js-interface.cpp'), [['#ifdef EMSCRIPTEN\n', '#ifdef __EMSCRIPTEN__\n']]);

  const build = path.join(WORK, 'build');
  // Source paths in assertion messages are shown relative to the work folder, never with the user directory.
  const cxx = `-DNDEBUG -ffile-prefix-map=${toSlash(src)}=/occt-import-js`;
  log('configuring');
  run(cmake, [
    '-S', src, '-B', build, '-G', 'Ninja',
    `-DCMAKE_MAKE_PROGRAM=${toSlash(ninja)}`,
    `-DCMAKE_TOOLCHAIN_FILE=${toSlash(em.toolchain)}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DCMAKE_C_FLAGS_RELEASE=${cxx}`,
    `-DCMAKE_CXX_FLAGS_RELEASE=${cxx}`,
    `-DCMAKE_EXE_LINKER_FLAGS=${LINK_FLAGS.join(' ')}`,
    // occt-import-js sets -Oz for compiling only; linking with it shrinks the wasm and minifies the glue.
    '-DCMAKE_EXE_LINKER_FLAGS_RELEASE=-Oz',
  ], { env: em.env });
  log(`compiling (${jobs} jobs)`);
  run(cmake, ['--build', build, '--parallel', String(jobs)], { env: em.env });

  const built = path.join(build, 'Release');
  fs.mkdirSync(OUT, { recursive: true });
  const glue = patchGlue(fs.readFileSync(path.join(built, 'occt-import-js.js'), 'utf8'));
  if (/\beval\s*\(|new\s+Function\s*\(/.test(glue)) throw new Error('occt-import-js.js contains eval/new Function, which the CSP forbids');
  const wasm = fs.readFileSync(path.join(built, 'occt-import-js.wasm'));
  if (!wasm.includes(Buffer.from('ReadFile')) || wasm.length < 4_000_000) throw new Error('occt-import-js.wasm lacks the JS interface or OpenCascade');
  if (wasm.includes(Buffer.from(toSlash(os.homedir()))) || wasm.includes(Buffer.from(os.homedir()))) {
    throw new Error('occt-import-js.wasm contains a path from this machine');
  }
  fs.writeFileSync(path.join(OUT, 'occt-import-js.js'), glue);
  fs.writeFileSync(path.join(OUT, 'occt-import-js.wasm'), wasm);
  writeLicenses(src, em);
  log(`done: occt-import-js.wasm ${wasm.length} bytes (${zlib.gzipSync(wasm, { level: 9 }).length} gzipped), occt-import-js.js ${Buffer.byteLength(glue)} bytes`);
}

function writeLicenses(src, em) {
  const rule = '='.repeat(78);
  const parts = [
    'Third-party components compiled into occt-import-js.wasm',
    rule,
    '',
    'occt-import-js.wasm and occt-import-js.js are built by scripts/build-occt-wasm.mjs from the',
    'sources listed below (SHA-256 verified). Changed are only the build: up to 4 GB of memory,',
    'no eval, an ES module, a note in the glue when the memory cannot grow, and two fixes for the',
    'newer Emscripten (__EMSCRIPTEN__ instead of EMSCRIPTEN, C++17 for the embind interface).',
    '',
  ];
  for (const [name, s] of Object.entries(SOURCES)) parts.push(`- ${name} ${s.version}: ${s.license}`, `  ${s.homepage}`, `  ${s.url}`, `  sha256 ${s.sha256}`);
  parts.push(
    `- Emscripten ${em.version} runtime (JS glue, musl libc, libc++, libc++abi, compiler-rt, dlmalloc):`,
    '  MIT OR NCSA (Emscripten), MIT (musl), Apache-2.0 WITH LLVM-exception (libc++, libc++abi,',
    '  compiler-rt), public domain / CC0-1.0 (dlmalloc). https://emscripten.org/',
    '',
  );
  const add = (title, file) => {
    parts.push(rule, title, rule, '', fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd(), '');
  };
  for (const f of SOURCES['occt-import-js'].licenseFiles) add(`occt-import-js: ${f}`, path.join(src, f));
  for (const f of SOURCES.occt.licenseFiles) add(`OpenCascade: ${f}`, path.join(src, 'occt', f));
  const lib = path.join(em.root, 'system', 'lib');
  add(`Emscripten ${em.version}: LICENSE`, path.join(em.root, 'LICENSE'));
  add('musl libc (as shipped with Emscripten): COPYRIGHT', path.join(lib, 'libc', 'musl', 'COPYRIGHT'));
  add('libc++ (as shipped with Emscripten): LICENSE.TXT', path.join(lib, 'libcxx', 'LICENSE.TXT'));
  add('libc++abi (as shipped with Emscripten): LICENSE.TXT', path.join(lib, 'libcxxabi', 'LICENSE.TXT'));
  add('compiler-rt (as shipped with Emscripten): LICENSE.TXT', path.join(lib, 'compiler-rt', 'LICENSE.TXT'));
  fs.writeFileSync(path.join(OUT, 'THIRD_PARTY_LICENSES.txt'), `${parts.join('\n')}\n`);
}

main().catch((err) => {
  console.error(`[occt-wasm] ${err.message}`);
  process.exit(1);
});
