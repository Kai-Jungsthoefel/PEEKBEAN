// SPDX-License-Identifier: GPL-3.0-or-later
// Checks the libarchive WebAssembly build in src/wasm/libarchive/ under Node, without npm dependencies.
//
//   node scripts/test-libarchive-wasm.mjs [--update-samples] [--verbose]
//
// Test archives come from two places: Python (tarfile/zipfile/bz2/lzma/gzip, found via $PYTHON or PATH) writes
// tar/zip/xz/bz2/lzma/gz files into target/libarchive-wasm/test/, and 7z/RAR/CAB/LHA/ISO/CPIO/AR/WARC and
// encrypted samples are taken from libarchive's own test suite (uuencoded files in the pinned release tarball,
// downloaded by the build script). --update-samples (re)writes example.tar.bz2, example.tar.xz,
// libarchive-test.7z and libarchive-test.rar in samples/archives/ from the same sources.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { SOURCES, WORK, download, readTarGz } from './build-libarchive-wasm.mjs';
import { LibarchiveError, createReader } from '../src/wasm/libarchive/libarchive-reader.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'src', 'wasm', 'libarchive');
const TEST_DIR = path.join(WORK, 'test');
const SAMPLES = path.join(ROOT, 'samples', 'archives');
const VERBOSE = process.argv.includes('--verbose');

// --- Helpers ---------------------------------------------------------------------------------------------------

let failures = 0;
const summary = [];

function check(condition, message) {
  if (!condition) {
    failures++;
    console.log(`  FAIL ${message}`);
  } else if (VERBOSE) {
    console.log(`  ok   ${message}`);
  }
  return condition;
}

function equalBytes(a, b) {
  return a.length === b.length && Buffer.compare(Buffer.from(a.buffer, a.byteOffset, a.length), Buffer.from(b.buffer, b.byteOffset, b.length)) === 0;
}

function report(name, status, note = '') {
  summary.push({ name, status, note });
  console.log(`${status === 'ok' ? 'ok  ' : status === 'expected' ? 'ok* ' : 'FAIL'} ${name}${note ? ` - ${note}` : ''}`);
  if (status === 'fail') failures++;
}

/** Decodes the uuencoded fixtures libarchive's test suite uses. */
function uudecode(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const begin = lines.findIndex((l) => l.startsWith('begin '));
  const out = [];
  for (const line of lines.slice(begin + 1)) {
    if (line === 'end') break;
    const n = (line.charCodeAt(0) - 32) & 63;
    if (n === 0) continue;
    const bytes = [];
    for (let i = 1; bytes.length < n && i < line.length; i += 4) {
      const c = [0, 1, 2, 3].map((k) => ((line.charCodeAt(i + k) || 32) - 32) & 63);
      bytes.push((c[0] << 2) | (c[1] >> 4), ((c[1] & 15) << 4) | (c[2] >> 2), ((c[2] & 3) << 6) | c[3]);
    }
    out.push(Buffer.from(bytes.slice(0, n)));
  }
  return Buffer.concat(out);
}

let fixtureCache = null;
/** Returns a decoded file from libarchive/test/ of the pinned libarchive release. */
async function fixture(name) {
  if (!fixtureCache) {
    const tarball = await download('libarchive');
    fixtureCache = new Map();
    for (const entry of readTarGz(tarball)) {
      if (entry.path.startsWith('libarchive/test/') && entry.path.endsWith('.uu')) {
        fixtureCache.set(entry.path.slice('libarchive/test/'.length, -3), entry.data);
      }
    }
  }
  const data = fixtureCache.get(name);
  if (!data) throw new Error(`fixture ${name} not found in libarchive ${SOURCES.libarchive.version}`);
  return uudecode(data.toString('latin1'));
}

function findPython() {
  const candidates = [process.env.PYTHON, 'python', 'python3', 'py'].filter(Boolean);
  for (const cmd of candidates) {
    const res = spawnSync(cmd, ['-I', '-c', 'import sys, bz2, lzma, tarfile, zipfile; print(sys.version_info[0])'], { encoding: 'utf8' });
    if (res.status === 0 && res.stdout.trim() === '3') return cmd;
  }
  return null;
}

