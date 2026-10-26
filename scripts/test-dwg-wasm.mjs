// SPDX-License-Identifier: GPL-3.0-or-later
// Tests the DWG -> DXF converter in src/wasm/dwg2dxf/ (built by scripts/build-dwg-wasm.mjs) in Node, using the
// generated sample drawings in samples/cad/: the flange in every DWG version (compared with flange.dxf), AutoCAD
// Architecture walls/doors/windows, a paper-space layout with viewports, and broken input.
//
// Usage: node scripts/test-dwg-wasm.mjs [drawing.dwg ...]
// Extra drawings given on the command line (for example real files that must not go into the repository) are only
// converted and summarized: counts, sizes, timings and memory, never their content. Each runs in its own worker, so
// the memory figure is that drawing's peak.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const ROOT = path.resolve(import.meta.dirname, '..');
const WASM_DIR = path.join(ROOT, 'src', 'wasm', 'dwg2dxf');
const SAMPLES = path.join(ROOT, 'samples', 'cad');

async function load() {
  const mod = await import(pathToFileURL(path.join(WASM_DIR, 'dwg2dxf.js')).href);
  const exports = mod.initSync({ module: readFileSync(path.join(WASM_DIR, 'dwg2dxf_bg.wasm')) });
  return { mod, exports };
}

// ---- Minimal DXF reader ----------------------------------------------------------------------------------------

function pairs(text) {
  const lines = text.split(/\r?\n/);
  const result = [];
  for (let i = 0; i + 1 < lines.length; i += 2) result.push([Number(lines[i].trim()), lines[i + 1]]);
  return result;
}

// Sections, layer names and the entities of ENTITIES, BLOCKS and OBJECTS with their group codes.
function readDxf(text) {
  const all = pairs(text);
  const sections = [];
  const layers = [];
  const records = [];
  let section = null;
  let table = null;
  let block = null;
  let current = null;
  for (let i = 0; i < all.length; i++) {
    const [code, value] = all[i];
    if (code === 0 && value === 'SECTION') {
      section = all[i + 1][1];
      sections.push(section);
      i++;
      continue;
    }
    if (code === 0 && value === 'ENDSEC') {
      section = null;
      current = null;
      continue;
    }
    if (section === 'TABLES') {
      if (code === 0 && value === 'TABLE') table = all[i + 1][1];
      if (code === 0) current = value === 'LAYER' && table === 'LAYER' ? 'LAYER' : null;
      if (current === 'LAYER' && code === 2) layers.push(value);
    }
    if (section === 'ENTITIES' || section === 'BLOCKS' || section === 'OBJECTS') {
      if (code === 0) {
        current = { section, block, type: value, codes: new Map(), all: [] };
        records.push(current);
      } else if (current) {
        if (!current.codes.has(code)) current.codes.set(code, value.trim());
        current.all.push([code, value.trim()]);
        if (current.type === 'BLOCK' && code === 2) block = current.block = value.trim();
      }
    }
  }
  const drawn = (r) => !['ENDSEC', 'EOF', 'BLOCK', 'ENDBLK', 'SEQEND'].includes(r.type);
  const entities = records.filter((r) => r.section === 'ENTITIES' && drawn(r));
  const blockEntities = (name) => records.filter((r) => r.section === 'BLOCKS' && r.block === name && drawn(r));
  return { sections, layers, records, entities, blockEntities, first: all[0], last: all.at(-1) };
}

// One line per drawing entity with its layer and geometry, rounded, so two drawings can be compared.
function signature(entity) {
  const n = (code) => Number(entity.codes.get(code) ?? 0).toFixed(3);
  const layer = entity.codes.get(8);
  switch (entity.type) {
    case 'LINE': return `LINE ${layer} ${n(10)},${n(20)} ${n(11)},${n(21)}`;
    case 'CIRCLE': return `CIRCLE ${layer} ${n(10)},${n(20)} r${n(40)}`;
    case 'ARC': return `ARC ${layer} ${n(10)},${n(20)} r${n(40)} ${n(50)}..${n(51)}`;
    case 'TEXT': return `TEXT ${layer} ${n(10)},${n(20)} h${n(40)} "${entity.codes.get(1)}"`;
    default: return `${entity.type} ${layer}`;
  }
}

