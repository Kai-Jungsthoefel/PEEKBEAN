// SPDX-License-Identifier: GPL-3.0-or-later
// Builds the DWG -> DXF converter (crates/dwg2dxf: Rust + acadrust) to WebAssembly and writes it to src/wasm/dwg2dxf/:
// dwg2dxf.js, dwg2dxf_bg.wasm, their .d.ts files and THIRD_PARTY_LICENSES.txt.
// The output is committed, so building the web app does not need Rust. Run this only after changing the crate or its
// dependencies, then run scripts/test-dwg-wasm.mjs.
//
// Needs: Rust via rustup with the wasm32-unknown-unknown target, and wasm-bindgen-cli in exactly the version of the
// wasm-bindgen crate in crates/dwg2dxf/Cargo.lock. Both are looked up on PATH and in ~/.cargo/bin.
// wasm-opt is not used on purpose: -Oz makes the file 8 % smaller but its gzip size larger.
// Usage: node scripts/build-dwg-wasm.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..');
const CRATE = path.join(ROOT, 'crates', 'dwg2dxf');
const OUT = path.join(ROOT, 'src', 'wasm', 'dwg2dxf');
const TARGET = 'wasm32-unknown-unknown';
const EXE = process.platform === 'win32' ? '.exe' : '';

function fail(message) {
  console.error(`\nbuild-dwg-wasm: ${message}`);
  process.exit(1);
}

function run(tool, args, options = {}) {
  const result = spawnSync(tool, args, { cwd: CRATE, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...options });
  if (result.error) fail(`could not run ${tool}: ${result.error.message}`);
  if (result.status !== 0) {
    if (options.stdio !== 'inherit') process.stderr.write(result.stderr ?? '');
    fail(`${path.basename(tool)} ${args[0]} failed (exit code ${result.status}).`);
  }
  return result.stdout ?? '';
}

// Finds a tool on PATH or in cargo's bin directory; returns its command and version, or null.
function findTool(name) {
  const cargoBin = path.join(process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'), 'bin', name + EXE);
  for (const candidate of [name, cargoBin]) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return { command: candidate, version: probe.stdout.trim() };
  }
  return null;
}

// ---- Tools ---------------------------------------------------------------------------------------------------

const lock = readFileSync(path.join(CRATE, 'Cargo.lock'), 'utf8');
const bindgenVersion = /\[\[package\]\]\r?\nname = "wasm-bindgen"\r?\nversion = "([^"]+)"/.exec(lock)?.[1];
if (!bindgenVersion) fail('could not find the wasm-bindgen version in crates/dwg2dxf/Cargo.lock.');

const cargo = findTool('cargo');
const rustc = findTool('rustc');
if (!cargo || !rustc) {
  fail(
    'Rust is not installed (cargo/rustc not found on PATH or in ~/.cargo/bin).\n' +
      '  Install rustup from https://rustup.rs (on Windows without Visual Studio: rustup-init.exe -y --default-host x86_64-pc-windows-gnu --profile minimal),\n' +
      `  then: rustup target add ${TARGET}`,
  );
}
const sysroot = run(rustc.command, ['--print', 'sysroot']).trim();
if (!existsSync(path.join(sysroot, 'lib', 'rustlib', TARGET))) {
  fail(`the Rust target ${TARGET} is not installed. Run: rustup target add ${TARGET}`);
}

const bindgen = findTool('wasm-bindgen');
const bindgenHint =
  `  Install it: download wasm-bindgen-${bindgenVersion}-<platform>.tar.gz from\n` +
  `  https://github.com/wasm-bindgen/wasm-bindgen/releases/tag/${bindgenVersion} and put wasm-bindgen${EXE} into ~/.cargo/bin,\n` +
  `  or run: cargo install wasm-bindgen-cli --version ${bindgenVersion} --locked`;