// Python writes the tar/zip/xz/bz2 test archives (and the self-made samples). Deterministic: fixed times/owners.
const PYTHON_GENERATOR = String.raw`
import bz2, gzip, io, json, lzma, os, random, sys, tarfile, zipfile

out, mode = sys.argv[1], sys.argv[2]
os.makedirs(out, exist_ok=True)
MTIME = 1768478400  # 2026-01-15 12:00:00 UTC

if mode == 'samples':
    files = {
        'example/README.txt': (
            'Sample archive for Everything Viewer\n'
            '====================================\n\n'
            'This archive is self-made and in the public domain (CC0-1.0).\n'
            'It contains three small text files in two folders.\n'
            'Accented letters to check the character encoding: café naïve Zürich €\n'
        ).encode('utf-8'),
        'example/notes/shipyard.md': (
            '# Notes\n\n'
            '- Hull: steel, superstructure: aluminium\n'
            '- Length overall: 42.5 m\n'
            '- Next date: sea trial\n'
        ).encode('utf-8'),
        'example/data/readings.csv': (
            'time,temperature_c,pressure_bar\n'
            + ''.join('2026-01-15T12:%02d:00,%.1f,%.2f\n' % (i, 18 + i * 0.25, 1.01 + i * 0.01) for i in range(12))
        ).encode('utf-8'),
    }
else:
    rng = random.Random(42)
    files = {
        'hello.txt': b'Hello world!\n',
        'data/numbers.txt': ''.join('%d\n' % i for i in range(1, 2001)).encode(),
        'café/naïve.txt': 'Accents: café naïve\n'.encode('utf-8'),
        'empty.txt': b'',
        'big.bin': rng.randbytes(150000) + bytes(150000),
    }

def tar_bytes(fmt):
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w', format=fmt, encoding='utf-8') as tar:
        dirs = sorted({os.path.dirname(n) for n in files if os.path.dirname(n)})
        for d in dirs:
            info = tarfile.TarInfo(d)
            info.type, info.mode, info.mtime = tarfile.DIRTYPE, 0o755, MTIME
            tar.addfile(info)
        for name, data in files.items():
            info = tarfile.TarInfo(name)
            info.size, info.mode, info.mtime = len(data), 0o644, MTIME
            tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()

def write(name, data):
    with open(os.path.join(out, name), 'wb') as f:
        f.write(data)

pax = tar_bytes(tarfile.PAX_FORMAT)
if mode == 'samples':
    write('example.tar.bz2', bz2.compress(pax, 9))
    write('example.tar.xz', lzma.compress(pax, format=lzma.FORMAT_XZ, check=lzma.CHECK_CRC64, preset=9))
    sys.exit(0)

write('test.tar', tar_bytes(tarfile.GNU_FORMAT))
write('test.tar.gz', gzip.compress(pax, 9, mtime=MTIME))
write('test.tar.bz2', bz2.compress(pax, 9))
write('test.tar.xz', lzma.compress(pax, format=lzma.FORMAT_XZ))
single = files['data/numbers.txt']
write('single.txt.xz', lzma.compress(single, format=lzma.FORMAT_XZ))
write('single.txt.bz2', bz2.compress(single))
write('single.txt.lzma', lzma.compress(single, format=lzma.FORMAT_ALONE))
write('single.txt.gz', gzip.compress(single, mtime=MTIME))

methods = [zipfile.ZIP_DEFLATED, zipfile.ZIP_STORED, zipfile.ZIP_BZIP2, zipfile.ZIP_LZMA, zipfile.ZIP_DEFLATED]
zbuf = io.BytesIO()
with zipfile.ZipFile(zbuf, 'w') as z:
    for (name, data), method in zip(files.items(), methods):
        info = zipfile.ZipInfo(name, (2026, 1, 15, 12, 0, 0))
        info.compress_type = method
        z.writestr(info, data)
write('test.zip', zbuf.getvalue())

# A ZIP name in code page 437 without the UTF-8 flag, as old Windows tools wrote them: 'Café.txt'.
zbuf = io.BytesIO()
with zipfile.ZipFile(zbuf, 'w') as z:
    z.writestr(zipfile.ZipInfo('Caf@.txt', (2026, 1, 15, 12, 0, 0)), b'legacy name\n')
write('legacy-names.zip', zbuf.getvalue().replace(b'Caf@.txt', 'Café.txt'.encode('cp437')))

json.dump({name: data.hex() for name, data in files.items()}, open(os.path.join(out, 'files.json'), 'w'))
`;

function runPython(python, outDir, mode) {
  const script = path.join(WORK, 'make-test-archives.py');
  fs.mkdirSync(WORK, { recursive: true });
  fs.writeFileSync(script, PYTHON_GENERATOR);
  const res = spawnSync(python, ['-I', script, outDir, mode], { stdio: 'inherit' });
  if (res.status !== 0) throw new Error(`Python generator failed (${mode})`);
}

// --- Test cases ------------------------------------------------------------------------------------------------

const CAB_FILE1 = '                          file 1 contents\nhello\nhello\nhello\n';
const CAB_FILE2 = `                          file 2 contents\n${'hello\n'.repeat(6)}`;

