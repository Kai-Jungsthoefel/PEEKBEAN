// SPDX-License-Identifier: GPL-3.0-or-later
// Builds a read-only WebAssembly version of libarchive (BSD-2-Clause) with Emscripten.
//
//   node scripts/build-libarchive-wasm.mjs [--clean] [--jobs=N]
//
// Downloads pinned, checksum-verified source releases of libarchive, zlib, bzip2, xz (liblzma), zstd and lz4
// into target/libarchive-wasm/ (gitignored), compiles them and writes into src/wasm/libarchive/:
//   libarchive.js            Emscripten glue (ES module, no eval, no filesystem)
//   libarchive.wasm          the module itself
//   THIRD_PARTY_LICENSES.txt license texts of everything compiled into libarchive.wasm
// The hand-written API (libarchive-reader.js/.d.ts) lives next to them and is not touched.
//
// Needs: Emscripten (emsdk) at $EMSDK or ~/emsdk, CMake and Ninja on PATH, in $CMAKE/$NINJA,
// or installed with `python -m pip install --user cmake ninja`. No crypto library, XML parser or iconv
// is compiled in, so the result contains only permissively licensed code (see THIRD_PARTY_LICENSES.txt).
// The first run takes 20-30 minutes on Windows, almost all of it CMake's configure checks (each one starts emcc);
// later runs reuse the CMake caches in target/libarchive-wasm/build/ (--clean throws them away).

import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const WORK = path.resolve(process.env.LIBARCHIVE_WASM_WORK ?? path.join(ROOT, 'target', 'libarchive-wasm'));
export const DOWNLOADS = path.join(WORK, 'downloads');
const OUT = path.join(ROOT, 'src', 'wasm', 'libarchive');
const WRAPPER = path.join(ROOT, 'wasm', 'libarchive', 'wrapper.c');

export const EMSCRIPTEN_VERSION = '6.0.12';

/**
 * Pinned source releases. Every tarball was checked against the project's signature or published checksum
 * when it was pinned (libarchive: Martin Matuska, zlib: Mark Adler, bzip2: Mark Wielaard, xz: Lasse Collin,
 * zstd: Zstandard release key, lz4: the .sha256 next to the release asset); the build verifies the SHA-256.
 */
export const SOURCES = {
  libarchive: {
    version: '3.8.10',
    url: 'https://github.com/libarchive/libarchive/releases/download/v3.8.10/libarchive-3.8.10.tar.gz',
    sha256: 'a1bffbe5152cfe869751179e7b16648c87c461cb8c46eee75062efbe164cc57c',
    homepage: 'https://www.libarchive.org/',
    license: 'BSD-2-Clause (some files BSD-3-Clause, public domain, or CC0-1.0 OR Apache-2.0 OR OpenSSL; see COPYING)',
    licenseFiles: ['COPYING'],
    // The release tarball contains ~1000 test files the build does not need (their CMakeLists.txt it does).
    skip: (p) => /^(libarchive|tar|cpio|cat|unzip)\/test\//.test(p) && !p.endsWith('/CMakeLists.txt'),
  },
  zlib: {
    version: '1.3.2',
    url: 'https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz',
    sha256: 'bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16',
    homepage: 'https://zlib.net/',
    license: 'Zlib',
    licenseFiles: ['LICENSE'],
  },
  bzip2: {
    version: '1.0.8',
    url: 'https://sourceware.org/pub/bzip2/bzip2-1.0.8.tar.gz',
    sha256: 'ab5a03176ee106d3f0fa90e381da478ddae405918153cca248e682cd0c4a2269',
    homepage: 'https://sourceware.org/bzip2/',
    license: 'bzip2-1.0.6 (BSD-style)',
    licenseFiles: ['LICENSE'],
  },
  xz: {
    version: '5.8.4',
    url: 'https://github.com/tukaani-project/xz/releases/download/v5.8.4/xz-5.8.4.tar.gz',
    sha256: '0014c7886930454fe8bd4228665b51af55eeae560ea135c9c4cd33f55b2591d9',
    homepage: 'https://tukaani.org/xz/',
    license: '0BSD (liblzma; only liblzma is compiled)',
    licenseFiles: ['COPYING', 'COPYING.0BSD'],
  },
  zstd: {
    version: '1.5.7',
    url: 'https://github.com/facebook/zstd/releases/download/v1.5.7/zstd-1.5.7.tar.gz',
    sha256: 'eb33e51f49a15e023950cd7825ca74a4a2b43db8354825ac24fc1b7ee09e6fa3',
    homepage: 'https://facebook.github.io/zstd/',
    license: 'BSD-3-Clause (dual-licensed BSD-3-Clause OR GPL-2.0-only; used under BSD-3-Clause)',
    licenseFiles: ['LICENSE'],
    skip: (p) => /^(tests|contrib|programs|doc|examples|zlibWrapper)\//.test(p),
  },
  lz4: {
    version: '1.10.0',
    url: 'https://github.com/lz4/lz4/releases/download/v1.10.0/lz4-1.10.0.tar.gz',
    sha256: '537512904744b35e232912055ccf8ec66d768639ff3abe5788d90d792ec5f48b',
    homepage: 'https://lz4.org/',
    license: 'BSD-2-Clause (lib/ only)',
    licenseFiles: ['lib/LICENSE'],
    skip: (p) => /^(tests|contrib|programs|doc|examples|ossfuzz)\//.test(p),
  },
};