if (!bindgen) fail(`wasm-bindgen is not installed (not found on PATH or in ~/.cargo/bin).\n${bindgenHint}`);
if (bindgen.version !== `wasm-bindgen ${bindgenVersion}`) {
  fail(`found ${bindgen.version}, but Cargo.lock uses wasm-bindgen ${bindgenVersion}; the versions must match.\n${bindgenHint}`);
}
console.log(`Using ${cargo.version}, ${rustc.version}, ${bindgen.version}`);

// ---- Third-party licenses (checked before building, written at the end) --------------------------------------

// Licenses that may be combined with GPL-3.0-or-later. Anything else stops the build for a manual review.
const COMPATIBLE = [
  'MIT', 'Zlib', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'CC0-1.0', 'Apache-2.0', 'Unicode-3.0',
  'Unicode-DFS-2016', 'MPL-2.0', 'LGPL-2.1-only', 'LGPL-2.1-or-later', 'LGPL-3.0-only', 'LGPL-3.0-or-later',
  'GPL-3.0-only', 'GPL-3.0-or-later',
];

// Parses an SPDX expression and picks, for every OR, the most permissive compatible alternative.
// Returns { ok, used } where `used` is the license expression the crate is used under.
function chooseLicense(expression) {
  const tokens = expression.replaceAll('/', ' OR ').match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const rank = (id) => (COMPATIBLE.includes(id) ? COMPATIBLE.indexOf(id) : Infinity);
  function atom() {
    const token = tokens[i++];
    if (token === '(') {
      const inner = or();
      if (tokens[i++] !== ')') throw new Error(`unbalanced parentheses in "${expression}"`);
      return inner;
    }
    if (!token || ['AND', 'OR', 'WITH', ')'].includes(token)) throw new Error(`cannot parse "${expression}"`);
    let used = token;
    if (tokens[i] === 'WITH') {
      used = `${token} WITH ${tokens[i + 1]}`; // an exception only adds permissions
      i += 2;
    }
    return { ok: COMPATIBLE.includes(token), used, rank: rank(token) };
  }
  function and() {
    const parts = [atom()];
    while (tokens[i] === 'AND') { i++; parts.push(atom()); }
    if (parts.length === 1) return parts[0];
    return { ok: parts.every((p) => p.ok), used: parts.map((p) => p.used).join(' AND '), rank: Math.max(...parts.map((p) => p.rank)) };
  }
  function or() {
    const parts = [and()];
    while (tokens[i] === 'OR') { i++; parts.push(and()); }
    if (parts.length === 1) return parts[0];
    const best = parts.filter((p) => p.ok).sort((a, b) => a.rank - b.rank)[0];
    return best ?? { ok: false, used: expression, rank: Infinity };
  }
  const result = or();
  if (i !== tokens.length) throw new Error(`cannot parse "${expression}"`);
  return { ok: result.ok, used: result.used };
}

const LICENSE_FILE = /^(licen[cs]e|copying|copyright|notice|unlicense|third[-_]party)/i;
const normalize = (text) => text.replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();

const metadata = JSON.parse(
  run(cargo.command, ['metadata', '--format-version', '1', '--locked', '--filter-platform', TARGET]),
);
// The crates compiled into the wasm: normal dependencies for the wasm target with the features actually enabled,
// without proc-macros (they only run at build time). `cargo tree` knows the enabled features; `cargo metadata`
// does not (it lists e.g. zlib-rs, which flate2 only names in a weak feature), so it only supplies paths and licenses.
const tree = run(cargo.command, [
  'tree', '--locked', '--target', TARGET, '--edges', 'normal,no-proc-macro', '--prefix', 'none', '--format', '{p}',
]);
const linked = new Set(
  tree.split('\n').map((line) => /^(\S+) v(\S+)/.exec(line.trim())).filter(Boolean).map((m) => `${m[1]}@${m[2]}`),
);
const root = metadata.packages.find((p) => p.id === metadata.resolve.root);
linked.delete(`${root.name}@${root.version}`);
const crates = metadata.packages
  .filter((p) => linked.has(`${p.name}@${p.version}`))
  .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