const countTypes = (entities) =>
  Object.fromEntries([...Map.groupBy(entities, (e) => e.type)].map(([type, list]) => [type, list.length]).sort());
const decode = (bytes) => new TextDecoder('utf-8', { fatal: true }).decode(bytes);
const close = (a, b) => Math.abs(Number(a) - b) < 1e-6;

// ---- Extra drawings: summary only (runs in a worker) -----------------------------------------------------------

async function summarize(file) {
  const { mod, exports } = await load();
  const mb = () => Math.round(exports.memory.buffer.byteLength / 2 ** 20);
  const bytes = readFileSync(file);
  const out = { megabytes: (bytes.length / 1e6).toFixed(1) };
  let started = performance.now();
  try {
    const c = mod.dwg_convert(bytes);
    out.convert = {
      ms: Math.round(performance.now() - started),
      dxfMB: (c.dxf.length / 1e6).toFixed(1),
      version: c.version,
      entities: c.entities,
      layers: c.layers,
      recovered: c.recovered,
      warnings: c.warnings, // generic German summaries with counts, no drawing content
      details: c.details.length,
      layouts: c.layouts.length,
      modelEntityTypes: countTypes(readDxf(decode(c.dxf)).entities),
      wasmMemoryMB: mb(),
    };
  } catch (error) {
    out.error = `${error?.name}: ${String(error?.message).slice(0, 160)}`;
    parentPort.postMessage(out);
    return;
  }
  started = performance.now();
  const drawing = mod.DwgDrawing.open(bytes);
  out.open = { ms: Math.round(performance.now() - started), wasmMemoryMB: mb() };
  out.layoutDxfs = [];
  for (let i = 0; i < drawing.layouts().length; i++) {
    started = performance.now();
    const dxf = drawing.layoutDxf(i);
    out.layoutDxfs.push({ ms: Math.round(performance.now() - started), dxfMB: (dxf.length / 1e6).toFixed(1) });
  }
  drawing.free();
  started = performance.now();
  const full = mod.dwg_to_dxf(bytes, true);
  out.full = { ms: Math.round(performance.now() - started), dxfMB: (full.length / 1e6).toFixed(1) };
  out.peakWasmMemoryMB = mb();
  parentPort.postMessage(out);
}

if (!isMainThread) {
  await summarize(workerData.file);
} else {
  await main();
}

