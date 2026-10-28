// SPDX-License-Identifier: GPL-3.0-or-later
// Mind maps from XMind, MindManager, FreeMind and Freeplane, drawn as a map: the central topic in the middle, branches
// in their own colors, folding per topic, pan and zoom (also by pinching). A click on a topic shows its notes, link,
// labels, markers and attributes; "Outline" lists the same tree as text.
import { extensionOf, looksLikeText } from '../core/bytes';
import { h, setPressed, toolButton } from '../core/dom';
import { icon } from '../core/icons';
import type { Viewer, ViewerContext } from '../core/types';
import { connector, layoutSheet, type Placed } from './mindmap/layout';
import { countTopics, type MindMap, type MindSheet, type MindTopic } from './mindmap/model';
import { isFreeMind, readMindMap } from './mindmap/read';

const SVG = 'http://www.w3.org/2000/svg';
const MIN_SCALE = 0.05;
const MAX_SCALE = 4;
/** Above this many topics, levels below the second start folded, so the map opens readable. */
const AUTO_FOLD = 400;
/** Largest picture in a topic; bigger ones are scaled down. */
const IMAGE_BOX = { w: 180, h: 140 };

const color = (branch: number) => (branch < 0 ? 'var(--mm-cn)' : `var(--mm-c${branch % 8})`);

/** Links that may open in a new tab: web and mail; others (files, XMind attachments) are only shown. */
const openable = (link: string) => /^(https?:|mailto:)/i.test(link);
/** Links to another topic of the same map: "xmind:#id" (XMind) or "#id" (FreeMind). */
const internalTarget = (link: string) => /^(?:xmind:)?#(.+)$/.exec(link)?.[1];