if (crates.length !== linked.size) fail('cargo tree and cargo metadata disagree about the dependency list.');

const problems = [];
const rows = [];
const sections = [];
const seenTexts = new Map();
for (const p of crates) {
  let choice = { ok: false, used: '?' };
  if (p.license) {
    try { choice = chooseLicense(p.license); } catch (error) { problems.push(`${p.name} ${p.version}: ${error.message}`); }
  }
  if (!choice.ok) problems.push(`${p.name} ${p.version}: license "${p.license ?? `custom file ${p.license_file}`}" is not on the GPL-3.0-compatible list`);
  rows.push([p.name, p.version, p.license ?? 'see file', choice.used]);

  const dir = path.dirname(p.manifest_path);
  const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f) && statSync(path.join(dir, f)).isFile()).sort();
  if (p.license_file && !files.includes(path.basename(p.license_file))) files.push(p.license_file);
  if (!files.length) problems.push(`${p.name} ${p.version}: no license file found in ${dir}`);
  const lines = ['='.repeat(100), `${p.name} ${p.version}`, `License: ${p.license ?? 'see file'}`];
  if (p.repository) lines.push(`Source: ${p.repository}`);
  lines.push(`Package: https://crates.io/crates/${p.name}/${p.version}`);
  for (const file of files) {
    const text = normalize(readFileSync(path.resolve(dir, file), 'utf8'));
    const previous = seenTexts.get(text);
    if (previous) {
      lines.push('', `--- ${file}: identical to ${previous} above.`);
    } else {
      seenTexts.set(text, `${file} of ${p.name} ${p.version}`);
      lines.push('', `--- ${file}`, '', text);
    }
  }
  sections.push(lines.join('\n'));
}
if (problems.length) {
  fail(`license check failed, review these crates before shipping them:\n  ${problems.join('\n  ')}`);
}

const rustVersion = rustc.version.replace(/^rustc\s+/, '');
const rustLicenses = path.join(sysroot, 'share', 'doc', 'rust', 'licenses');
rows.push(['Rust standard library', rustVersion.split(' ')[0], 'Apache-2.0 OR MIT', 'MIT']);
const stdSection = [
  '='.repeat(100),
  `Rust standard library (core, alloc, std and the crates they use, such as dlmalloc and compiler_builtins), rustc ${rustVersion}`,
  'License: Apache-2.0 OR MIT; the Unicode tables in core: Unicode-3.0',
  'Copyright: The Rust Project Developers (see https://thanks.rust-lang.org)',
  'Source: https://github.com/rust-lang/rust',
  'Complete notices: share/doc/rust/COPYRIGHT-library.html in the Rust toolchain.',
];
for (const [file, title] of [['MIT.txt', 'MIT'], ['Unicode-3.0.txt', 'Unicode-3.0']]) {
  const source = path.join(rustLicenses, file);
  if (!existsSync(source)) fail(`missing ${source}; the Rust toolchain should ship it.`);
  stdSection.push('', `--- ${title}`, '', normalize(readFileSync(source, 'utf8')));
}
sections.push(stdSection.join('\n'));