/** libarchive's RAR5 test data: little-endian int32 values k*k-3k+1+magic. */
function rar5Data(magic, size) {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size / 4; i++) {
    const k = i + 1;
    out.writeUInt32LE(Math.max(0, k * k - 3 * k + 1 + magic) >>> 0, i * 4);
  }
  return out;
}

/**
 * Lists and extracts everything; `expect` maps paths to expected content (string, Buffer or predicate).
 * Returns the archive's entries.
 */
function verifyArchive(reader, name, data, { expect = {}, count, passphrase, format, filters, skipEncrypted = false, note = '' } = {}) {
  let archive;
  try {
    archive = reader.open(data, passphrase);
  } catch (err) {
    report(name, 'fail', `open: ${err.message}`);
    return null;
  }
  try {
    const failuresBefore = failures;
    const paths = archive.entries.map((e) => e.path);
    if (VERBOSE) console.log(`  ${name}: ${archive.format} [${archive.filters.join(',')}] ${JSON.stringify(paths)}`);
    if (count !== undefined) check(archive.entries.length === count, `${name}: ${count} entries (got ${archive.entries.length}: ${paths.join(', ')})`);
    if (format) check(format.test(archive.format), `${name}: format ${archive.format} matches ${format}`);
    if (filters) check(archive.filters.join(',') === filters.join(','), `${name}: filters ${archive.filters} = ${filters}`);
    check(archive.warning === null, `${name}: no warning (${archive.warning})`);
    for (const p of Object.keys(expect)) check(paths.includes(p), `${name}: contains ${p}`);
    let bytes = 0;
    let skipped = 0;
    for (const entry of archive.entries) {
      if (skipEncrypted && entry.encrypted) {
        skipped++;
        continue;
      }
      const content = archive.extract(entry.index);
      bytes += content.length;
      if (entry.size !== null) check(content.length === entry.size, `${name}: ${entry.path} size ${content.length} = ${entry.size}`);
      const want = expect[entry.path];
      if (typeof want === 'function') check(want(content), `${name}: ${entry.path} content`);
      else if (want !== undefined) check(equalBytes(content, typeof want === 'string' ? Buffer.from(want) : want), `${name}: ${entry.path} content`);
    }
    // Random access: last entry first, then the first one again (reopens the reader).
    if (archive.entries.length > 1 && !skipped) {
      const last = archive.entries.at(-1);
      const first = archive.entries[0];
      check(archive.extract(last.index).length === (last.size ?? archive.extract(last.index).length), `${name}: extract last entry again`);
      check(archive.extract(first.index).length === (first.size ?? archive.extract(first.index).length), `${name}: extract first entry after last`);
    }
    const ok = failures === failuresBefore;
    if (ok) {
      summary.push({ name, status: 'ok', note: `${archive.format}${archive.filters.length ? ` + ${archive.filters.join('+')}` : ''}, ${archive.entries.length} files, ${bytes} bytes${skipped ? `, ${skipped} encrypted skipped` : ''}${note ? `; ${note}` : ''}` });
      console.log(`ok   ${name} - ${summary.at(-1).note}`);
    } else {
      summary.push({ name, status: 'fail', note: 'see FAIL lines above' });
      console.log(`FAIL ${name}`);
    }
    return archive.entries;
  } catch (err) {
    report(name, 'fail', `${err.code ?? ''} ${err.message}`);
    return null;
  } finally {
    archive.close();
  }
}

/** Expects open() or extract() of every entry to throw a LibarchiveError with one of `codes`. */
function verifyFailure(reader, name, data, { codes, passphrase, stage = 'any', note = '' }) {
  let archive;
  try {
    archive = reader.open(data, passphrase);
  } catch (err) {
    const good = err instanceof LibarchiveError && codes.includes(err.code) && stage !== 'extract';
    report(name, good ? 'expected' : 'fail', `open throws ${err.code}: ${err.message}${note ? `; ${note}` : ''}`);
    return;
  }
  try {
    const encrypted = archive.entries.filter((e) => e.encrypted).length;
    const errors = [];
    for (const entry of archive.entries) {
      try {
        archive.extract(entry.index);
      } catch (err) {
        if (!(err instanceof LibarchiveError) || !codes.includes(err.code)) {
          report(name, 'fail', `unexpected ${err.code}: ${err.message}`);
          return;
        }
        errors.push(`${err.code}: ${err.message}`);
      }
    }
    const good = stage !== 'open' && errors.length > 0;
    const unique = [...new Set(errors)].join(' | ');
    report(name, good ? 'expected' : 'fail',
      `${archive.format}: lists ${archive.entries.length} files (${encrypted} marked encrypted)${archive.warning ? `, warning "${archive.warning}"` : ''}; extract throws ${unique || 'nothing'}${note ? `; ${note}` : ''}`);
  } finally {
    archive.close();
  }
}