// Optimization for the whole build. -O3 because decompression speed matters more than ~100 KB of code.
const OPT = ['-O3'];
const CFLAGS = [...OPT, '-DNDEBUG', `-ffile-prefix-map=${toSlash(WORK)}=/build`];

// Exactly what the JS side (src/wasm/libarchive/libarchive-reader.js) calls.
const EXPORTED_FUNCTIONS = [
  '_malloc', '_free',
  '_ar_open', '_ar_close', '_ar_error', '_ar_warning', '_ar_format', '_ar_filters', '_ar_count',
  '_ar_entry_header', '_ar_entry_flags', '_ar_entry_size', '_ar_entry_mtime', '_ar_entry_path', '_ar_entry_hardlink',
  '_ar_add_passphrase', '_ar_extract', '_ar_extracted_size',
];

// ---------------------------------------------------------------------------------------------------------------

function toSlash(p) {
  return p.replace(/\\/g, '/');
}

function log(msg) {
  console.log(`[libarchive-wasm] ${msg}`);
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Downloads a pinned source tarball (once) and verifies its SHA-256. Returns the local path. */
export async function download(name) {
  const src = SOURCES[name];
  const file = path.join(DOWNLOADS, path.basename(new URL(src.url).pathname));
  if (fs.existsSync(file) && sha256(fs.readFileSync(file)) === src.sha256) return file;
  fs.mkdirSync(DOWNLOADS, { recursive: true });
  log(`downloading ${src.url}`);
  const res = await fetch(src.url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${src.url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const actual = sha256(buf);
  if (actual !== src.sha256) throw new Error(`${src.url}: SHA-256 mismatch (expected ${src.sha256}, got ${actual})`);
  fs.writeFileSync(file, buf);
  return file;
}

/**
 * Minimal reader for .tar.gz (ustar, pax and GNU long names). Yields { path, type, data } with the first path
 * component removed. Symbolic links are reported with type '2' and the target in `link`.
 */
export function* readTarGz(file) {
  const tar = zlib.gunzipSync(fs.readFileSync(file));
  const text = (buf) => {
    const end = buf.indexOf(0);
    return buf.subarray(0, end < 0 ? buf.length : end).toString('utf8');
  };
  const num = (buf) => {
    if (buf[0] & 0x80) {
      let v = 0;
      for (let i = 1; i < buf.length; i++) v = v * 256 + buf[i];
      return v;
    }
    return parseInt(text(buf).trim() || '0', 8);
  };
  let offset = 0;
  let longName = null;
  let longLink = null;
  let pax = {};
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = num(header.subarray(124, 136));
    const type = String.fromCharCode(header[156] || 0x30);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      pax = {};
      const body = data.toString('utf8');
      let i = 0;
      while (i < body.length) {
        const space = body.indexOf(' ', i);
        const len = parseInt(body.slice(i, space), 10);
        if (!len) break;
        const record = body.slice(space + 1, i + len - 1);
        const eq = record.indexOf('=');
        pax[record.slice(0, eq)] = record.slice(eq + 1);
        i += len;
      }
      continue;
    }
    if (type === 'g') continue;
    if (type === 'L') { longName = text(data); continue; }
    if (type === 'K') { longLink = text(data); continue; }
    const magic = header.subarray(257, 262).toString('latin1');
    const prefix = magic === 'ustar' ? text(header.subarray(345, 500)) : '';
    const name = text(header.subarray(0, 100));
    const full = pax.path ?? longName ?? (prefix ? `${prefix}/${name}` : name);
    const link = pax.linkpath ?? longLink ?? text(header.subarray(157, 257));
    pax = {};
    longName = longLink = null;
    const parts = full.split('/').filter((p) => p && p !== '.');
    if (parts.some((p) => p === '..')) throw new Error(`${file}: unsafe path ${full}`);
    if (parts.length < 2) continue;
    yield { path: parts.slice(1).join('/'), type, data, link };
  }
}

/** Extracts a source tarball into WORK/src/<name>-<version> unless that already happened. */
async function extract(name) {
  const src = SOURCES[name];
  const dir = path.join(WORK, 'src', `${name}-${src.version}`);
  const stamp = path.join(dir, '.extracted');
  if (fs.existsSync(stamp)) return dir;
  const file = await download(name);
  log(`extracting ${path.basename(file)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  const links = [];
  for (const entry of readTarGz(file)) {
    if (src.skip?.(entry.path)) continue;
    const target = path.join(dir, ...entry.path.split('/'));
    if (entry.type === '5') {
      fs.mkdirSync(target, { recursive: true });
    } else if (entry.type === '0' || entry.type === '7') {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, entry.data);
    } else if (entry.type === '1' || entry.type === '2') {
      links.push({ target, entry });
    }
  }
  // Links are copied, not linked: they only matter for files that are never compiled here.
  for (const { target, entry } of links) {
    const from = entry.type === '1'
      ? path.join(dir, ...entry.link.split('/').slice(1))
      : path.resolve(path.dirname(target), entry.link);
    if (fs.existsSync(from) && fs.statSync(from).isFile()) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(from, target);
    }
  }
  fs.writeFileSync(stamp, `${src.url}\n${src.sha256}\n`);
  return dir;
}

// --- Tools -----------------------------------------------------------------------------------------------------

function which(cmd) {
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of exts) {
      const candidate = path.join(dir, cmd + ext);
      if (dir && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

/** Finds a tool on PATH, in $<ENV>, or where `pip install --user` puts console scripts. */
function findPipTool(name) {
  const fromEnv = process.env[name.toUpperCase()];
  if (fromEnv) return fromEnv;
  const onPath = which(name);
  if (onPath) return onPath;
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  const candidates = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    const base = path.join(process.env.APPDATA, 'Python');
    if (fs.existsSync(base)) {
      for (const v of fs.readdirSync(base)) candidates.push(path.join(base, v, 'Scripts', exe));
    }
  } else {
    candidates.push(path.join(os.homedir(), '.local', 'bin', exe));
  }
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error(`${name} not found. Install it with: python -m pip install --user cmake ninja`);
  return found;
}

function findEmscripten() {
  const emsdk = path.resolve(process.env.EMSDK ?? path.join(os.homedir(), 'emsdk'));
  const config = path.join(emsdk, '.emscripten');
  const root = path.join(emsdk, 'upstream', 'emscripten');
  if (!fs.existsSync(config) || !fs.existsSync(root)) {
    throw new Error(`emsdk not found at ${emsdk}. Install it with:\n`
      + `  git clone https://github.com/emscripten-core/emsdk.git ${emsdk}\n`
      + `  cd ${emsdk} && git checkout ${EMSCRIPTEN_VERSION} && ./emsdk install ${EMSCRIPTEN_VERSION} && ./emsdk activate ${EMSCRIPTEN_VERSION}`);
  }
  const ext = process.platform === 'win32' ? '.exe' : '';
  const settings = fs.readFileSync(config, 'utf8');
  const setting = (key) => {
    const m = settings.match(new RegExp(`^${key}\\s*=\\s*'([^']*)'`, 'm'));
    return m ? path.resolve(m[1].replace('$CFGDIR', emsdk)) : null;
  };
  const node = setting('NODE_JS') ?? process.execPath;
  const python = setting('PYTHON');
  const env = { ...process.env, EMSDK: emsdk, EM_CONFIG: config, EMSDK_NODE: node };
  if (python) env.EMSDK_PYTHON = python;
  env.PATH = [emsdk, root, path.dirname(node), ...(python ? [path.dirname(python)] : []), process.env.PATH].join(path.delimiter);
  const tool = (name) => path.join(root, name + ext);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'emscripten-version.txt'), 'utf8'));
  if (version !== EMSCRIPTEN_VERSION && !process.env.LIBARCHIVE_WASM_ANY_EMSCRIPTEN) {
    throw new Error(`Emscripten ${version} is active, the build is pinned to ${EMSCRIPTEN_VERSION} `
      + '(run `emsdk install/activate` for it, or set LIBARCHIVE_WASM_ANY_EMSCRIPTEN=1 to build anyway).');
  }
  return {
    version, root, env, node, emsdk,
    emcc: tool('emcc'), emar: tool('emar'),
    toolchain: path.join(root, 'cmake', 'Modules', 'Platform', 'Emscripten.cmake'),
  };
}