const width = [0, 1, 2].map((c) => Math.max(...rows.map((r) => r[c].length)));
const table = rows.map((r) => [r[0].padEnd(width[0]), r[1].padEnd(width[1]), r[2].padEnd(width[2]), r[3]].join('  ').trimEnd());
const acadrust = crates.find((p) => p.name === 'acadrust');
const header = [
  'Third-party licenses: dwg2dxf_bg.wasm and dwg2dxf.js',
  '',
  'dwg2dxf_bg.wasm and its JavaScript glue dwg2dxf.js convert DWG drawings to DXF inside OPSIS.',
  'They are built from crates/dwg2dxf in the OPSIS repository (GPL-3.0-or-later) and contain',
  'code from the Rust crates and the Rust standard library listed below. The glue code is generated by',
  'wasm-bindgen. This file is generated by scripts/build-dwg-wasm.mjs from crates/dwg2dxf/Cargo.lock.',
  '',
  `The DWG reader and DXF writer is acadrust ${acadrust.version} (MPL-2.0). Its source code is available at`,
  `${acadrust.repository} and https://crates.io/crates/acadrust/${acadrust.version}.`,
  "acadrust's DWG code is ported from ACadSharp (MIT); see its THIRD_PARTY_NOTICES.md below.",
  '',
  'Where a crate offers a choice of licenses, it is used under the one in the last column.',
  '',
  ['Crate'.padEnd(width[0]), 'Version'.padEnd(width[1]), 'License'.padEnd(width[2]), 'Used under'].join('  '),
  '-'.repeat(width[0] + width[1] + width[2] + 20),
  ...table,
  '',
];
const licenseText = `${header.join('\n')}\n${sections.join('\n\n\n')}\n`;

// ---- Build ---------------------------------------------------------------------------------------------------

// Panic messages contain source paths. Map the local ones (user name, checkout location) to fixed names, so the
// committed binary does not reveal them and does not depend on where it was built.
const remap = new Map([[CRATE, '/dwg2dxf']]);
for (const p of metadata.packages) {
  if (!p.source?.startsWith('registry+')) continue;
  remap.set(path.dirname(path.dirname(p.manifest_path)), '/crates'); // .../registry/src/<index>/<name>-<version>/Cargo.toml
}
const rustflags = process.env.CARGO_ENCODED_RUSTFLAGS
  ? process.env.CARGO_ENCODED_RUSTFLAGS.split('\x1f')
  : (process.env.RUSTFLAGS ?? '').split(/\s+/).filter(Boolean);
for (const [from, to] of remap) rustflags.push(`--remap-path-prefix=${from}=${to}`);

console.log(`\ncargo build --release --locked --target ${TARGET}`);
run(cargo.command, ['build', '--release', '--locked', '--target', TARGET], {
  stdio: 'inherit',
  env: { ...process.env, CARGO_ENCODED_RUSTFLAGS: rustflags.join('\x1f') },
});

const wasmIn = path.join(CRATE, 'target', TARGET, 'release', 'dwg2dxf.wasm');
for (const file of ['dwg2dxf.js', 'dwg2dxf.d.ts', 'dwg2dxf_bg.wasm', 'dwg2dxf_bg.wasm.d.ts', 'snippets']) {
  rmSync(path.join(OUT, file), { recursive: true, force: true });
}
console.log(`\nwasm-bindgen --target web -> ${path.relative(ROOT, OUT)}`);
// --experimental-reset-state-function exports __wbg_reset_state(), which callers use after a Rust panic
// (error name "DwgReaderCrash") to continue with a fresh module instance.
run(bindgen.command, [
  '--target', 'web',
  '--experimental-reset-state-function',
  '--out-dir', OUT,
  '--out-name', 'dwg2dxf',
  wasmIn,
], { stdio: 'inherit' });
for (const stray of ['package.json', '.gitignore']) rmSync(path.join(OUT, stray), { force: true });
writeFileSync(path.join(OUT, 'THIRD_PARTY_LICENSES.txt'), licenseText);

// ---- Summary -------------------------------------------------------------------------------------------------

const wasm = readFileSync(path.join(OUT, 'dwg2dxf_bg.wasm'));
const kib = (n) => `${(n / 1024).toFixed(0)} KiB`;
console.log(`\nWrote ${path.relative(ROOT, OUT)}:`);
for (const file of readdirSync(OUT).sort()) console.log(`  ${file.padEnd(28)} ${kib(statSync(path.join(OUT, file)).size)}`);
console.log(`dwg2dxf_bg.wasm: ${kib(wasm.length)}, ${kib(gzipSync(wasm, { level: 9 }).length)} gzipped`);
console.log(`Licenses: ${crates.length} crates + Rust standard library, all GPL-3.0-compatible.`);
