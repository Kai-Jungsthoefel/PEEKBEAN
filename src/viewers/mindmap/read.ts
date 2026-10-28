// SPDX-License-Identifier: GPL-3.0-or-later
// Readers for mind map files, all into one model:
// - XMind 2020 and later: a ZIP with content.json (sheets with a rootTopic tree), resources/ for pictures;
// - XMind 8: the same ZIP layout with content.xml (xmap-content), attachments/ for pictures;
// - MindManager: a ZIP with Document.xml (ap:Map, ap:OneTopic, nested ap:Topic/ap:SubTopics), pictures in bin/;
//   .xmmap is the same XML unzipped;
// - FreeMind and Freeplane: plain XML (<map><node TEXT=…>), notes and details as HTML.
// Notes and other rich text are read as plain text only, so nothing from the file is rendered as HTML.
import { BlobReader, TextWriter, Uint8ArrayWriter, ZipReader, configure, type Entry, type FileEntry } from '@zip.js/zip.js';
import { colorIndex, type MindMap, type MindMarker, type MindSheet, type MindTopic } from './model';

configure({ useWebWorkers: false, useCompressionStream: true });

const XLINK = 'http://www.w3.org/1999/xlink';
const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml' };

const kids = (el: Element | null | undefined, name: string): Element[] => (el ? [...el.children].filter((c) => c.localName === name) : []);
const kid = (el: Element | null | undefined, name: string): Element | undefined => kids(el, name)[0];

function parseXml(text: string): Document {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('The mind map XML is damaged.');
  return doc;
}

/** Text of HTML notes with line breaks for blocks, as a plain string. */
function htmlText(el: Element | undefined): string {
  if (!el) return '';
  const blocks = new Set(['p', 'div', 'li', 'br', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'blockquote']);
  let out = '';
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) out += (node.textContent ?? '').replace(/\s+/g, ' ');
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const name = (node as Element).localName.toLowerCase();
      if (name === 'head' || name === 'style' || name === 'script') return;
      if (name === 'li') out += '\n• ';
      node.childNodes.forEach(walk);
      if (blocks.has(name)) out += '\n';
    }
  };
  walk(el);
  return out.replace(/[ \t]*\n[ \t]*/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---- XMind ---------------------------------------------------------------------------------------------------

const TASK_PROGRESS: Record<string, string> = {
  'task-start': '0%', 'task-oct': '12%', 'task-quarter': '25%', 'task-3oct': '37%', 'task-half': '50%', 'task-5oct': '62%',
  'task-3quar': '75%', 'task-7oct': '87%', 'task-done': '100%',
};

function xmindMarker(id: string): MindMarker {
  const priority = /^priority-(\d+)$/.exec(id);
  if (priority) return { text: priority[1], title: `Priority ${priority[1]}`, color: 1 };
  const progress = TASK_PROGRESS[id];
  if (progress) return { text: progress === '100%' ? '✓' : progress, title: `Task ${progress} done`, color: 2 };
  return { text: '', title: id.replace(/-/g, ' '), color: colorIndex(id) };
}

/** Sides of the first-level topics: XMind's balanced maps put the first half right, clockwise. */
function sheetLayout(structure: string): MindSheet['layout'] {
  if (/logic\.left|tree\.left/.test(structure)) return 'left';
  return /\.map(\.|$)/.test(structure) || !structure ? 'map' : 'right';
}

interface Archive {
  entries: Entry[];
  urls: string[];
}

async function entryText(archive: Archive, name: string): Promise<string | null> {
  const entry = archive.entries.find((e) => e.filename === name && !e.directory) as FileEntry | undefined;
  return entry ? entry.getData(new TextWriter()) : null;
}

/** An object URL for a picture inside the archive ("xap:resources/…", "mmarch://bin/…"). */
async function picture(archive: Archive, path: string | null | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  const name = path.replace(/^xap:/, '').replace(/^mmarch:\/\//, '').replace(/^\/+/, '');
  const entry = archive.entries.find((e) => e.filename === name && !e.directory) as FileEntry | undefined;
  const type = MIME[name.split('.').pop()?.toLowerCase() ?? ''];
  if (!entry || !type) return undefined;
  const bytes = await entry.getData(new Uint8ArrayWriter());
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type }));
  archive.urls.push(url);
  return url;
}