/** Damaged input: open() may throw, list partially (with a warning) or fail on extract, but must not crash. */
function verifyDamaged(reader, name, data) {
  try {
    const archive = reader.open(data);
    const errors = [];
    let extracted = 0;
    for (const e of archive.entries) {
      try {
        archive.extract(e.index);
        extracted++;
      } catch (err) {
        if (!(err instanceof LibarchiveError) || err.code === 'CRASHED') throw err;
        errors.push(err.message);
      }
    }
    archive.close();
    report(name, archive.warning || errors.length ? 'expected' : 'fail',
      `lists ${archive.entries.length} files${archive.warning ? ` with warning "${archive.warning}"` : ''}, ${extracted} extracted, ${errors.length} extract errors${errors.length ? ` (${[...new Set(errors)].join(' | ')})` : ''}`);
  } catch (err) {
    report(name, err instanceof LibarchiveError && err.code !== 'CRASHED' ? 'expected' : 'fail', `open throws ${err.code}: ${err.message}`);
  }
}

function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Corrupts archives at random and makes sure nothing worse than a LibarchiveError happens. */
async function fuzz(makeReader, name, data, rounds, seed) {
  const random = mulberry32(seed);
  let reader = await makeReader();
  let crashes = 0;
  let opened = 0;
  let extracted = 0;
  for (let round = 0; round < rounds; round++) {
    const bytes = Uint8Array.from(data);
    const flips = 1 + Math.floor(random() * 8);
    for (let i = 0; i < flips; i++) bytes[Math.floor(random() * bytes.length)] = Math.floor(random() * 256);
    const cut = random() < 0.2 ? bytes.subarray(0, Math.floor(random() * bytes.length)) : bytes;
    try {
      const archive = reader.open(cut);
      opened++;
      for (const entry of archive.entries) {
        try {
          archive.extract(entry.index);
          extracted++;
        } catch (err) {
          if (!(err instanceof LibarchiveError)) throw err;
          if (err.code === 'CRASHED') throw err;
        }
      }
      archive.close();
    } catch (err) {
      if (!(err instanceof LibarchiveError) || err.code === 'CRASHED') {
        crashes++;
        console.log(`  crash in ${name} round ${round}: ${err.message}`);
        reader = await makeReader();
      }
    }
  }
  report(`fuzz ${name}`, crashes ? 'fail' : 'ok', `${rounds} corrupted copies: ${opened} opened, ${extracted} entries extracted, ${crashes} crashes`);
}

/**
 * Opens every file of libarchive's test suite (valid, damaged and hostile ones) with a fresh reader and
 * extracts all entries. Errors are fine; traps, aborts or non-LibarchiveError exceptions are not.
 */
async function sweepFixtures(compiled) {
  await fixture('test_read_format_rar.rar');
  let opened = 0;
  let refused = 0;
  let extracted = 0;
  let extractErrors = 0;
  const crashes = [];
  for (const name of [...fixtureCache.keys()].sort()) {
    const reader = await createReader({ wasmModule: compiled });
    const data = await fixture(name);
    try {
      const archive = reader.open(data);
      opened++;
      for (const entry of archive.entries) {
        if (entry.size !== null && entry.size > 512 * 1024 * 1024) continue;
        try {
          archive.extract(entry.index);
          extracted++;
        } catch (err) {
          if (!(err instanceof LibarchiveError) || err.code === 'CRASHED') throw err;
          extractErrors++;
        }
      }
      archive.close();
    } catch (err) {
      if (!(err instanceof LibarchiveError) || err.code === 'CRASHED') crashes.push(`${name}: ${err.message}`);
      else refused++;
    }
  }
  for (const c of crashes) console.log(`  crash: ${c}`);
  report(`all ${fixtureCache.size} libarchive test files`, crashes.length ? 'fail' : 'ok',
    `${opened} opened (${extracted} entries extracted, ${extractErrors} extract errors), ${refused} refused, ${crashes.length} crashes`);
}

// --- Main ------------------------------------------------------------------------------------------------------

async function updateSamples(python) {
  fs.mkdirSync(SAMPLES, { recursive: true });
  if (!python) throw new Error('--update-samples needs Python 3 (set $PYTHON)');
  runPython(python, SAMPLES, 'samples');
  fs.writeFileSync(path.join(SAMPLES, 'libarchive-test.7z'), await fixture('test_read_format_7zip_lzma1_2.7z'));
  fs.writeFileSync(path.join(SAMPLES, 'libarchive-test.rar'), await fixture('test_read_format_rar5_unicode.rar'));
  for (const f of ['example.tar.bz2', 'example.tar.xz', 'libarchive-test.7z', 'libarchive-test.rar']) {
    console.log(`wrote samples/archives/${f} (${fs.statSync(path.join(SAMPLES, f)).size} bytes)`);
  }
}