function run(cmd, args, options = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', ...options });
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(`${path.basename(cmd)} ${args.slice(0, 3).join(' ')} ... failed with exit code ${res.status}`);
}

function runAsync(cmd, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'inherit', 'inherit'], ...options });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(cmd)} ${args.at(-1)} failed (${code})`))));
  });
}

async function pool(tasks, jobs) {
  let next = 0;
  const worker = async () => {
    while (next < tasks.length) await tasks[next++]();
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, worker));
}

// --- Builds ----------------------------------------------------------------------------------------------------

/** Compiles a list of C files with emcc and archives them; used for libraries whose build system adds nothing. */
async function buildStaticLib({ em, name, srcDir, files, includes = [], defines = [], prefix, jobs }) {
  const objDir = path.join(WORK, 'build', name);
  fs.mkdirSync(objDir, { recursive: true });
  const objects = [];
  const tasks = files.map((rel) => {
    const obj = path.join(objDir, rel.replace(/[\\/]/g, '_').replace(/\.c$/, '.o'));
    objects.push(obj);
    return () => runAsync(em.emcc, [
      ...CFLAGS, ...defines.map((d) => `-D${d}`), ...includes.map((i) => `-I${path.join(srcDir, i)}`),
      '-c', path.join(srcDir, rel), '-o', obj,
    ], { env: em.env });
  });
  log(`compiling ${name} (${files.length} files)`);
  await pool(tasks, jobs);
  const lib = path.join(prefix, 'lib', `lib${name}.a`);
  fs.mkdirSync(path.dirname(lib), { recursive: true });
  fs.rmSync(lib, { force: true });
  run(em.emar, ['rcs', lib, ...objects], { env: em.env });
  return lib;
}

function copyHeaders(srcDir, files, prefix) {
  const inc = path.join(prefix, 'include');
  fs.mkdirSync(inc, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(srcDir, f), path.join(inc, path.basename(f)));
}

function cmakeArgs(em, ninja, buildType = 'Release') {
  return [
    '-G', 'Ninja',
    `-DCMAKE_MAKE_PROGRAM=${toSlash(ninja)}`,
    `-DCMAKE_TOOLCHAIN_FILE=${toSlash(em.toolchain)}`,
    `-DCMAKE_CROSSCOMPILING_EMULATOR=${toSlash(em.node)}`,
    `-DCMAKE_BUILD_TYPE=${buildType}`,
    `-DCMAKE_C_FLAGS_RELEASE=${CFLAGS.join(' ')}`,
    '-DBUILD_SHARED_LIBS=OFF',
    '-DBUILD_TESTING=OFF',
  ];
}

async function main() {
  const args = process.argv.slice(2);
  const jobs = Number(args.find((a) => a.startsWith('--jobs='))?.slice(7)) || Math.max(1, os.availableParallelism?.() ?? os.cpus().length);
  if (args.includes('--clean')) {
    fs.rmSync(path.join(WORK, 'build'), { recursive: true, force: true });
    fs.rmSync(path.join(WORK, 'prefix'), { recursive: true, force: true });
    fs.rmSync(path.join(WORK, 'src'), { recursive: true, force: true });
  }

  const em = findEmscripten();
  const cmake = findPipTool('cmake');
  const ninja = findPipTool('ninja');
  log(`Emscripten ${em.version} (${em.emsdk}), CMake ${spawnSync(cmake, ['--version']).stdout.toString().split('\n')[0].replace('cmake version ', '')}, Ninja ${spawnSync(ninja, ['--version']).stdout.toString().trim()}`);

  const dirs = {};
  for (const name of Object.keys(SOURCES)) dirs[name] = await extract(name);
  const prefix = path.join(WORK, 'prefix');
  fs.mkdirSync(path.join(prefix, 'include'), { recursive: true });

  // zlib: only the inflate/deflate core; libarchive does not use the gz* file API.
  const libz = await buildStaticLib({
    em, jobs, prefix, name: 'z', srcDir: dirs.zlib,
    files: ['adler32.c', 'compress.c', 'crc32.c', 'deflate.c', 'infback.c', 'inffast.c', 'inflate.c', 'inftrees.c', 'trees.c', 'uncompr.c', 'zutil.c'],
    defines: ['HAVE_UNISTD_H', 'HAVE_STDARG_H'],
  });
  copyHeaders(dirs.zlib, ['zlib.h', 'zconf.h'], prefix);

  const libbz2 = await buildStaticLib({
    em, jobs, prefix, name: 'bz2', srcDir: dirs.bzip2,
    files: ['blocksort.c', 'huffman.c', 'crctable.c', 'randtable.c', 'compress.c', 'decompress.c', 'bzlib.c'],
    defines: ['_FILE_OFFSET_BITS=64'],
  });
  copyHeaders(dirs.bzip2, ['bzlib.h'], prefix);

  const liblz4 = await buildStaticLib({
    em, jobs, prefix, name: 'lz4', srcDir: dirs.lz4,
    files: ['lib/lz4.c', 'lib/lz4hc.c'],
  });
  copyHeaders(dirs.lz4, ['lib/lz4.h', 'lib/lz4hc.h'], prefix);

  const zstdFiles = ['common', 'compress', 'decompress'].flatMap((sub) =>
    fs.readdirSync(path.join(dirs.zstd, 'lib', sub)).filter((f) => f.endsWith('.c')).map((f) => `lib/${sub}/${f}`));
  const libzstd = await buildStaticLib({
    em, jobs, prefix, name: 'zstd', srcDir: dirs.zstd, files: zstdFiles,
    includes: ['lib', 'lib/common'],
    defines: ['ZSTD_DISABLE_ASM', 'ZSTD_LEGACY_SUPPORT=0', 'ZSTD_TRACE=0', 'XXH_NAMESPACE=ZSTD_'],
  });
  copyHeaders(dirs.zstd, ['lib/zstd.h', 'lib/zstd_errors.h', 'lib/zdict.h'], prefix);

  // liblzma through its own CMake build, which knows which of its ~150 files and config macros belong together.
  const xzBuild = path.join(WORK, 'build', 'xz');
  const liblzma = path.join(prefix, 'lib', 'liblzma.a');
  log('building liblzma');
  run(cmake, [
    '-S', dirs.xz, '-B', xzBuild, ...cmakeArgs(em, ninja),
    `-DCMAKE_INSTALL_PREFIX=${toSlash(prefix)}`,
    '-DXZ_NLS=OFF', '-DXZ_THREADS=no', '-DXZ_SANDBOX=no', '-DXZ_DOC=OFF', '-DXZ_SMALL=OFF',
    '-DXZ_TOOL_XZ=OFF', '-DXZ_TOOL_XZDEC=OFF', '-DXZ_TOOL_LZMADEC=OFF', '-DXZ_TOOL_LZMAINFO=OFF', '-DXZ_TOOL_SCRIPTS=OFF',
    '-DXZ_CLMUL_CRC=OFF', '-DXZ_ARM64_CRC32=OFF', '-DXZ_LOONGARCH_CRC32=OFF',
    '-DXZ_MICROLZMA_ENCODER=OFF', '-DXZ_MICROLZMA_DECODER=OFF',
  ], { env: em.env });
  run(cmake, ['--build', xzBuild, '--parallel', String(jobs)], { env: em.env });
  run(cmake, ['--install', xzBuild], { env: em.env });

  // libarchive: library only, no programs, tests, crypto, XML, ACL/xattr or iconv.
  const laBuild = path.join(WORK, 'build', 'libarchive');
  const inc = toSlash(path.join(prefix, 'include'));
  log('building libarchive');
  run(cmake, [
    '-S', dirs.libarchive, '-B', laBuild, ...cmakeArgs(em, ninja),
    '-DENABLE_OPENSSL=OFF', '-DENABLE_MBEDTLS=OFF', '-DENABLE_NETTLE=OFF', '-DENABLE_CNG=OFF', '-DENABLE_MD=OFF',
    '-DENABLE_LIBB2=OFF', '-DENABLE_LIBXML2=OFF', '-DENABLE_EXPAT=OFF', '-DENABLE_BSDXML=OFF', '-DENABLE_WIN32_XMLLITE=OFF',
    '-DENABLE_PCREPOSIX=OFF', '-DENABLE_PCRE2POSIX=OFF', '-DENABLE_LIBGCC=OFF', '-DENABLE_LZO=OFF',
    '-DENABLE_ACL=OFF', '-DENABLE_XATTR=OFF', '-DENABLE_ICONV=OFF',
    '-DENABLE_TAR=OFF', '-DENABLE_CPIO=OFF', '-DENABLE_CAT=OFF', '-DENABLE_UNZIP=OFF',
    '-DENABLE_TEST=OFF', '-DENABLE_INSTALL=OFF', '-DENABLE_WERROR=OFF',
    '-DENABLE_ZLIB=ON', `-DZLIB_INCLUDE_DIR=${inc}`, `-DZLIB_LIBRARY=${toSlash(libz)}`, `-DZLIB_LIBRARY_RELEASE=${toSlash(libz)}`,
    '-DENABLE_BZip2=ON', `-DBZIP2_INCLUDE_DIR=${inc}`, `-DBZIP2_LIBRARY_RELEASE=${toSlash(libbz2)}`, `-DBZIP2_LIBRARIES=${toSlash(libbz2)}`,
    '-DENABLE_LZMA=ON', `-DLIBLZMA_INCLUDE_DIR=${inc}`, `-DLIBLZMA_LIBRARY=${toSlash(liblzma)}`, `-DLIBLZMA_LIBRARY_RELEASE=${toSlash(liblzma)}`,
    '-DENABLE_ZSTD=ON', `-DZSTD_INCLUDE_DIR=${inc}`, `-DZSTD_LIBRARY=${toSlash(libzstd)}`,
    '-DENABLE_LZ4=ON', `-DLZ4_INCLUDE_DIR=${inc}`, `-DLZ4_LIBRARY=${toSlash(liblz4)}`,
  ], { env: em.env });
  run(cmake, ['--build', laBuild, '--target', 'archive_static', '--parallel', String(jobs)], { env: em.env });
  const libarchive = path.join(laBuild, 'libarchive', 'libarchive.a');
  checkConfig(path.join(laBuild, 'config.h'));

  // Link the wrapper into an ES module + separate .wasm.
  log('linking');
  fs.mkdirSync(OUT, { recursive: true });
  run(em.emcc, [
    ...CFLAGS,
    `-I${path.join(dirs.libarchive, 'libarchive')}`,
    WRAPPER, libarchive, liblzma, libzstd, liblz4, libbz2, libz,
    '-o', path.join(OUT, 'libarchive.js'),
    '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createLibarchiveModule',
    '-sENVIRONMENT=web,worker',
    '-sALLOW_MEMORY_GROWTH=1', '-sMAXIMUM_MEMORY=4GB', '-sSTACK_SIZE=1MB',
    '-sDYNAMIC_EXECUTION=0', '-sFILESYSTEM=0',
    '-sTEXTDECODER=2',
    '-sINCOMING_MODULE_JS_API=locateFile,wasmBinary,instantiateWasm,print,printErr,onAbort',
    `-sEXPORTED_FUNCTIONS=${EXPORTED_FUNCTIONS.join(',')}`,
    '-sEXPORTED_RUNTIME_METHODS=HEAPU8,UTF8ToString',
  ], { env: em.env });

  writeLicenses(dirs, em);
  const wasm = fs.readFileSync(path.join(OUT, 'libarchive.wasm'));
  const glue = fs.readFileSync(path.join(OUT, 'libarchive.js'), 'utf8');
  if (/\beval\s*\(|new\s+Function\s*\(/.test(glue)) throw new Error('libarchive.js contains eval/new Function, which the CSP forbids');
  log(`done: libarchive.wasm ${wasm.length} bytes (${zlib.gzipSync(wasm, { level: 9 }).length} gzipped), libarchive.js ${Buffer.byteLength(glue)} bytes`);
}

/** Fails if the configuration pulled in something we must not ship, or lost a decompressor we want. */
function checkConfig(configH) {
  const config = fs.readFileSync(configH, 'utf8');
  const defined = (macro) => new RegExp(`^#define ${macro}\\b`, 'm').test(config);
  const forbidden = ['HAVE_LIBCRYPTO', 'HAVE_LIBMBEDCRYPTO', 'HAVE_LIBNETTLE', 'HAVE_LIBXML2', 'HAVE_LIBEXPAT', 'HAVE_BSDXML_H', 'HAVE_ICONV', 'HAVE_LIBB2', 'HAVE_LIBACL', 'HAVE_LIBMD']
    .filter(defined);
  if (forbidden.length) throw new Error(`libarchive config enables ${forbidden.join(', ')}`);
  const required = ['HAVE_ZLIB_H', 'HAVE_BZLIB_H', 'HAVE_LZMA_H', 'HAVE_ZSTD_H', 'HAVE_LZ4_H'].filter((m) => !defined(m));
  if (required.length) throw new Error(`libarchive config is missing ${required.join(', ')}`);
}