interface XmindJsonTopic {
  id?: string;
  title?: string;
  structureClass?: string;
  branch?: string;
  href?: string;
  labels?: string[];
  markers?: { markerId?: string }[];
  notes?: { plain?: { content?: string } };
  image?: { src?: string };
  position?: { x: number; y: number };
  summaries?: { range?: string; topicId?: string }[];
  extensions?: { provider?: string; content?: { name?: string; content?: string }[] }[];
  children?: { attached?: XmindJsonTopic[]; detached?: XmindJsonTopic[]; summary?: XmindJsonTopic[] };
}

async function xmindJsonTopic(t: XmindJsonTopic, archive: Archive): Promise<MindTopic> {
  const attached = await Promise.all((t.children?.attached ?? []).map((c) => xmindJsonTopic(c, archive)));
  // Summary topics stand next to the range of siblings they sum up.
  const summaries = await Promise.all(
    (t.children?.summary ?? []).map(async (s) => {
      const topic = await xmindJsonTopic(s, archive);
      const range = /\((\d+),(\d+)\)/.exec(t.summaries?.find((x) => x.topicId === s.id)?.range ?? '');
      const covered = range ? attached.slice(Number(range[1]), Number(range[2]) + 1).map((c) => c.title).join(', ') : '';
      return { ...topic, summary: true, attributes: covered ? [['Sums up', covered] as [string, string]] : undefined };
    }),
  );
  return {
    id: t.id ?? '',
    title: t.title ?? '',
    children: [...attached, ...summaries],
    folded: t.branch === 'folded',
    notes: t.notes?.plain?.content?.trim() || undefined,
    link: t.href,
    labels: t.labels,
    markers: t.markers?.map((m) => xmindMarker(m.markerId ?? '')),
    image: await picture(archive, t.image?.src),
    position: t.position,
  };
}

async function readXmindJson(json: string, archive: Archive): Promise<MindSheet[]> {
  const sheets = JSON.parse(json) as { title?: string; rootTopic: XmindJsonTopic; relationships?: { end1Id: string; end2Id: string; title?: string }[] }[];
  return Promise.all(
    sheets.map(async (sheet, i) => {
      const root = await xmindJsonTopic(sheet.rootTopic, archive);
      // Unbalanced maps store how many first-level topics sit on the right.
      const right = Number(sheet.rootTopic.extensions?.find((e) => e.provider === 'org.xmind.ui.map.unbalanced')?.content?.find((c) => c.name === 'right-number')?.content);
      if (Number.isFinite(right)) root.children.forEach((c, k) => (c.side = k < right ? 'right' : 'left'));
      return {
        title: sheet.title || `Sheet ${i + 1}`,
        root,
        floating: await Promise.all((sheet.rootTopic.children?.detached ?? []).map((t) => xmindJsonTopic(t, archive))),
        relationships: (sheet.relationships ?? []).map((r) => ({ from: r.end1Id, to: r.end2Id, title: r.title })),
        layout: sheetLayout(sheet.rootTopic.structureClass ?? ''),
      };
    }),
  );
}

