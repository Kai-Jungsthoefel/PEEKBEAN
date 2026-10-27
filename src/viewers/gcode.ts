// SPDX-License-Identifier: GPL-3.0-or-later
// CNC and 3D printer programs: the program text next to its tool paths in 3D, with playback. Cutting or extrusion
// moves are drawn in the tool's color, rapid and travel moves dashed gray, drilled holes as points. Selecting a line
// shows what it does in 3D; clicking a path selects its line. On phones code and 3D view take turns.
import * as THREE from 'three';
import { basicSetup } from 'codemirror';
import { StreamLanguage, syntaxHighlighting } from '@codemirror/language';
import { EditorState, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view';
import { looksLikeText } from '../core/bytes';
import { h, setPressed } from '../core/dom';
import { icon } from '../core/icons';
import { syntax } from '../core/syntax';
import type { ViewerContext } from '../core/types';
import type { GcodeResponse } from '../workers/gcode.worker';
import type { SnapCircle } from './three/measure';
import { mountScene } from './three/scene';

const TOOL_COLORS = [0xf29a38, 0x2f7fd6, 0x3e9a48, 0x8a63d2, 0xd9443c, 0x1aa3a3, 0xa68a2d, 0x6b8e23];
const RAPID_COLOR = 0x8f99a5;
/** The line being shown: a color no tool gets. */
const HIGHLIGHT_COLOR = 0xff00aa;
/** Seconds the whole program takes at 1× playback speed. */
const PROGRAM_SECONDS = 30;
const SPEEDS = [0.25, 0.5, 1, 2, 4, 8, 16];
/** Larger programs are still drawn, but without their text. */
const MAX_TEXT = 50 * 1024 * 1024;

type Result = Extract<GcodeResponse, { ok: true }>;

function interpretInWorker(text: string): Promise<Result> {
  const worker = new Worker(new URL('../workers/gcode.worker.ts', import.meta.url), { type: 'module' });
  return new Promise<GcodeResponse>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<GcodeResponse>) => resolve(event.data);
    worker.onerror = (event) => reject(new Error(event.message || 'The G-code reader could not be loaded.'));
    worker.postMessage(text);
  })
    .finally(() => worker.terminate())
    .then((result) => {
      if (!result.ok) throw new Error(result.error);
      return result;
    });
}

/** Colors for G-code words: comments, line numbers, G and M codes, tool/speed/feed, coordinates. */
const gcodeLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;
    if (stream.match(/^\([^)]*\)?/) || stream.match(/^;.*/) || stream.match(/^%.*/)) return 'comment';
    if (stream.match(/^[Nn]\d+/) || stream.match(/^[Oo]\d+/)) return 'meta';
    if (stream.match(/^[GgMm]\d+(\.\d+)?/)) return 'keyword';
    if (stream.match(/^[TtSsFfEe][+-]?(\d+\.?\d*|\.\d+)/)) return 'atom';
    if (stream.match(/^[A-Za-z][+-]?(\d+\.?\d*|\.\d+)/)) return 'number';
    stream.next();
    return null;
  },
});