function writeLicenses(dirs, em) {
  const rule = '='.repeat(78);
  const parts = [
    'Third-party components compiled into libarchive.wasm',
    rule,
    '',
    'libarchive.wasm and libarchive.js are built by scripts/build-libarchive-wasm.mjs from the',
    'source releases listed below (SHA-256 verified) and the wrapper wasm/libarchive/wrapper.c',
    '(GPL-3.0-or-later, part of Everything Viewer). No cryptography library, XML parser or iconv',
    'is compiled in. Every component below is compatible with GPL-3.0-or-later.',
    '',
  ];
  for (const [name, src] of Object.entries(SOURCES)) {
    parts.push(`- ${name} ${src.version}: ${src.license}`, `  ${src.homepage}`, `  ${src.url}`, `  sha256 ${src.sha256}`);
  }
  parts.push(
    `- Emscripten ${em.version} runtime (JS glue, musl libc, compiler-rt, dlmalloc):`,
    '  MIT OR NCSA (Emscripten), MIT (musl), Apache-2.0 WITH LLVM-exception (compiler-rt),',
    '  public domain / CC0-1.0 (dlmalloc). https://emscripten.org/',
    '',
  );
  // Paths are shown relative to the emsdk or work folder, never with the local user directory in them.
  const emsdkRoot = path.resolve(process.env.EMSDK ?? path.join(os.homedir(), 'emsdk'));
  const shown = (file) => {
    const inEmsdk = path.relative(emsdkRoot, file);
    if (!inEmsdk.startsWith('..') && !path.isAbsolute(inEmsdk)) return `emsdk/${toSlash(inEmsdk)}`;
    return toSlash(path.relative(WORK, file)).replace(/^(\.\.\/)+/, '');
  };
  const add = (title, file) => {
    parts.push(rule, title, `(${shown(file)})`, rule, '', fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trimEnd(), '');
  };
  for (const [name, src] of Object.entries(SOURCES)) {
    for (const f of src.licenseFiles) add(`${name} ${src.version}: ${f}`, path.join(dirs[name], f));
  }
  add(`Emscripten ${em.version}: LICENSE`, path.join(em.root, 'LICENSE'));
  add('musl libc (as shipped with Emscripten): COPYRIGHT', path.join(em.root, 'system', 'lib', 'libc', 'musl', 'COPYRIGHT'));
  add('compiler-rt (as shipped with Emscripten): LICENSE.TXT', path.join(em.root, 'system', 'lib', 'compiler-rt', 'LICENSE.TXT'));
  fs.writeFileSync(path.join(OUT, 'THIRD_PARTY_LICENSES.txt'), `${parts.join('\n')}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[libarchive-wasm] ${err.message}`);
    process.exit(1);
  });
}