async function xmindXmlTopic(el: Element, archive: Archive): Promise<MindTopic> {
  const groups = kids(kid(el, 'children'), 'topics');
  const of = (type: string) => groups.filter((g) => (g.getAttribute('type') ?? 'attached') === type).flatMap((g) => kids(g, 'topic'));
  const attached = await Promise.all(of('attached').map((c) => xmindXmlTopic(c, archive)));
  const summaries = await Promise.all(of('summary').map(async (c) => ({ ...(await xmindXmlTopic(c, archive)), summary: true })));
  const image = [...el.children].find((c) => c.localName === 'img');
  return {
    id: el.getAttribute('id') ?? '',
    title: kid(el, 'title')?.textContent ?? '',
    children: [...attached, ...summaries],
    folded: el.getAttribute('branch') === 'folded',
    notes: kid(kid(el, 'notes'), 'plain')?.textContent?.trim() || undefined,
    link: el.getAttributeNS(XLINK, 'href') ?? el.getAttribute('xlink:href') ?? undefined,
    labels: kids(kid(el, 'labels'), 'label').map((l) => l.textContent ?? ''),
    markers: kids(kid(el, 'marker-refs'), 'marker-ref').map((m) => xmindMarker(m.getAttribute('marker-id') ?? '')),
    image: await picture(archive, image?.getAttributeNS('http://www.w3.org/1999/xhtml', 'src') ?? image?.getAttribute('xhtml:src') ?? image?.getAttribute('src')),
    position: (() => {
      const p = kid(el, 'position');
      const x = Number(p?.getAttributeNS('http://www.w3.org/2000/svg', 'x') ?? p?.getAttribute('svg:x'));
      const y = Number(p?.getAttributeNS('http://www.w3.org/2000/svg', 'y') ?? p?.getAttribute('svg:y'));
      return p && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
    })(),
  };
}

async function readXmindXml(xml: string, archive: Archive): Promise<MindSheet[]> {
  const doc = parseXml(xml);
  return Promise.all(
    kids(doc.documentElement, 'sheet').map(async (sheet, i) => {
      const rootEl = kid(sheet, 'topic');
      if (!rootEl) throw new Error('A sheet of the XMind file has no central topic.');
      const root = await xmindXmlTopic(rootEl, archive);
      const detached = kids(kid(rootEl, 'children'), 'topics').filter((g) => g.getAttribute('type') === 'detached').flatMap((g) => kids(g, 'topic'));
      root.children = root.children.filter((c) => !detached.some((d) => d.getAttribute('id') === c.id));
      return {
        title: kid(sheet, 'title')?.textContent || `Sheet ${i + 1}`,
        root,
        floating: await Promise.all(detached.map((d) => xmindXmlTopic(d, archive))),
        relationships: kids(kid(sheet, 'relationships'), 'relationship').map((r) => ({
          from: r.getAttribute('end1') ?? '',
          to: r.getAttribute('end2') ?? '',
          title: kid(r, 'title')?.textContent ?? undefined,
        })),
        layout: sheetLayout(rootEl.getAttribute('structure-class') ?? ''),
      };
    }),
  );
}

// ---- MindManager -----------------------------------------------------------------------------------------------