async function main() {
  const wasmFile = path.join(OUT, 'libarchive.wasm');
  const glue = fs.readFileSync(path.join(OUT, 'libarchive.js'), 'utf8');
  const wasmBinary = fs.readFileSync(wasmFile);
  const python = findPython();

  if (process.argv.includes('--update-samples')) await updateSamples(python);

  console.log(`libarchive.wasm: ${wasmBinary.length} bytes, ${zlib.gzipSync(wasmBinary, { level: 9 }).length} gzipped; libarchive.js: ${glue.length} bytes`);
  report('glue has no eval/new Function (CSP without unsafe-eval)', /\beval\s*\(|new\s+Function\s*\(/.test(glue) ? 'fail' : 'ok');
  report('glue loads the .wasm as a separate file', glue.includes("'libarchive.wasm'") || glue.includes('"libarchive.wasm"') ? 'ok' : 'fail');

  const compiled = await WebAssembly.compile(wasmBinary);
  const makeReader = () => createReader({ wasmModule: compiled });
  const reader = await createReader({ wasmBinary });
  report('createReader({ wasmBinary }) and createReader({ wasmModule })', (await makeReader()) ? 'ok' : 'fail');

  // Archives made by Python.
  if (python) {
    const gen = path.join(TEST_DIR, 'generated');
    fs.rmSync(gen, { recursive: true, force: true });
    runPython(python, gen, 'test');
    const files = Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(path.join(gen, 'files.json'), 'utf8'))).map(([k, v]) => [k, Buffer.from(v, 'hex')]));
    const read = (f) => fs.readFileSync(path.join(gen, f));
    const all = { expect: files, count: Object.keys(files).length };
    verifyArchive(reader, 'tar (GNU, Python)', read('test.tar'), { ...all, format: /tar/i, filters: [] });
    verifyArchive(reader, 'tar.gz (Python)', read('test.tar.gz'), { ...all, format: /tar|pax/i, filters: ['gzip'] });
    verifyArchive(reader, 'tar.bz2 (pax, Python)', read('test.tar.bz2'), { ...all, format: /tar|pax/i, filters: ['bzip2'] });
    verifyArchive(reader, 'tar.xz (Python)', read('test.tar.xz'), { ...all, format: /tar|pax/i, filters: ['xz'] });
    if (zlib.zstdCompressSync) {
      verifyArchive(reader, 'tar.zst (Node zstd)', zlib.zstdCompressSync(read('test.tar')), { ...all, filters: ['zstd'] });
    }
    const single = { expect: { data: files['data/numbers.txt'] }, count: 1, format: /^raw$/ };
    verifyArchive(reader, '.xz single file', read('single.txt.xz'), { ...single, filters: ['xz'] });
    verifyArchive(reader, '.bz2 single file', read('single.txt.bz2'), { ...single, filters: ['bzip2'] });
    verifyArchive(reader, '.lzma single file', read('single.txt.lzma'), { ...single, filters: ['lzma'] });
    verifyArchive(reader, '.gz single file', read('single.txt.gz'), { ...single, filters: ['gzip'] });
    verifyArchive(reader, 'zip (deflate/stored/bzip2/lzma, Python)', read('test.zip'), { ...all, format: /zip/i });
    verifyArchive(reader, 'zip with CP437 name, no UTF-8 flag', read('legacy-names.zip'), { expect: { 'Café.txt': 'legacy name\n' }, count: 1 });
    const legacy = reader.list(read('legacy-names.zip'))[0];
    report('guessed legacy name keeps rawPath', legacy.rawPath && equalBytes(legacy.rawPath, Buffer.from('Caf\x82.txt', 'latin1')) ? 'ok' : 'fail');

    // Convenience API, Blob input, damaged data.
    const tarXz = read('test.tar.xz');
    const listed = reader.list(tarXz);
    const hello = listed.find((e) => e.path === 'hello.txt');
    report('list() + extract(data, index)', hello && equalBytes(reader.extract(tarXz, hello.index), files['hello.txt']) && hello.mtime === 1768478400 ? 'ok' : 'fail',
      `hello.txt mtime ${hello?.mtime}`);
    const fromBlob = await reader.openBlob(new Blob([tarXz]));
    report('openBlob(Blob)', fromBlob.entries.length === listed.length && equalBytes(fromBlob.extract(hello.index), files['hello.txt']) ? 'ok' : 'fail');
    fromBlob.close();
    try {
      fromBlob.extract(hello.index);
      report('extract after close() throws', 'fail');
    } catch (err) {
      report('extract after close() throws', err instanceof LibarchiveError ? 'ok' : 'fail', err.message);
    }
    try {
      reader.extract(tarXz, 9999);
      report('unknown index throws', 'fail');
    } catch (err) {
      report('unknown index throws', err instanceof LibarchiveError ? 'ok' : 'fail', err.message);
    }
    verifyDamaged(reader, 'truncated tar.xz', tarXz.subarray(0, Math.floor(tarXz.length * 0.6)));
    await fuzz(makeReader, 'tar.xz', tarXz, 150, 1);
    await fuzz(makeReader, 'zip', read('test.zip'), 150, 2);
  } else {
    report('Python test archives', 'fail', 'Python 3 not found (set $PYTHON); tar/zip/xz/bz2 tests skipped');
  }

  // libarchive's own test files.
  const fx = (name) => fixture(name);
  const rar4Basic = { 'test.txt': 'test text document\r\n', 'testdir/test.txt': 'test text document\r\n' };
  verifyArchive(reader, 'RAR v4 (test_read_format_rar.rar)', await fx('test_read_format_rar.rar'), { expect: rar4Basic, format: /^RAR$/ });
  verifyArchive(reader, 'RAR v4 Unicode names', await fx('test_read_format_rar_unicode.rar'), { format: /^RAR$/ });
  verifyArchive(reader, 'RAR v4 compressed (normal)', await fx('test_read_format_rar_compress_normal.rar'), { format: /^RAR$/ });
  const ppmdTail = Buffer.from('gin-bottom: 0in"><BR>\n</P>\n</BODY>\n</HTML>');
  verifyArchive(reader, 'RAR v4 PPMd/LZSS (241 MB entry)', await fx('test_read_format_rar_ppmd_lzss_conversion.rar'), {
    format: /^RAR$/, count: 1,
    expect: { 'ppmd_lzss_conversion_test.txt': (c) => c.length === 241647978 && equalBytes(c.subarray(c.length - ppmdTail.length), ppmdTail) },
  });
  verifyArchive(reader, 'RAR v4 filters (E8/delta/...)', await fx('test_read_format_rar_filter.rar'), { format: /^RAR$/ });
  const rar5Files = Object.fromEntries([1, 2, 3, 4].map((n) => [`test${n}.bin`, rar5Data(n, 4096)]));
  verifyArchive(reader, 'RAR v5 multiple files', await fx('test_read_format_rar5_multiple_files.rar'), { expect: rar5Files, count: 4, format: /^RAR5$/ });
  verifyArchive(reader, 'RAR v5 solid', await fx('test_read_format_rar5_multiple_files_solid.rar'), { expect: rar5Files, count: 4, format: /^RAR5$/ });
  verifyArchive(reader, 'RAR v5 stored', await fx('test_read_format_rar5_stored.rar'), { format: /^RAR5$/ });
  verifyArchive(reader, 'RAR v5 Unicode names', await fx('test_read_format_rar5_unicode.rar'), { format: /^RAR5$/ });
  verifyArchive(reader, 'RAR v5 win32 (sample)', await fx('test_read_format_rar5_win32.rar'), { format: /^RAR5$/ });
  verifyArchive(reader, 'RAR v5 ARM filter', await fx('test_read_format_rar5_arm.rar'), { format: /^RAR5$/ });

  const sevenZip = (fixtureName, extra = {}) => fx(fixtureName).then((data) => verifyArchive(reader, `7z ${fixtureName.replace(/^test_read_format_7zip_|\.7z$/g, '')}`, data, { format: /^7-Zip$/, ...extra }));
  const libarchiveText = (c) => Buffer.from(c).subarray(0, 28).toString() === 'The libarchive distribution ';
  await sevenZip('test_read_format_7zip_lzma1.7z', { expect: { file1: libarchiveText } });
  await sevenZip('test_read_format_7zip_lzma2.7z', { expect: { file1: libarchiveText } });
  await sevenZip('test_read_format_7zip_bzip2.7z');
  await sevenZip('test_read_format_7zip_deflate.7z');
  await sevenZip('test_read_format_7zip_ppmd.7z');
  await sevenZip('test_read_format_7zip_zstd.7z');
  await sevenZip('test_read_format_7zip_copy.7z');
  await sevenZip('test_read_format_7zip_bcj2_lzma2_1.7z');
  await sevenZip('test_read_format_7zip_delta_lzma2.7z');
  await sevenZip('test_read_format_7zip_lzma2_arm.7z');
  await sevenZip('test_read_format_7zip_solid_zstd.7z');

  const cabExpect = { 'dir1/file1': CAB_FILE1, 'dir2/file2': CAB_FILE2 };
  verifyArchive(reader, 'CAB stored', await fx('test_read_format_cab_1.cab'), { expect: cabExpect, format: /CAB/i });
  verifyArchive(reader, 'CAB MSZIP', await fx('test_read_format_cab_2.cab'), { expect: cabExpect, format: /CAB/i });
  verifyArchive(reader, 'CAB LZX', await fx('test_read_format_cab_3.cab'), { expect: cabExpect, format: /CAB/i });
  const lhaExpect = { file1: CAB_FILE1, file2: CAB_FILE2 };
  verifyArchive(reader, 'LHA lh5 (header level 0)', await fx('test_read_format_lha_header0.lzh'), { expect: lhaExpect, format: /lha/i });
  verifyArchive(reader, 'LHA lh5 (header level 2)', await fx('test_read_format_lha_header2.lzh'), { expect: lhaExpect, format: /lha/i });
  verifyArchive(reader, 'LHA lh6', await fx('test_read_format_lha_lh6.lzh'), { expect: lhaExpect, format: /lha/i });
  verifyArchive(reader, 'LHA lh7', await fx('test_read_format_lha_lh7.lzh'), { expect: lhaExpect, format: /lha/i });
  verifyArchive(reader, 'ISO 9660 (.iso.Z, compress filter)', await fx('test_read_format_iso.iso.Z'), { format: /ISO9660/i, filters: ['compress (.Z)'] });
  verifyArchive(reader, 'ISO 9660 Joliet', await fx('test_read_format_iso_joliet.iso.Z'), { format: /ISO9660/i });
  verifyArchive(reader, 'ISO 9660 Rock Ridge', await fx('test_read_format_iso_rockridge.iso.Z'), { format: /ISO9660/i });
  verifyArchive(reader, 'CPIO binary big-endian', await fx('test_read_format_cpio_bin_be.cpio'), { format: /cpio/i });
  verifyArchive(reader, 'AR', await fx('test_read_format_ar.ar'), { expect: { 'yyytttsssaaafff.o': (c) => c.length === 8, 'gghh.o': (c) => c.length === 4 }, format: /ar/i });
  verifyArchive(reader, 'WARC', await fx('test_read_format_warc.warc'), { expect: { 'sometest.txt': (c) => c.length === 65, 'moretest.txt': (c) => c.length === 76 }, format: /WARC/i });
  verifyArchive(reader, 'tar.zst (libarchive)', await fx('test_compat_zstd_1.tar.zst'), { filters: ['zstd'] });
  verifyArchive(reader, 'tar.lz4', await fx('test_compat_lz4_1.tar.lz4'), { filters: ['lz4'] });
  verifyArchive(reader, 'tar.lz4 (block dependency)', await fx('test_compat_lz4_B5BD.tar.lz4'), { filters: ['lz4'] });
  verifyArchive(reader, 'tar.lz (lzip)', await fx('test_compat_lzip_1.tlz'), { filters: ['lzip'] });
  verifyArchive(reader, 'tar.lzma', await fx('test_compat_lzma_1.tlz'), { filters: ['lzma'] });
  verifyArchive(reader, 'tar.xz (libarchive)', await fx('test_compat_xz_1.txz'), { filters: ['xz'] });
  verifyArchive(reader, 'tar.bz2 (libarchive)', await fx('test_compat_bzip2_1.tbz'), { filters: ['bzip2'] });
  verifyArchive(reader, 'RPM (cpio + bzip2)', await fx('test_read_format_cpio_svr4_bzip2_rpm.rpm'), { format: /cpio/i });
  verifyArchive(reader, 'ZIP UTF-8 names (Japanese)', await fx('test_read_format_zip_filename_utf8_jp.zip'), { format: /zip/i });

  // Encryption: only traditional ZIP encryption can be decrypted.
  const zipCrypto = await fx('test_read_format_zip_traditional_encryption_data.zip');
  verifyFailure(reader, 'ZIP traditional encryption, no passphrase', zipCrypto, { codes: ['PASSPHRASE'], stage: 'extract' });
  verifyFailure(reader, 'ZIP traditional encryption, wrong passphrase', zipCrypto, { codes: ['PASSPHRASE'], passphrase: 'wrong', stage: 'extract' });
  verifyArchive(reader, 'ZIP traditional encryption, passphrase "12345678"', zipCrypto, { passphrase: '12345678', count: 2, expect: { 'bar.txt': (c) => c.length === 495, 'foo.txt': (c) => c.length === 495 } });
  {
    const archive = reader.open(zipCrypto);
    const entry = archive.entries[0];
    let ok = false;
    try { archive.extract(entry.index); } catch (err) { ok = err.code === 'PASSPHRASE'; }
    ok = ok && archive.extract(entry.index, '12345678').length === 495 && entry.encrypted;
    archive.close();
    report('ZIP traditional encryption, passphrase given to extract() after a failure', ok ? 'ok' : 'fail');
  }
  verifyFailure(reader, 'ZIP AES-256 (WinZip AE-2)', await fx('test_read_format_zip_winzip_aes256.zip'), { codes: ['UNSUPPORTED_ENCRYPTION'], passphrase: 'password', stage: 'extract' });
  verifyFailure(reader, '7z AES (encrypted data)', await fx('test_read_format_7zip_encryption.7z'), { codes: ['UNSUPPORTED_ENCRYPTION'], passphrase: 'password', stage: 'extract' });
  verifyFailure(reader, '7z AES (encrypted header)', await fx('test_read_format_7zip_encryption_header.7z'), { codes: ['UNSUPPORTED_ENCRYPTION', 'ERROR'], passphrase: 'password', stage: 'open' });
  verifyFailure(reader, 'RAR v4 encrypted data', await fx('test_read_format_rar_encryption_data.rar'), { codes: ['UNSUPPORTED_ENCRYPTION'], passphrase: 'password', stage: 'extract' });
  verifyFailure(reader, 'RAR v4 encrypted header', await fx('test_read_format_rar_encryption_header.rar'), { codes: ['UNSUPPORTED_ENCRYPTION', 'ERROR'], stage: 'open' });
  verifyFailure(reader, 'RAR v5 encrypted (solid)', await fx('test_read_format_rar5_solid_encrypted.rar'), { codes: ['UNSUPPORTED_ENCRYPTION'], passphrase: 'password', stage: 'extract' });
  verifyFailure(reader, 'XAR (no XML parser compiled in)', await fx('test_read_format_xar_doublelink.xar'), { codes: ['UNRECOGNIZED', 'ERROR'], stage: 'open' });

  // Garbage must throw, not crash.
  const garbage = new Uint8Array(65536);
  const rnd = mulberry32(7);
  for (let i = 0; i < garbage.length; i++) garbage[i] = Math.floor(rnd() * 256);
  verifyFailure(reader, 'empty buffer', new Uint8Array(0), { codes: ['UNRECOGNIZED'], stage: 'open' });
  verifyFailure(reader, 'random bytes', garbage, { codes: ['UNRECOGNIZED'], stage: 'open' });
  verifyFailure(reader, 'plain text', new TextEncoder().encode('This is not an archive.\n'.repeat(100)), { codes: ['UNRECOGNIZED'], stage: 'open' });
  verifyFailure(reader, 'malformed 7z', await fx('test_read_format_7zip_malformed.7z'), { codes: ['ERROR', 'UNRECOGNIZED'], stage: 'open' });
  verifyFailure(reader, 'malformed 7z (2)', await fx('test_read_format_7zip_malformed2.7z'), { codes: ['ERROR', 'UNRECOGNIZED'], stage: 'open' });
  verifyDamaged(reader, 'truncated RAR v5', (await fx('test_read_format_rar5_win32.rar')).subarray(0, 2000));
  verifyDamaged(reader, 'truncated 7z', (await fx('test_read_format_7zip_lzma1_2.7z')).subarray(0, 150));
  try {
    reader.list('not bytes');
    report('non-binary input throws TypeError', 'fail');
  } catch (err) {
    report('non-binary input throws TypeError', err instanceof TypeError ? 'ok' : 'fail');
  }
  await fuzz(makeReader, '7z', await fx('test_read_format_7zip_lzma2_arm.7z'), 300, 3);
  await fuzz(makeReader, 'RAR v5', await fx('test_read_format_rar5_win32.rar'), 300, 4);
  await fuzz(makeReader, 'RAR v4', await fx('test_read_format_rar_compress_normal.rar'), 200, 5);
  await fuzz(makeReader, 'CAB LZX', await fx('test_read_format_cab_3.cab'), 200, 6);

  await sweepFixtures(compiled);

  // The reader still works after all the errors above.
  verifyArchive(reader, 'reader still usable after errors', await fx('test_read_format_rar.rar'), { expect: rar4Basic });

  // Samples in the repository.
  if (fs.existsSync(SAMPLES)) {
    for (const f of fs.readdirSync(SAMPLES).sort()) {
      verifyArchive(reader, `samples/archives/${f}`, fs.readFileSync(path.join(SAMPLES, f)), { skipEncrypted: true });
    }
  }

  console.log(`\n${summary.filter((s) => s.status !== 'fail').length} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