export async function mount(ctx: ViewerContext): Promise<Viewer> {
  const { file, container, toolbar, progress } = ctx;
  // .mm is also the extension of Objective-C++ sources.
  if (extensionOf(file.name) === 'mm' && !isFreeMind((await file.slice(0, 2048).text()).replace(/^﻿/, ''))) {
    if (!looksLikeText(new Uint8Array(await file.slice(0, 4096).arrayBuffer()))) throw new Error('This file is not a FreeMind or Freeplane mind map.');
    const viewer = await (await import('./text')).mount(ctx);
    container.prepend(h('div', { class: 'banner' }, 'This .mm file is not a mind map, so it is shown as text. Objective-C++ sources use .mm as well.'));
    return viewer;
  }
  progress('Reading the mind map …');
  const map: MindMap = await readMindMap(file);
  // Natural sizes of the topic pictures, so topics can be measured before the pictures are drawn.
  const pictureSizes = new Map<string, { w: number; h: number }>();
  await Promise.all(
    map.urls.map(async (url) => {
      const probe = new Image();
      probe.src = url;
      try {
        await probe.decode();
        const scale = Math.min(1, IMAGE_BOX.w / (probe.naturalWidth || IMAGE_BOX.w), IMAGE_BOX.h / (probe.naturalHeight || IMAGE_BOX.h));
        pictureSizes.set(url, { w: Math.round((probe.naturalWidth || IMAGE_BOX.w) * scale), h: Math.round((probe.naturalHeight || IMAGE_BOX.h) * scale) });
      } catch {
        // An undecodable picture is left out.
      }
    }),
  );

  const view = h('div', { class: 'mm-view' });
  const stage = h('div', { class: 'mm-stage' });
  const lines = document.createElementNS(SVG, 'svg');
  lines.setAttribute('class', 'mm-lines');
  stage.append(lines);
  const details = h('aside', { class: 'mm-details', hidden: true, 'aria-label': 'Topic details' });
  const outline = h('div', { class: 'mm-outline', hidden: true });
  view.append(stage, outline, details);
  container.append(view);

  let sheet: MindSheet = map.sheets[0];
  const folded = new Set<MindTopic>();
  const elements = new Map<MindTopic, HTMLElement>();
  const sizes = new Map<MindTopic, { w: number; h: number }>();
  let placed: Placed[] = [];
  let byTopic = new Map<MindTopic, Placed>();
  let selected: MindTopic | null = null;
  let x = 0;
  let y = 0;
  let scale = 1;
  const zoomLabel = h('span', { class: 'meta zoom-label' });

  const apply = () => {
    stage.style.transform = `translate(${x}px, ${y}px) scale(${scale})`;
    zoomLabel.textContent = `${Math.round(scale * 100)} %`;
  };

  const allTopics = (s: MindSheet) => {
    const list: { topic: MindTopic; depth: number; parent: MindTopic | null }[] = [];
    const walk = (topic: MindTopic, depth: number, parent: MindTopic | null) => {
      list.push({ topic, depth, parent });
      for (const c of topic.children) walk(c, depth + 1, topic);
    };
    walk(s.root, 0, null);
    for (const f of s.floating) walk(f, 1, null);
    return list;
  };
  let parents = new Map<MindTopic, MindTopic | null>();

  function initialFolds(): void {
    folded.clear();
    const topics = allTopics(sheet);
    parents = new Map(topics.map((t) => [t.topic, t.parent]));
    for (const { topic } of topics) if (topic.folded && topic.children.length) folded.add(topic);
    let visible = 0;
    const count = (topic: MindTopic) => {
      visible++;
      if (!folded.has(topic)) topic.children.forEach(count);
    };
    count(sheet.root);
    sheet.floating.forEach(count);
    if (visible > AUTO_FOLD) for (const { topic, depth } of topics) if (depth >= 2 && topic.children.length) folded.add(topic);
  }

  const descendants = (topic: MindTopic): number => topic.children.reduce((n, c) => n + 1 + descendants(c), 0);

  function element(topic: MindTopic, depth: number): HTMLElement {
    const known = elements.get(topic);
    if (known) return known;
    const meta: Node[] = [];
    for (const m of topic.markers ?? []) meta.push(h('span', { class: 'mm-mark', title: m.title, style: `--mm-color: ${color(m.color)}` }, m.text));
    if (topic.notes) meta.push(h('span', { class: 'mm-has', title: 'Has notes' }, icon('text', 12)));
    if (topic.link) meta.push(h('span', { class: 'mm-has', title: topic.link }, icon('link', 12)));
    if (topic.attributes?.length) meta.push(h('span', { class: 'mm-has', title: 'Has attributes' }, icon('table', 12)));
    for (const label of topic.labels ?? []) meta.push(h('span', { class: 'mm-label' }, label));
    const picture = topic.image && pictureSizes.get(topic.image);
    const el = h(
      'div',
      { class: `mm-node d${Math.min(depth, 2)}${topic.summary ? ' summary' : ''}`, role: 'treeitem', tabindex: '-1' },
      picture ? h('img', { class: 'mm-img', src: topic.image, alt: '', draggable: false, width: picture.w, height: picture.h }) : null,
      h('span', { class: 'mm-title' }, topic.title || ' '),
      meta.length ? h('span', { class: 'mm-meta' }, ...meta) : null,
    );
    if (topic.children.length && depth > 0) {
      el.append(
        h('button', {
          type: 'button',
          class: 'mm-fold',
          onclick: (event: MouseEvent) => {
            event.stopPropagation();
            toggle(topic);
          },
        }),
      );
    }
    el.addEventListener('click', (event) => {
      if (moved) return;
      event.stopPropagation();
      select(topic);
    });
    el.addEventListener('dblclick', (event) => {
      event.stopPropagation();
      centerOn(topic);
    });
    elements.set(topic, el);
    return el;
  }

  function render(): void {
    // Topics on view: everything up to folded ones.
    const visible: { topic: MindTopic; depth: number }[] = [];
    const walk = (topic: MindTopic, depth: number) => {
      visible.push({ topic, depth });
      if (!folded.has(topic)) for (const c of topic.children) walk(c, depth + 1);
    };
    walk(sheet.root, 0);
    for (const f of sheet.floating) walk(f, 1);
    const wanted = new Set(visible.map((v) => v.topic));
    for (const [topic, el] of elements) if (!wanted.has(topic)) el.remove();
    const fresh: MindTopic[] = [];
    for (const { topic, depth } of visible) {
      const el = element(topic, depth);
      if (!el.isConnected) stage.append(el);
      if (!sizes.has(topic)) fresh.push(topic);
    }
    for (const topic of fresh) {
      const el = elements.get(topic)!;
      sizes.set(topic, { w: el.offsetWidth, h: el.offsetHeight });
    }
    placed = layoutSheet(sheet, (t) => sizes.get(t) ?? { w: 80, h: 24 }, (t) => !folded.has(t));
    byTopic = new Map(placed.map((p) => [p.topic, p]));
    for (const p of placed) {
      const el = elements.get(p.topic)!;
      el.style.transform = `translate(${p.x}px, ${p.y}px)`;
      el.style.setProperty('--mm-color', p.depth === 0 ? 'var(--tx)' : color(p.branch));
      el.classList.toggle('left', p.side < 0);
      el.classList.toggle('selected', p.topic === selected);
      const fold = el.querySelector<HTMLButtonElement>('.mm-fold');
      if (fold) {
        const closed = folded.has(p.topic);
        fold.textContent = closed ? String(descendants(p.topic)) : '−';
        fold.classList.toggle('closed', closed);
        fold.title = closed ? `Show ${descendants(p.topic)} more topics` : 'Fold';
        fold.setAttribute('aria-expanded', String(!closed));
      }
    }
    drawLines();
  }

  function drawLines(): void {
    const paths: string[] = [];
    for (const p of placed) {
      if (!p.parent) continue;
      paths.push(`<path d="${connector(p.parent, p)}" stroke="${color(p.branch)}" stroke-width="${p.depth === 1 ? 2.2 : 1.6}"/>`);
    }
    for (const r of sheet.relationships) {
      const a = placed.find((p) => p.topic.id === r.from);
      const b = placed.find((p) => p.topic.id === r.to);
      if (!a || !b) continue;
      const [ax, ay, bx, by] = [a.x + a.w / 2, a.y + a.h / 2, b.x + b.w / 2, b.y + b.h / 2];
      // Bowed to one side, so the line does not run straight through the branches between.
      const [mx, my] = [(ax + bx) / 2 - (by - ay) * 0.25, (ay + by) / 2 + (bx - ax) * 0.25];
      paths.push(`<path class="rel" d="M${ax},${ay} Q${mx},${my} ${bx},${by}"/>`);
      if (r.title) paths.push(`<text x="${(ax + 2 * mx + bx) / 4}" y="${(ay + 2 * my + by) / 4}" text-anchor="middle">${escapeXml(r.title)}</text>`);
    }
    lines.innerHTML = paths.join('');
  }

  const escapeXml = (text: string) => text.replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]!);

  /** Folds or unfolds a topic and keeps it where it is on screen. */
  function toggle(topic: MindTopic): void {
    const before = byTopic.get(topic);
    if (folded.has(topic)) folded.delete(topic);
    else folded.add(topic);
    render();
    const after = byTopic.get(topic);
    if (before && after) {
      x += (before.x - after.x) * scale;
      y += (before.y + before.h / 2 - (after.y + after.h / 2)) * scale;
      apply();
    }
    if (!outline.hidden) renderOutline();
  }

  function bounds(): { left: number; top: number; right: number; bottom: number } {
    return placed.reduce(
      (b, p) => ({ left: Math.min(b.left, p.x), top: Math.min(b.top, p.y), right: Math.max(b.right, p.x + p.w), bottom: Math.max(b.bottom, p.y + p.h) }),
      { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
    );
  }

  function fit(): void {
    const b = bounds();
    const w = view.clientWidth;
    const hgt = view.clientHeight;
    if (!w || !hgt || !Number.isFinite(b.left)) return;
    const margin = 40;
    scale = Math.min(1.25, (w - margin * 2) / (b.right - b.left), (hgt - margin * 2) / (b.bottom - b.top));
    if (scale < 0.45) {
      // A large map would be unreadably small: start at a readable size on the central topic.
      scale = 0.75;
      centerOn(sheet.root);
      return;
    }
    x = (w - (b.right + b.left) * scale) / 2;
    y = (hgt - (b.bottom + b.top) * scale) / 2;
    apply();
  }

  function centerOn(topic: MindTopic): void {
    const p = byTopic.get(topic);
    if (!p) return;
    x = view.clientWidth / 2 - (p.x + p.w / 2) * scale;
    y = view.clientHeight / 2 - (p.y + p.h / 2) * scale;
    apply();
  }

  function zoomAt(factor: number, cx = view.clientWidth / 2, cy = view.clientHeight / 2): void {
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * factor));
    x = cx - ((cx - x) * next) / scale;
    y = cy - ((cy - y) * next) / scale;
    scale = next;
    apply();
  }

  function pathTo(topic: MindTopic): MindTopic[] {
    const path: MindTopic[] = [];
    for (let t: MindTopic | null | undefined = topic; t; t = parents.get(t)) path.unshift(t);
    return path;
  }

  function select(topic: MindTopic | null): void {
    selected = topic;
    for (const [t, el] of elements) el.classList.toggle('selected', t === topic);
    outline.querySelectorAll('.mm-outline-title').forEach((el) => el.classList.toggle('selected', (el as HTMLElement).dataset.key === keyOf(topic)));
    if (!topic) {
      details.hidden = true;
      return;
    }
    const body: Node[] = [];
    const path = pathTo(topic);
    if (path.length > 1) body.push(h('p', { class: 'mm-path' }, path.slice(0, -1).map((t) => t.title || '…').join(' › ')));
    if (topic.image) body.push(h('img', { class: 'mm-details-img', src: topic.image, alt: '' }));
    if (topic.notes) body.push(h('div', { class: 'mm-notes' }, topic.notes));
    if (topic.link) {
      const target = internalTarget(topic.link);
      const linked = target ? allTopics(sheet).find((t) => t.topic.id === target)?.topic : undefined;
      body.push(
        h(
          'p',
          { class: 'mm-link' },
          icon('link', 14),
          openable(topic.link)
            ? h('a', { href: topic.link, target: '_blank', rel: 'noopener noreferrer' }, topic.link, icon('external', 12))
            : linked
              ? h('button', { type: 'button', class: 'text-link', onclick: () => reveal(linked) }, `Go to “${linked.title}”`)
              : h('span', {}, topic.link),
        ),
      );
    }
    if (topic.labels?.length) body.push(h('p', { class: 'mm-chips' }, ...topic.labels.map((l) => h('span', { class: 'mm-label' }, l))));
    if (topic.markers?.length) {
      body.push(h('ul', { class: 'mm-marker-list' }, ...topic.markers.map((m) => h('li', {}, h('span', { class: 'mm-mark', style: `--mm-color: ${color(m.color)}` }, m.text), m.title))));
    }
    if (topic.attributes?.length) body.push(h('dl', {}, ...topic.attributes.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])));
    const count = descendants(topic);
    if (count) body.push(h('p', { class: 'mm-path' }, `${count.toLocaleString('en-US')} topic${count === 1 ? '' : 's'} below`));
    if (body.length === 0) body.push(h('p', { class: 'mm-path' }, 'No notes, links or other details.'));
    details.replaceChildren(
      h('div', { class: 'mm-details-hd' }, h('b', {}, topic.title || 'Untitled topic'), h('button', { type: 'button', class: 'hb', title: 'Close', 'aria-label': 'Close details', onclick: () => select(null) }, icon('close', 13, 2))),
      h('div', { class: 'mm-details-body' }, ...body),
    );
    details.hidden = false;
    // Move the map so the panel does not cover the topic: left of a side panel, above a bottom sheet.
    const el = elements.get(topic);
    if (el?.isConnected && outline.hidden) {
      const node = el.getBoundingClientRect();
      const panel = details.getBoundingClientRect();
      const area = view.getBoundingClientRect();
      if (node.right > panel.left - 12 && node.left < panel.right && node.bottom > panel.top && node.top < panel.bottom) {
        if (panel.top > area.top + 40) y -= node.bottom - panel.top + 24;
        else x -= node.right - panel.left + 24;
        apply();
      }
    }
  }

  /** Unfolds the way to a topic, selects it and brings it into view. */
  function reveal(topic: MindTopic): void {
    for (const t of pathTo(topic).slice(0, -1)) folded.delete(t);
    render();
    if (!outline.hidden) renderOutline();
    select(topic);
    centerOn(topic);
  }

  // ---- Outline -------------------------------------------------------------------------------------------------

  const keys = new WeakMap<MindTopic, string>();
  let nextKey = 0;
  const keyOf = (topic: MindTopic | null) => {
    if (!topic) return '';
    let key = keys.get(topic);
    if (!key) keys.set(topic, (key = String(nextKey++)));
    return key;
  };

  function renderOutline(): void {
    const item = (topic: MindTopic): HTMLElement => {
      const title = h('button', { type: 'button', class: `mm-outline-title${topic === selected ? ' selected' : ''}`, 'data-key': keyOf(topic), onclick: () => select(topic) }, topic.title || 'Untitled topic');
      const marks = (topic.markers ?? []).filter((m) => m.text).map((m) => h('span', { class: 'mm-mark', title: m.title, style: `--mm-color: ${color(m.color)}` }, m.text));
      const line = h('span', { class: 'mm-outline-line' }, ...marks, title, topic.notes ? h('span', { class: 'mm-has', title: 'Has notes' }, icon('text', 12)) : null);
      if (!topic.children.length) return h('li', {}, line);
      const box = h('details', { open: !folded.has(topic) }, h('summary', {}, line), h('ul', {}, ...topic.children.map(item)));
      box.addEventListener('toggle', () => {
        if (box.open === folded.has(topic)) {
          if (box.open) folded.delete(topic);
          else folded.add(topic);
          render();
        }
      });
      return h('li', {}, box);
    };
    outline.replaceChildren(h('ul', { class: 'mm-outline-tree' }, item(sheet.root), ...sheet.floating.map(item)));
  }

  // ---- Pan and zoom --------------------------------------------------------------------------------------------

  let moved = false;
  const pointers = new Map<number, { x: number; y: number }>();
  let drag: { x: number; y: number; startX: number; startY: number } | null = null;
  let pinch = 0;
  const pinchState = () => {
    const [p, q] = [...pointers.values()];
    const rect = view.getBoundingClientRect();
    return { distance: Math.hypot(p.x - q.x, p.y - q.y), cx: (p.x + q.x) / 2 - rect.left, cy: (p.y + q.y) / 2 - rect.top };
  };
  view.addEventListener(
    'wheel',
    (e) => {
      if (!outline.hidden || details.contains(e.target as Node)) return;
      e.preventDefault();
      const rect = view.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - rect.left, e.clientY - rect.top);
    },
    { passive: false },
  );
  view.addEventListener('pointerdown', (e) => {
    if (!outline.hidden || details.contains(e.target as Node) || (e.target as Element).closest('.mm-fold')) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pointers.size === 2) {
      drag = null;
      pinch = pinchState().distance;
      return;
    }
    drag = { x, y, startX: e.clientX, startY: e.clientY };
  });
  view.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2 && pinch) {
      const now = pinchState();
      zoomAt(now.distance / pinch, now.cx, now.cy);
      pinch = now.distance;
      moved = true;
      return;
    }
    if (!drag) return;
    const [dx, dy] = [e.clientX - drag.startX, e.clientY - drag.startY];
    if (!moved && Math.hypot(dx, dy) < 4) return;
    if (!moved) {
      moved = true;
      view.setPointerCapture(e.pointerId);
      view.classList.add('dragging');
    }
    x = drag.x + dx;
    y = drag.y + dy;
    apply();
  });
  const end = (e: PointerEvent) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = 0;
    drag = null;
    view.classList.remove('dragging');
  };
  view.addEventListener('pointerup', end);
  view.addEventListener('pointercancel', end);
  view.addEventListener('click', (e) => {
    // A click on the empty map closes the details; a drag does not.
    if (!moved && outline.hidden && !details.contains(e.target as Node)) select(null);
  });

  // ---- Toolbar -------------------------------------------------------------------------------------------------

  const outlineButton = h('button', { type: 'button', class: 'btn sm', title: 'Show the topics as an indented list', onclick: () => setOutline(outline.hidden !== false) }, icon('toc', 14), 'Outline');
  setPressed(outlineButton, false);
  const mapControls = h(
    'span',
    { class: 'mm-controls' },
    toolButton('−', 'Zoom out', () => zoomAt(1 / 1.25)),
    zoomLabel,
    toolButton('+', 'Zoom in', () => zoomAt(1.25)),
    toolButton('Fit', 'Fit to window', fit),
  );
  function setOutline(on: boolean): void {
    outline.hidden = !on;
    stage.hidden = on;
    mapControls.hidden = on;
    setPressed(outlineButton, on);
    if (on) renderOutline();
  }
  const setAllFolded = (fold: boolean) => {
    folded.clear();
    if (fold) for (const { topic, depth } of allTopics(sheet)) if (depth >= 1 && topic.children.length) folded.add(topic);
    render();
    fit();
    if (!outline.hidden) renderOutline();
  };
  const topicsLabel = h('span', { class: 'meta' });
  const showSheet = (index: number) => {
    sheet = map.sheets[index];
    for (const el of elements.values()) el.remove();
    elements.clear();
    sizes.clear();
    select(null);
    initialFolds();
    const total = countTopics(sheet.root) + sheet.floating.reduce((n, f) => n + countTopics(f), 0);
    topicsLabel.textContent = `${map.format} · ${total.toLocaleString('en-US')} topic${total === 1 ? '' : 's'}`;
    render();
    fit();
    if (!outline.hidden) renderOutline();
  };
  if (map.sheets.length > 1) {
    toolbar.append(
      h(
        'select',
        { title: 'Sheet', onchange: (e: Event) => showSheet(Number((e.target as HTMLSelectElement).value)) },
        ...map.sheets.map((s, i) => h('option', { value: String(i) }, s.title)),
      ),
    );
  }
  toolbar.append(
    topicsLabel,
    toolButton('Expand all', 'Unfold every topic', () => setAllFolded(false)),
    toolButton('Collapse all', 'Fold everything below the main topics', () => setAllFolded(true)),
    mapControls,
    outlineButton,
  );

  const resize = new ResizeObserver(() => {
    if (!view.clientWidth) return;
    resize.disconnect();
    fit();
  });
  showSheet(0);
  resize.observe(view);
  const onKey = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && !details.hidden && view.isConnected) select(null);
  };
  document.addEventListener('keydown', onKey);

  return {
    destroy: () => {
      document.removeEventListener('keydown', onKey);
      resize.disconnect();
      for (const url of map.urls) URL.revokeObjectURL(url);
    },
  };
}