async function main() {
  const { mod } = await load();
  const { dwg_convert, dwg_to_dxf, dwg_version, dwg_layout_to_dxf, DwgDrawing, __wbg_reset_state } = mod;

  let failures = 0;
  const check = (condition, message) => {
    if (!condition) {
      failures++;
      console.log(`  FAIL ${message}`);
    }
    return condition;
  };

  // ---- Flange in every version -----------------------------------------------------------------------------

  const reference = readDxf(readFileSync(path.join(SAMPLES, 'flange.dxf'), 'latin1'));
  const referenceSignatures = reference.entities.map(signature).sort();
  const EXPECTED_LAYERS = ['OUTLINE', 'HOLES', 'CENTERLINES', 'TEXT'];
  console.log(`flange.dxf: ${reference.entities.length} entities ${JSON.stringify(countTypes(reference.entities))}`);

  const samples = readdirSync(SAMPLES).filter((f) => f.toLowerCase().endsWith('.dwg')).sort();
  const flanges = samples.filter((f) => /^flange-r\d+\.dwg$/.test(f));
  check(flanges.length > 0, 'no flange DWG files in samples/cad');
  for (const file of flanges) {
    const bytes = readFileSync(path.join(SAMPLES, file));
    const started = performance.now();
    let result;
    try {
      result = dwg_convert(bytes);
    } catch (error) {
      check(false, `${file}: conversion failed: ${error.message}`);
      continue;
    }
    const ms = performance.now() - started;
    const text = decode(result.dxf);
    const dxf = readDxf(text);
    const dxfVersion = /\$ACADVER\r?\n\s*1\r?\n(\S+)/.exec(text)?.[1];
    console.log(
      `${file}: ${result.version} (${result.release}) -> DXF ${dxfVersion}, ${result.dxf.length} bytes, ${ms.toFixed(0)} ms; ` +
        `${result.entities} entities ${JSON.stringify(countTypes(dxf.entities))}, ${dxf.layers.length} layers [${dxf.layers.join(', ')}], ` +
        `layouts [${result.layouts.join(', ')}]` + (result.warnings.length ? `, warnings: ${result.warnings.join(' | ')}` : ''),
    );
    // Display mode writes group codes without padding and LF line ends; acadrust's own output pads them and uses CRLF.
    check(/^ *0\r?\nSECTION\r?\n *2\r?\nHEADER\r?\n/.test(text), `${file}: DXF does not start with 0/SECTION 2/HEADER`);
    check(dxf.last?.[0] === 0 && dxf.last?.[1] === 'EOF', `${file}: DXF does not end with 0/EOF`);
    for (const section of ['HEADER', 'TABLES', 'BLOCKS', 'ENTITIES']) check(dxf.sections.includes(section), `${file}: section ${section} missing`);
    for (const layer of EXPECTED_LAYERS) check(dxf.layers.includes(layer), `${file}: layer ${layer} missing`);
    check(result.recovered === false && result.warnings.length === 0 && result.details.length === 0, `${file}: unexpected warnings`);
    check(result.entities === reference.entities.length, `${file}: ${result.entities} entities, expected ${reference.entities.length}`);
    check(dwg_version(bytes) === result.version, `${file}: dwg_version() disagrees`);
    const signatures = dxf.entities.map(signature).sort();
    const missing = referenceSignatures.filter((s) => !signatures.includes(s));
    const extra = signatures.filter((s) => !referenceSignatures.includes(s));
    check(missing.length === 0 && extra.length === 0, `${file}: geometry differs from flange.dxf\n    missing: ${missing.join('\n             ')}\n    extra: ${extra.join('\n           ')}`);
    check(countTypes(dxf.entities).CIRCLE === 8, `${file}: expected 8 circles`);
    check(Buffer.from(dwg_to_dxf(bytes)).equals(Buffer.from(result.dxf)), `${file}: dwg_to_dxf differs from dwg_convert`);
    // full = true: acadrust's complete output, CRLF, with OBJECTS, same geometry.
    const full = decode(dwg_to_dxf(bytes, true));
    const fullDxf = readDxf(full);
    check(full.includes('\r\n') && fullDxf.sections.includes('OBJECTS') && fullDxf.records.some((r) => r.section === 'OBJECTS' && r.type === 'DICTIONARY'), `${file}: full DXF lacks OBJECTS`);
    check(fullDxf.entities.map(signature).sort().join() === referenceSignatures.join(), `${file}: full DXF geometry differs`);
    check(full.length > text.length, `${file}: full DXF is not larger than the display DXF`);
  }

  // ---- AutoCAD Architecture ------------------------------------------------------------------------------------

  console.log('\narch-walls-r2018.dwg (Arch entities without DXF form, replaced by their proxy graphics):');
  {
    const bytes = readFileSync(path.join(SAMPLES, 'arch-walls-r2018.dwg'));
    const result = dwg_convert(bytes);
    const dxf = readDxf(decode(result.dxf));
    console.log(`  ${result.dxf.length} bytes, entities ${JSON.stringify(countTypes(dxf.entities))}, warnings: ${result.warnings.join(' | ')}`);
    const expectedWarnings = [
      '5 elements from AutoCAD Architecture shown as simple geometry',
      '1 Architecture element without displayable geometry left out',
      '5 Architecture settings objects skipped',
    ];
    for (const warning of expectedWarnings) check(result.warnings.includes(warning), `arch: warning "${warning}" missing`);
    check(result.recovered === false, 'arch: recovered');
    check(!dxf.records.some((r) => r.type.startsWith('AEC')), 'arch: AEC records left in the DXF');
    const on = (layer, type) => dxf.entities.filter((e) => e.codes.get(8) === layer && (!type || e.type === type));
    const at = (e, x, y) => close(e.codes.get(10), x) && close(e.codes.get(20), y);
    // Wall 1 from its own graphics, wall 2 from its native parameters (its graphics hold nothing drawable).
    const walls = on('A-Wall', 'LWPOLYLINE');
    check(walls.length === 2 && walls.every((w) => w.codes.get(70) === '1'), 'arch: expected two closed wall outlines');
    const xs = (e) => e.all.filter(([c]) => c === 10).map(([, v]) => Number(v));
    check(walls.some((w) => xs(w).includes(5880) && xs(w).includes(6120)), 'arch: wall 2 outline (5880..6120) missing');
    // Door: every proxy record type.
    const door = on('A-Door');
    const has = (type, predicate, message) => check(door.some((e) => e.type === type && predicate(e)), `arch: door ${message}`);
    has('ARC', (e) => at(e, 0, 0) && close(e.codes.get(40), 900) && close(e.codes.get(50), 0) && close(e.codes.get(51), 90), 'swing arc');
    has('LWPOLYLINE', (e) => e.codes.get(62) === '1', 'red leaf (color trait)');
    has('CIRCLE', (e) => at(e, 2000, 1100) && close(e.codes.get(40), 50), 'circle moved by the matrix');
    has('ARC', (e) => at(e, 2000, 1000) && close(e.codes.get(50), 0) && close(e.codes.get(51), 90), 'arc with -Z normal under the matrix');
    has('CIRCLE', (e) => at(e, 3100, 0) && close(e.codes.get(40), 100) && e.codes.get(420) === String(0xff8000), '3-point circle in true color');
    has('ARC', (e) => at(e, 3500, 0) && close(e.codes.get(50), 0) && close(e.codes.get(51), 180), '3-point arc');
    has('LWPOLYLINE', (e) => xs(e).includes(5050) && e.codes.get(70) === '1', 'bit-coded LWPOLYLINE');
    has('TEXT', (e) => e.codes.get(1) === 'Door 1 – Ø 90' && close(e.codes.get(40), 150), 'Unicode text');
    has('TEXT', (e) => e.codes.get(1) === 'T-01', 'ASCII text');
    has('TEXT', (e) => e.codes.get(1) === 'Opening 1 × 1 m', 'Unicode text with style');
    check(door.filter((e) => e.type === 'LINE').length === 12, `arch: door lines (sector 2 + mesh 4 + shell 5 + 1) = ${door.filter((e) => e.type === 'LINE').length}`);
    // Window in model space and inside the block definition.
    check(on('A-Glaz', 'LWPOLYLINE').length === 1, 'arch: window in model space');
    check(dxf.blockEntities('WINDOW').some((e) => e.type === 'LWPOLYLINE' && e.codes.get(8) === 'A-Glaz'), 'arch: window inside block WINDOW');
    check(dxf.entities.filter((e) => e.type === 'INSERT' && e.codes.get(2) === 'WINDOW').length === 2, 'arch: two WINDOW inserts');
    check(['LINE', 'CIRCLE', 'TEXT'].every((t) => on('0', t).length >= 1), 'arch: ordinary entities missing');
    // full = true keeps OBJECTS: no Arch objects left, and every dictionary entry points at an object that exists.
    const full = readDxf(decode(dwg_to_dxf(bytes, true)));
    check(!full.records.some((r) => r.type.startsWith('AEC')), 'arch full: AEC records left');
    const defined = new Set(full.records.flatMap((r) => r.all.filter(([c]) => c === 5 || c === 105).map(([, v]) => v)));
    const dangling = full.records
      .filter((r) => r.type === 'DICTIONARY')
      .flatMap((r) => r.all.filter(([c]) => c === 350 || c === 360).map(([, v]) => v))
      .filter((h) => !defined.has(h));
    check(dangling.length === 0, `arch full: dictionary entries pointing nowhere: ${dangling.join(', ')}`);
  }

  // ---- Layouts ----------------------------------------------------------------------------------------------------

  console.log('\nflange-layout-r2018.dwg (Layout1 with an overall viewport, a 1:2 viewport and a twisted 2:1 detail):');
  {
    const bytes = readFileSync(path.join(SAMPLES, 'flange-layout-r2018.dwg'));
    const drawing = DwgDrawing.open(bytes);
    check(JSON.stringify(drawing.layouts()) === '["Layout1"]', `layout: names ${JSON.stringify(drawing.layouts())}`);
    const model = readDxf(decode(drawing.modelDxf()));
    check(model.entities.map(signature).sort().join() === referenceSignatures.join(), 'layout: model space differs from flange.dxf');
    check(!model.entities.some((e) => e.codes.get(8) === 'FRAME'), 'layout: paper-space entities in the model DXF');
    const layoutBytes = drawing.layoutDxf(0);
    const layout = readDxf(decode(layoutBytes));
    console.log(`  layout DXF ${layoutBytes.length} bytes, entities ${JSON.stringify(countTypes(layout.entities))}`);
    check(!layout.entities.some((e) => e.type === 'VIEWPORT'), 'layout: VIEWPORT entities left');
    check(layout.entities.some((e) => e.type === 'LWPOLYLINE' && e.codes.get(8) === 'FRAME'), 'layout: frame missing');
    check(layout.entities.some((e) => e.type === 'TEXT' && e.codes.get(8) === 'FRAME'), 'layout: title missing');
    const inserts = layout.entities.filter((e) => e.type === 'INSERT');
    check(inserts.length === 2, `layout: expected 2 viewport inserts, found ${inserts.length}`);
    const [main, detail] = inserts;
    check(main && close(main.codes.get(10), 100) && close(main.codes.get(20), 113) && close(main.codes.get(41), 0.5) && !main.codes.has(50), 'layout: 1:2 viewport placement');
    check(detail && close(detail.codes.get(41), 2) && close(detail.codes.get(50), 30), 'layout: 2:1 detail scale and twist');
    const mainBlock = layout.blockEntities(main?.codes.get(2));
    check(mainBlock.map(signature).sort().join() === referenceSignatures.join(), 'layout: 1:2 viewport does not show the whole flange');
    const detailBlock = layout.blockEntities(detail?.codes.get(2));
    check(detailBlock.some((e) => e.type === 'CIRCLE' && close(e.codes.get(10), 55) && close(e.codes.get(20), 0)), 'layout: detail lacks the bolt hole');
    check(!detailBlock.some((e) => e.codes.get(8) === 'CENTERLINES'), 'layout: layer frozen in the detail viewport is shown');
    check(detailBlock.length < mainBlock.length, 'layout: detail viewport not filtered');
    check(Buffer.from(dwg_layout_to_dxf(bytes, 0)).equals(Buffer.from(layoutBytes)), 'layout: dwg_layout_to_dxf differs');
    let threw = false;
    try {
      drawing.layoutDxf(5);
    } catch {
      threw = true;
    }
    check(threw, 'layout: index out of range did not throw');
    check(drawing.warnings.length === 0 && drawing.recovered === false, 'layout: unexpected warnings');
    drawing.free();
  }

  // ---- Broken input ----------------------------------------------------------------------------------------------

  function prng(seed) {
    let s = seed >>> 0;
    return () => {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      return (s >>> 0) / 0x100000000;
    };
  }

  // Runs one conversion and classifies the outcome. A crash (Rust panic or wasm trap) resets the module.
  function attempt(bytes) {
    try {
      dwg_to_dxf(bytes);
      return { kind: 'ok' };
    } catch (error) {
      if (error?.name === 'DwgReaderCrash' || error instanceof WebAssembly.RuntimeError) {
        __wbg_reset_state();
        return { kind: 'crash', message: `${error.name}: ${error.message}` };
      }
      return { kind: 'error', message: `${error.name}: ${error.message}` };
    }
  }

  const random = prng(0xd06);
  const garbage = Uint8Array.from({ length: 4096 }, () => Math.floor(random() * 256));
  const cases = [
    ['empty array', new Uint8Array(0)],
    ['4 KiB of random bytes', garbage],
    ['"AC1032" followed by random bytes', Uint8Array.from([...Buffer.from('AC1032'), ...garbage])],
    ['"AC1015" followed by random bytes', Uint8Array.from([...Buffer.from('AC1015'), ...garbage])],
    ['"AC1009" followed by random bytes', Uint8Array.from([...Buffer.from('AC1009'), ...garbage])],
    ['a DXF file', readFileSync(path.join(SAMPLES, 'flange.dxf'))],
    ['"AC1006" (R10)', Buffer.from('AC1006\0\0\0\0')],
  ];
  console.log('\nBroken input (must throw a plain Error):');
  for (const [label, bytes] of cases) {
    const outcome = attempt(bytes);
    console.log(`  ${label}: ${outcome.kind} ${outcome.message ?? ''}`);
    check(outcome.kind === 'error' && outcome.message.startsWith('Error: '), `${label}: expected a plain Error`);
  }
  check(dwg_version(new Uint8Array(0)) === undefined, 'dwg_version of empty input is not undefined');
  check(dwg_version(garbage) === undefined, 'dwg_version of garbage is not undefined');

  // Damaged copies of the samples: truncated and with random bytes overwritten. These may convert, fail or crash
  // acadrust; a crash is reported but only counts as a failure if the module does not work afterwards.
  console.log('\nDamaged samples (truncated / bytes overwritten):');
  const tally = { ok: 0, error: 0, crash: 0 };
  const crashes = [];
  for (const file of samples) {
    const original = readFileSync(path.join(SAMPLES, file));
    const variants = [];
    for (const fraction of [0.1, 0.5, 0.9, 0.99]) variants.push([`${file} cut to ${fraction * 100}%`, original.subarray(0, Math.floor(original.length * fraction))]);
    for (let round = 0; round < 25; round++) {
      const copy = Uint8Array.from(original);
      const flips = 1 + Math.floor(random() * 8);
      for (let k = 0; k < flips; k++) copy[6 + Math.floor(random() * (copy.length - 6))] = Math.floor(random() * 256);
      variants.push([`${file} with ${flips} random bytes (round ${round})`, copy]);
    }
    for (const [label, bytes] of variants) {
      const outcome = attempt(bytes);
      tally[outcome.kind]++;
      if (outcome.kind === 'crash') crashes.push(`${label}: ${outcome.message.split('\n').join(' ')}`);
    }
    check(attempt(original).kind === 'ok', `${file}: module unusable after damaged input`);
  }
  console.log(`  ${tally.ok} converted, ${tally.error} rejected with an error, ${tally.crash} crashed (module reset each time)`);
  for (const line of crashes.slice(0, 10)) console.log(`    crash: ${line.slice(0, 300)}`);
  if (crashes.length > 10) console.log(`    ... and ${crashes.length - 10} more`);

  // ---- Extra drawings from the command line ---------------------------------------------------------------------

  const extra = process.argv.slice(2);
  for (const [index, file] of extra.entries()) {
    console.log(`\nExtra drawing ${index + 1} (summary only):`);
    const summary = await new Promise((resolve, reject) => {
      const worker = new Worker(new URL(import.meta.url), { workerData: { file } });
      worker.once('message', resolve);
      worker.once('error', reject);
    });
    console.log(JSON.stringify(summary, null, 2).replace(/^/gm, '  '));
    check(!summary.error, `extra drawing ${index + 1}: conversion failed`);
  }

  console.log(failures ? `\n${failures} check(s) failed.` : '\nAll checks passed.');
  process.exit(failures ? 1 : 0);
}