/** Highlights the line being shown in the program text. */
const setCurrentLine = StateEffect.define<number>();
const currentLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(setCurrentLine)) continue;
      if (effect.value < 0 || effect.value >= tr.state.doc.lines) return Decoration.none;
      const builder = new RangeSetBuilder<Decoration>();
      const line = tr.state.doc.line(effect.value + 1);
      builder.add(line.from, line.from, Decoration.line({ class: 'cm-gcode-current' }));
      return builder.finish();
    }
    return value.map(tr.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

/** Number of entries of a sorted array that are below `value`. */
function countBelow(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface PathGroup {
  /** Global segment numbers of this group, in program order. */
  segments: Uint32Array;
  done: THREE.LineSegments;
  /** The rest of the path, faint, while playback has not reached it. */
  todo: THREE.LineSegments;
}

const length = (value: number, unit: string) => `${value.toLocaleString('en-US', { maximumFractionDigits: 0 })} ${unit}`;

export async function mount(ctx: ViewerContext) {
  const { file, container, toolbar } = ctx;
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  // .nc is also NetCDF, a binary format for scientific data.
  if (!looksLikeText(head)) throw new Error('This file is not a CNC program in G-code (it is binary, perhaps NetCDF data).');
  ctx.progress('Reading tool paths …');
  const text = await file.text();
  const result = await interpretInWorker(text);
  const segmentCount = result.lines.length;
  if (segmentCount === 0) throw new Error('No tool movements were found in this program.');

  // ---- Program order: path length so far, and the segments each source line produced -------------------------------
  const pos = result.positions;
  const travelled = new Float64Array(segmentCount + 1);
  for (let s = 0; s < segmentCount; s++) {
    const o = s * 6;
    travelled[s + 1] = travelled[s] + Math.hypot(pos[o + 3] - pos[o], pos[o + 4] - pos[o + 1], pos[o + 5] - pos[o + 2]);
  }
  const total = travelled[segmentCount];
  /** Segments produced by lines up to and including each line. */
  const lineEnd = new Uint32Array(result.lineCount);
  for (let s = 0; s < segmentCount; s++) lineEnd[result.lines[s]]++;
  for (let l = 1; l < lineEnd.length; l++) lineEnd[l] += lineEnd[l - 1];
  const lineStart = (line: number) => (line > 0 ? lineEnd[line - 1] : 0);

  // ---- Scene: one group per tool, cutting and rapid moves as separate parts -----------------------------------------
  const tools = [...new Set([...result.tools, ...result.holeTools])].sort((a, b) => a - b);
  const colorOf = (tool: number) => TOOL_COLORS[tools.indexOf(tool) % TOOL_COLORS.length];
  const feedName = result.printer ? 'Extrusion' : 'Cutting moves';
  const rapidName = result.printer ? 'Travel moves' : 'Rapid moves';
  const root = new THREE.Group();
  const groups: PathGroup[] = [];
  const holeSets: { points: THREE.Points; doneAt: Uint32Array }[] = [];

  for (const tool of tools) {
    const parent = tools.length > 1 ? new THREE.Group() : root;
    parent.name = tool ? `Tool T${tool}` : 'No tool';
    for (const kind of [1, 0]) {
      const members: number[] = [];
      for (let s = 0; s < segmentCount; s++) if (result.tools[s] === tool && result.kinds[s] === kind) members.push(s);
      if (!members.length) continue;
      const positions = new Float32Array(members.length * 6);
      members.forEach((s, i) => positions.set(pos.subarray(s * 6, s * 6 + 6), i * 6));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const material = kind
        ? new THREE.LineBasicMaterial({ color: colorOf(tool) })
        : new THREE.LineDashedMaterial({ color: RAPID_COLOR, transparent: true, opacity: 0.8 });
      const done = new THREE.LineSegments(geometry, material);
      done.name = kind ? feedName : rapidName;
      if (!kind) {
        geometry.computeBoundingSphere();
        // Dashes scale with the part, about 150 of them across the whole program.
        const dash = Math.max(geometry.boundingSphere!.radius / 150, 1e-3);
        Object.assign(material, { dashSize: dash, gapSize: dash * 0.8 });
        done.computeLineDistances();
      }
      parent.add(done);
      groups.push({ segments: Uint32Array.from(members), done, todo: done });
    }
    const holeIndices = [...result.holeTools.keys()].filter((i) => result.holeTools[i] === tool);
    if (holeIndices.length) {
      const positions = new Float32Array(holeIndices.length * 3);
      holeIndices.forEach((hole, i) => positions.set(result.holes.subarray(hole * 3, hole * 3 + 3), i * 3));
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color: colorOf(tool), size: 7, sizeAttenuation: false }));
      points.name = `Holes (${holeIndices.length})`;
      parent.add(points);
      holeSets.push({ points, doneAt: Uint32Array.from(holeIndices, (i) => result.holeDoneAt[i]) });
    }
    if (parent !== root) root.add(parent);
  }

  // ---- Layout: code | divider | 3D, a playback bar below ------------------------------------------------------------
  const codePane = h('div', { class: 'gcode-code' });
  const viewPane = h('div', { class: 'gcode-3d' });
  const divider = h('div', { class: 'gcode-divider', role: 'separator', 'aria-orientation': 'vertical', title: 'Drag to resize' });
  const split = h('div', { class: 'gcode-split', 'data-pane': '3d' }, codePane, divider, viewPane);
  const playButton = h('button', { type: 'button', class: 'ibtn gcode-play', title: 'Play (Space)', 'aria-label': 'Play' }, icon('play', 16, 1.8));
  const slider = h('input', { type: 'range', class: 'gcode-slider', min: '0', max: String(total), step: 'any', value: String(total), 'aria-label': 'Position in the program' });
  const where = h('span', { class: 'gcode-where' });
  const speedSelect = h('select', { title: 'Playback speed' }, ...SPEEDS.map((s) => h('option', { value: String(s) }, `${s}×`)));
  speedSelect.value = '1';
  const paneButtons = (['code', '3d'] as const).map((pane) =>
    h('button', { type: 'button', role: 'radio', 'aria-checked': String(pane === '3d'), onclick: () => showPane(pane) }, pane === 'code' ? 'Code' : '3D'),
  );
  const bar = h('div', { class: 'gcode-bar' }, h('div', { class: 'seg gcode-panes', role: 'radiogroup', 'aria-label': 'Show' }, ...paneButtons), playButton, slider, where, speedSelect);
  container.append(h('div', { class: 'gcode-viewer' }, split, bar));

  function showPane(pane: 'code' | '3d'): void {
    split.dataset.pane = pane;
    paneButtons.forEach((b, i) => b.setAttribute('aria-checked', String((i === 0) === (pane === 'code'))));
  }

  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const rect = split.getBoundingClientRect();
      const width = Math.min(Math.max(ev.clientX - rect.left, 200), rect.width - 300);
      split.style.setProperty('--code-width', `${width}px`);
    };
    divider.addEventListener('pointermove', move);
    divider.addEventListener('pointerup', () => divider.removeEventListener('pointermove', move), { once: true });
  });

  // ---- 3D view -----------------------------------------------------------------------------------------------------
  toolbar.append(
    h('span', { class: 'meta', title: result.printer ? 'Length of the extrusion and travel moves' : 'Length of the cutting and rapid moves' },
      `${feedName}: ${length(result.feedLength, result.unit)} · ${rapidName.toLowerCase()}: ${length(result.rapidLength, result.unit)}`),
  );
  if (tools.length > 1) toolbar.append(h('span', { class: 'meta' }, `${tools.length} tools`));
  if (result.skipped) {
    toolbar.append(h('span', { class: 'meta', title: 'Variables, expressions, subprogram calls and manufacturer cycles are not evaluated' },
      `${result.skipped.toLocaleString('en-US')} ${result.skipped === 1 ? 'line' : 'lines'} not evaluated`));
  }
  // The program's arcs with their exact centers and radii, for measuring (Ø of a circular pocket, R of a corner).
  let circleCache: { matrix: THREE.Matrix4; circles: SnapCircle[] } | null = null;
  const circles = (): SnapCircle[] => {
    if (circleCache?.matrix.equals(root.matrixWorld)) return circleCache.circles;
    const matrix = root.matrixWorld.clone();
    const point = (s: number, end: number) => new THREE.Vector3(pos[s * 6 + end], pos[s * 6 + end + 1], pos[s * 6 + end + 2]).applyMatrix4(matrix);
    const list: SnapCircle[] = [];
    const arcs = result.arcs;
    for (let i = 0; i < arcs.length; i += 7) {
      const first = arcs[i + 5];
      const count = arcs[i + 6];
      list.push({
        center: new THREE.Vector3(arcs[i], arcs[i + 1], arcs[i + 2]).applyMatrix4(matrix),
        rim: point(first, 0),
        radius: arcs[i + 3],
        closed: arcs[i + 4] === 1,
        outline: () => [...Array.from({ length: count }, (_, k) => point(first + k, 0)), point(first + count - 1, 3)],
      });
    }
    circleCache = { matrix, circles: list };
    return list;
  };
  const scene = mountScene({ ...ctx, container: viewPane }, root, { zUp: true, unit: result.unit, title: file.name, circles });

  // Added after mounting, so they neither count for the model size nor show up in the structure tree.
  const helper = <T extends THREE.Object3D>(o: T): T => {
    o.userData.helper = true;
    o.raycast = () => {};
    return o;
  };
  for (const group of groups) {
    const geometry = new THREE.BufferGeometry();
    for (const name of ['position', 'lineDistance']) {
      const attribute = group.done.geometry.getAttribute(name);
      if (attribute) geometry.setAttribute(name, attribute);
    }
    const solid = group.done.material as THREE.LineBasicMaterial;
    const faint = solid.clone();
    Object.assign(faint, { transparent: true, opacity: 0.16 });
    group.todo = new THREE.LineSegments(geometry, faint);
    group.todo.userData.helper = true;
    group.done.add(group.todo);
  }
  const highlight = helper(new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: HIGHLIGHT_COLOR, depthTest: false, transparent: true })));
  highlight.renderOrder = 999;
  const toolHeight = scene.radius * 0.09;
  const coneGeometry = new THREE.ConeGeometry(toolHeight * 0.22, toolHeight, 20);
  // Tip at the origin, pointing down (−Z), like a cutter or a nozzle.
  coneGeometry.rotateX(-Math.PI / 2).translate(0, 0, toolHeight / 2);
  const marker = helper(new THREE.Mesh(coneGeometry, new THREE.MeshStandardMaterial({ color: HIGHLIGHT_COLOR, metalness: 0.2, roughness: 0.5, transparent: true, opacity: 0.9 })));
  root.add(highlight, marker);

  // ---- Program text ------------------------------------------------------------------------------------------------
  let editor: EditorView | null = null;
  if (text.length <= MAX_TEXT) {
    editor = new EditorView({
      parent: codePane,
      state: EditorState.create({
        doc: text,
        extensions: [
          basicSetup,
          EditorState.readOnly.of(true),
          gcodeLanguage,
          syntaxHighlighting(syntax),
          currentLineField,
          EditorView.updateListener.of((update) => {
            if (update.selectionSet && update.transactions.some((tr) => tr.isUserEvent('select'))) {
              // Not inside the editor's own update: showing the line dispatches to the editor again.
              const line = update.state.doc.lineAt(update.state.selection.main.head).number - 1;
              queueMicrotask(() => selectLine(line, false));
            }
          }),
          EditorView.theme({
            '&': { height: '100%', fontSize: '12.5px' },
            '.cm-scroller': { fontFamily: 'var(--mono)' },
            '.cm-gutters': { background: 'var(--s1)', color: 'var(--tx3)', borderRight: '1px solid var(--line)' },
            '.cm-activeLine, .cm-activeLineGutter': { background: 'transparent' },
            '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': { background: 'rgba(242,154,56,.28) !important' },
          }),
        ],
      }),
    });
  } else {
    codePane.append(h('p', { class: 'gcode-note' }, 'The program is too large to show its text here; the tool paths are complete.'));
  }

  // ---- Showing a position: path so far, the faint rest, the tool and the current line -------------------------------
  let position = total;
  let shownLine = -1;
  let lastScroll = 0;

  function showLine(line: number, scroll: boolean): void {
    if (line !== shownLine) {
      shownLine = line;
      const from = line >= 0 ? lineStart(line) : 0;
      const to = line >= 0 ? lineEnd[line] : 0;
      const geometry = new THREE.BufferGeometry();
      if (to > from) geometry.setAttribute('position', new THREE.BufferAttribute(pos.slice(from * 6, to * 6), 3));
      highlight.geometry.dispose();
      highlight.geometry = geometry;
      highlight.visible = to > from;
    }
    if (!editor || line < 0 || line >= editor.state.doc.lines) return;
    const effects: StateEffect<unknown>[] = [setCurrentLine.of(line)];
    const now = performance.now();
    if (scroll && now - lastScroll > 80) {
      lastScroll = now;
      effects.push(EditorView.scrollIntoView(editor.state.doc.line(line + 1).from, { y: 'nearest', yMargin: 60 }));
    }
    editor.dispatch({ effects });
  }

  /** Draws the program up to `length` along the path; `line` overrides the line shown (a selected line). */
  function show(length: number, line?: number): void {
    position = Math.min(Math.max(length, 0), total);
    // Segment the tool is on (cut fully: index < s), and how far along it.
    let s = countBelow(travelled, position + 1e-9) - 1;
    s = Math.min(Math.max(s, 0), segmentCount);
    const doneCount = position >= total ? segmentCount : s;
    for (const g of groups) {
      const count = countBelow(g.segments, doneCount);
      g.done.geometry.setDrawRange(0, count * 2);
      g.todo.geometry.setDrawRange(count * 2, Infinity);
    }
    for (const set of holeSets) set.points.geometry.setDrawRange(0, countBelow(set.doneAt, doneCount + 1));
    const seg = Math.min(s, segmentCount - 1);
    const segLength = travelled[seg + 1] - travelled[seg];
    const t = segLength > 0 ? Math.min(1, (position - travelled[seg]) / segLength) : 1;
    const o = seg * 6;
    marker.position.set(pos[o] + (pos[o + 3] - pos[o]) * t, pos[o + 1] + (pos[o + 4] - pos[o + 1]) * t, pos[o + 2] + (pos[o + 5] - pos[o + 2]) * t);
    const current = line ?? result.lines[seg];
    showLine(current, line === undefined);
    slider.value = String(position);
    where.textContent = current >= 0
      ? `Line ${(current + 1).toLocaleString('en-US')} · ${Math.round((position / total) * 100)} %`
      : `${segmentCount.toLocaleString('en-US')} moves`;
    scene.requestRender();
  }

  /** A line chosen in the code or the 3D view: the program runs up to its end, the line is shown. */
  function selectLine(line: number, fromView: boolean): void {
    pause();
    show(travelled[lineEnd[Math.min(line, lineEnd.length - 1)]], line);
    if (fromView && editor) {
      const target = editor.state.doc.line(line + 1);
      editor.dispatch({ selection: { anchor: target.from }, effects: EditorView.scrollIntoView(target.from, { y: 'center' }) });
    }
  }

  // ---- Playback ----------------------------------------------------------------------------------------------------
  let frame = 0;
  let last = 0;
  const tick = (now: number) => {
    const speed = Number(speedSelect.value);
    show(position + ((now - last) / 1000) * (total / PROGRAM_SECONDS) * speed);
    last = now;
    if (position >= total) pause();
    else frame = requestAnimationFrame(tick);
  };
  function play(): void {
    if (position >= total) show(0);
    last = performance.now();
    frame = requestAnimationFrame(tick);
    playButton.replaceChildren(icon('pause', 16, 1.8));
    playButton.setAttribute('aria-label', 'Pause');
    playButton.title = 'Pause (Space)';
    setPressed(playButton, true);
  }
  function pause(): void {
    cancelAnimationFrame(frame);
    frame = 0;
    playButton.replaceChildren(icon('play', 16, 1.8));
    playButton.setAttribute('aria-label', 'Play');
    playButton.title = 'Play (Space)';
    setPressed(playButton, false);
  }
  playButton.addEventListener('click', () => (frame ? pause() : play()));
  slider.addEventListener('input', () => {
    pause();
    show(Number(slider.value));
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== ' ' || !container.isConnected || (e.target as HTMLElement)?.closest?.('input, select, textarea, button, .cm-editor')) return;
    e.preventDefault();
    if (frame) pause();
    else play();
  };
  window.addEventListener('keydown', onKey);

  // A click on a path (not a drag, not while measuring) selects its line.
  const raycaster = new THREE.Raycaster();
  let down: { x: number; y: number } | null = null;
  scene.canvas.addEventListener('pointerdown', (e) => {
    down = e.button === 0 ? { x: e.clientX, y: e.clientY } : null;
  });
  scene.canvas.addEventListener('pointerup', (e) => {
    const d = down;
    down = null;
    if (!d || scene.isMeasuring() || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    const rect = scene.canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), scene.camera);
    raycaster.params.Line.threshold = scene.radius * 0.01;
    const visible = groups.filter((g) => g.done.visible && g.done.parent?.visible !== false);
    const pickables = visible.flatMap((g) => [g.done, g.todo]);
    // The helper raycast stub only applies to the highlight and marker; path parts and their faint rest are pickable.
    const hit = raycaster.intersectObjects(pickables, false)[0];
    if (!hit || hit.index === undefined) return;
    const group = groups.find((g) => g.done === hit.object || g.todo === hit.object)!;
    selectLine(result.lines[group.segments[Math.floor(hit.index / 2)]], true);
  });

  show(total, -1);
  return {
    destroy: () => {
      pause();
      window.removeEventListener('keydown', onKey);
      editor?.destroy();
      scene.destroy();
    },
  };
}