/** "urn:mindjet:SmileyHappy" → "Smiley happy"; priorities and task progress get a badge. */
function mindManagerIcon(type: string): MindMarker {
  const priority = /Prio(\d)$/.exec(type);
  if (priority) return { text: priority[1], title: `Priority ${priority[1]}`, color: 1 };
  const name = type.replace(/^.*:/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  return { text: '', title: name.charAt(0) + name.slice(1).toLowerCase(), color: colorIndex(name) };
}

async function mindManagerTopic(el: Element, archive: Archive): Promise<MindTopic> {
  const task = kid(el, 'Task');
  const markers: MindMarker[] = kids(kid(kid(el, 'IconsGroup'), 'Icons'), 'Icon').map((i) => mindManagerIcon(i.getAttribute('IconType') ?? ''));
  const attributes: [string, string][] = [];
  if (task) {
    const percent = task.getAttribute('TaskPercentage');
    if (percent) markers.push({ text: percent === '100' ? '✓' : `${percent}%`, title: `Task ${percent}% done`, color: 2 });
    const priority = /Prio(\d)$/.exec(task.getAttribute('TaskPriority') ?? '');
    if (priority) markers.push({ text: priority[1], title: `Priority ${priority[1]}`, color: 1 });
    for (const [attr, label] of [['StartDate', 'Start'], ['DeadlineDate', 'Due'], ['Resources', 'Resources'], ['DurationMinutes', 'Duration (minutes)']]) {
      const value = task.getAttribute(attr);
      if (value) attributes.push([label, /Date$/.test(attr) ? value.replace('T', ' ').replace(/:00$/, '') : value]);
    }
  }
  const notes = kid(kid(el, 'NotesGroup'), 'NotesXhtmlData');
  const imageUri = kid(kid(kid(el, 'Image'), 'ImageData'), 'Uri')?.textContent;
  return {
    id: el.getAttribute('OId') ?? '',
    title: kid(el, 'Text')?.getAttribute('PlainText') ?? '',
    children: await Promise.all(kids(kid(el, 'SubTopics'), 'Topic').map((c) => mindManagerTopic(c, archive))),
    folded: kid(kid(el, 'TopicViewGroup'), 'Collapsed')?.getAttribute('Collapsed') === 'true',
    notes: (notes?.getAttribute('PreviewPlainText') || htmlText(notes)).trim() || undefined,
    link: kid(el, 'Hyperlink')?.getAttribute('Url') ?? undefined,
    labels: kids(kid(el, 'TextLabels'), 'TextLabel').map((l) => l.getAttribute('TextLabelName') ?? '').filter(Boolean),
    markers,
    image: await picture(archive, imageUri),
    attributes: attributes.length ? attributes : undefined,
  };
}

async function readMindManager(xml: string, archive: Archive): Promise<MindSheet[]> {
  const doc = parseXml(xml);
  const rootEl = kid(doc.getElementsByTagNameNS('*', 'OneTopic')[0], 'Topic');
  if (!rootEl) throw new Error('The MindManager file has no central topic.');
  const root = await mindManagerTopic(rootEl, archive);
  const floating = await Promise.all(kids(kid(rootEl, 'FloatingTopics'), 'Topic').map((t) => mindManagerTopic(t, archive)));
  const relationships = [...doc.getElementsByTagNameNS('*', 'Relationship')].map((r) => {
    const end = (index: string) => kids(r, 'ConnectionGroup').find((g) => g.getAttribute('Index') === index)?.getElementsByTagNameNS('*', 'ObjectReference')[0]?.getAttribute('OIdRef') ?? '';
    return { from: end('0'), to: end('1') };
  });
  return [{ title: root.title || 'Map', root, floating, relationships: relationships.filter((r) => r.from && r.to), layout: 'map' }];
}

// ---- FreeMind and Freeplane ------------------------------------------------------------------------------------

const FREEMIND_ICONS: Record<string, MindMarker> = {
  button_ok: { text: '✓', title: 'Done', color: 2 },
  button_cancel: { text: '✗', title: 'Cancelled', color: 1 },
  help: { text: '?', title: 'Question', color: 0 },
  messagebox_warning: { text: '!', title: 'Warning', color: 4 },
  yes: { text: '!', title: 'Important', color: 1 },
};

function freemindIcon(name: string): MindMarker {
  const priority = /^full-(\d)$/.exec(name);
  if (priority) return { text: priority[1], title: `Priority ${priority[1]}`, color: 1 };
  return FREEMIND_ICONS[name] ?? { text: '', title: name.replace(/[_-]/g, ' '), color: colorIndex(name) };
}

function freemindNode(el: Element, relationships: MindSheet['relationships']): MindTopic {
  const rich = (type: string) => kids(el, 'richcontent').find((r) => (r.getAttribute('TYPE') ?? 'NODE') === type);
  const id = el.getAttribute('ID') ?? '';
  for (const arrow of kids(el, 'arrowlink')) {
    const to = arrow.getAttribute('DESTINATION');
    if (to) relationships.push({ from: id, to, title: arrow.getAttribute('MIDDLE_LABEL') ?? undefined });
  }
  const attributes: [string, string][] = kids(el, 'attribute').map((a) => [a.getAttribute('NAME') ?? '', a.getAttribute('VALUE') ?? '']);
  const details = htmlText(rich('DETAILS'));
  if (details) attributes.unshift(['Details', details]);
  const side = el.getAttribute('POSITION');
  return {
    id,
    title: el.getAttribute('TEXT') ?? (htmlText(rich('NODE')) || el.getAttribute('LOCALIZED_TEXT')?.replace(/^new_mindmap$/, 'New mind map') || ''),
    children: kids(el, 'node').map((c) => freemindNode(c, relationships)),
    folded: el.getAttribute('FOLDED') === 'true',
    side: side === 'left' || side === 'right' ? side : undefined,
    notes: htmlText(rich('NOTE')) || undefined,
    link: el.getAttribute('LINK') ?? undefined,
    markers: kids(el, 'icon').map((i) => freemindIcon(i.getAttribute('BUILTIN') ?? '')),
    attributes: attributes.length ? attributes : undefined,
  };
}

function readFreeMind(xml: string): MindMap {
  const doc = parseXml(xml);
  const map = doc.documentElement;
  const rootEl = kid(map, 'node');
  if (map.localName !== 'map' || !rootEl) throw new Error('This is not a FreeMind or Freeplane mind map.');
  const relationships: MindSheet['relationships'] = [];
  const root = freemindNode(rootEl, relationships);
  const version = map.getAttribute('version') ?? '';
  const freeplane = /freeplane/i.test(version);
  return {
    format: freeplane ? 'Freeplane' : 'FreeMind',
    creator: freeplane ? version.replace(/^freeplane/i, 'Freeplane') : version ? `FreeMind ${version}` : undefined,
    sheets: [{ title: root.title || 'Map', root, floating: [], relationships, layout: 'map' }],
    urls: [],
  };
}

// ---- Entry point -------------------------------------------------------------------------------------------------

export function isFreeMind(head: string): boolean {
  return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<map\s+version=/.test(head);
}

export async function readMindMap(file: File): Promise<MindMap> {
  const head = new Uint8Array(await file.slice(0, 4).arrayBuffer());
  if (head[0] !== 0x50 || head[1] !== 0x4b) {
    const text = await file.text();
    if (isFreeMind(text.slice(0, 2048).replace(/^﻿/, ''))) return readFreeMind(text);
    if (/schemas\.mindjet\.com/.test(text.slice(0, 4096))) {
      return { format: 'MindManager', sheets: await readMindManager(text, { entries: [], urls: [] }), urls: [] };
    }
    throw new Error('This is not a mind map OPSIS can read.');
  }
  const zip = new ZipReader(new BlobReader(file));
  const archive: Archive = { entries: await zip.getEntries(), urls: [] };
  try {
    const manifest = await entryText(archive, 'manifest.json');
    if (manifest && /encryption-data/.test(manifest)) throw new Error('This XMind file is protected with a password, so its content cannot be read.');
    const json = await entryText(archive, 'content.json');
    if (json) {
      const metadata = JSON.parse((await entryText(archive, 'metadata.json')) || '{}') as { creator?: { name?: string; version?: string } };
      const creator = metadata.creator?.name ? `${metadata.creator.name}${metadata.creator.version ? ` ${metadata.creator.version}` : ''}` : undefined;
      return { format: 'XMind', creator, sheets: await readXmindJson(json, archive), urls: archive.urls };
    }
    const xml = await entryText(archive, 'content.xml');
    if (xml) return { format: 'XMind 8', sheets: await readXmindXml(xml, archive), urls: archive.urls };
    const document = await entryText(archive, 'Document.xml');
    if (document) return { format: 'MindManager', sheets: await readMindManager(document, archive), urls: archive.urls };
    throw new Error('The archive holds no mind map OPSIS can read.');
  } catch (error) {
    for (const url of archive.urls) URL.revokeObjectURL(url);
    throw error;
  } finally {
    await zip.close();
  }
}

/** Properties for the info panel: format, creator, sheets and topic count. */
export async function mindMapSummary(file: File): Promise<{ label: string; value: string }[]> {
  const map = await readMindMap(file);
  for (const url of map.urls) URL.revokeObjectURL(url);
  const count = (t: MindTopic): number => 1 + t.children.reduce((n, c) => n + count(c), 0);
  const topics = map.sheets.reduce((n, s) => n + count(s.root) + s.floating.reduce((m, f) => m + count(f), 0), 0);
  return [
    { label: 'Format', value: map.format },
    { label: 'Created with', value: map.creator ?? '' },
    { label: 'Sheets', value: map.sheets.length > 1 ? map.sheets.map((s) => s.title).join(', ') : '' },
    { label: 'Topics', value: topics.toLocaleString('en-US') },
  ].filter((r) => r.value);
}
