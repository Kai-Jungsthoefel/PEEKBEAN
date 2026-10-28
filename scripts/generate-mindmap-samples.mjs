// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the mind map samples in samples/mindmaps/, all on the same made-up product launch:
// - launch-plan.xmind: XMind 2020+ (content.json, two sheets, markers, labels, notes, a link, a picture, a folded
//   branch, a relationship, a floating topic, a summary), with manifest.json, metadata.json and a thumbnail;
// - launch-plan-xmind8.xmind: XMind 8 (content.xml with the same features);
// - launch-plan.mmap: MindManager, written after the structure of MindManager's Document.xml (ap: elements) and
//   not checked in MindManager itself;
// - launch-plan.mm: FreeMind 1.0.1 (sides, folding, link, icons, a note, an arrow link);
// - launch-plan-freeplane.mm: Freeplane (HTML node text, details, attributes).
// Everything is written from scratch, so the output can be published as CC0-1.0.
// Usage: node scripts/generate-mindmap-samples.mjs [file ...]. With file names (relative to samples/), only those are written.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';

const ROOT = path.resolve(import.meta.dirname, '..', 'samples');
const written = [];
const only = process.argv.slice(2).map((rel) => rel.replace(/\\/g, '/').replace(/^samples\//, ''));

function write(rel, data) {
  if (only.length && !only.includes(rel)) return;
  const file = path.join(ROOT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  written.push([rel, Buffer.byteLength(data)]);
}

function png(w, h, draw) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set(draw(x, y), y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])));
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A rocket-ish badge: an orange disk with a white triangle, transparent around. */
const badge = png(96, 96, (x, y) => {
  const dx = x - 48;
  const dy = y - 48;
  if (dx * dx + dy * dy > 46 * 46) return [0, 0, 0, 0];
  const inTriangle = y > 24 && y < 72 && Math.abs(dx) < (y - 24) * 0.45;
  return inTriangle ? [255, 255, 255, 255] : [242, 140, 40, 255];
});
const thumbnail = png(160, 100, (x, y) => (Math.abs(y - 50) < 2 || Math.abs(x - 80) < 2 ? [120, 130, 140, 255] : [250, 250, 250, 255]));

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  const date = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name, data] of entries) {
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
    const body = deflateRawSync(bytes);
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc32(bytes), 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(bytes.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc32(bytes), 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(bytes.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const xml = (text) => String(text).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[c]);

// The map, format-neutral: [title, options, children].
const PLAN = {
  title: 'Product launch',
  children: [
    {
      title: 'Research',
      markers: ['priority-1'],
      children: [
        { title: 'Customer interviews', markers: ['task-done'], notes: 'Twelve interviews, summary in the shared folder.\nMain wish: easier setup.' },
        { title: 'Competitor review', markers: ['task-half'], labels: ['market'] },
        { title: 'Pricing survey', id: 'pricing' },
      ],
    },
    {
      title: 'Product',
      children: [
        { title: 'Feature freeze', labels: ['milestone'], markers: ['flag-red'] },
        { title: 'Beta test', children: [{ title: 'Recruit testers' }, { title: 'Collect feedback' }, { title: 'Fix top issues' }], folded: true },
        { title: 'Release notes', link: 'https://example.com/release-notes' },
      ],
    },
    {
      title: 'Marketing',
      image: true,
      children: [
        { title: 'Website', markers: ['star-orange'] },
        { title: 'Press kit', id: 'press' },
        { title: 'Launch event', notes: 'Venue booked for 120 guests.', markers: ['priority-2'] },
      ],
    },
    {
      title: 'Sales',
      children: [{ title: 'Partner training' }, { title: 'Price list', id: 'prices' }],
    },
  ],
};
const RELATION = { from: 'pricing', to: 'prices', title: 'feeds into' };

let counter = 0;
const ids = new Map();
const idOf = (topic) => {
  if (!ids.has(topic)) ids.set(topic, topic.id ?? `t${(++counter).toString(36).padStart(4, '0')}`);
  return ids.get(topic);
};

// ---- XMind (content.json) -----------------------------------------------------------------------------------------

function xmindJson(topic, root = false) {
  const out = { id: idOf(topic), class: 'topic', title: topic.title };
  if (root) out.structureClass = 'org.xmind.ui.map.clockwise';
  if (topic.notes) out.notes = { plain: { content: topic.notes } };
  if (topic.labels) out.labels = topic.labels;
  if (topic.markers) out.markers = topic.markers.map((markerId) => ({ markerId }));
  if (topic.link) out.href = topic.link;
  if (topic.folded) out.branch = 'folded';
  if (topic.image) out.image = { src: 'xap:resources/badge.png' };
  if (topic.children) out.children = { attached: topic.children.map((c) => xmindJson(c)) };
  return out;
}

{
  const root = xmindJson(PLAN, true);
  // A summary over the first two research topics, and a floating topic.
  const research = root.children.attached[0];
  research.summaries = [{ id: 'sum1', range: '(0,1)', topicId: 'sum1-topic' }];
  research.children.summary = [{ id: 'sum1-topic', class: 'topic', title: 'Insights by week 6' }];
  root.children.detached = [{ id: 'floating', class: 'topic', title: 'Open questions', position: { x: 0, y: 260 }, children: { attached: [{ id: 'q1', class: 'topic', title: 'Which regions first?' }] } }];
  const sheets = [
    { id: 'sheet1', class: 'sheet', title: 'Plan', rootTopic: root, relationships: [{ id: 'rel1', end1Id: RELATION.from, end2Id: RELATION.to, title: RELATION.title }] },
    {
      id: 'sheet2',
      class: 'sheet',
      title: 'Timeline',
      rootTopic: {
        id: 'tl',
        class: 'topic',
        title: 'Timeline',
        structureClass: 'org.xmind.ui.logic.right',
        children: { attached: ['March: research', 'April: beta', 'May: launch'].map((title, i) => ({ id: `tl${i}`, class: 'topic', title })) },
      },
    },
  ];
  write(
    'mindmaps/launch-plan.xmind',
    zip([
      ['content.json', JSON.stringify(sheets)],
      ['metadata.json', JSON.stringify({ dataStructureVersion: '2', creator: { name: 'Peekbean sample generator', version: '1.0' } })],
      ['manifest.json', JSON.stringify({ 'file-entries': { 'content.json': {}, 'metadata.json': {}, 'resources/badge.png': {}, 'Thumbnails/thumbnail.png': {} } })],
      ['resources/badge.png', badge],
      ['Thumbnails/thumbnail.png', thumbnail],
    ]),
  );
}

// ---- XMind 8 (content.xml) ----------------------------------------------------------------------------------------

function xmindXml(topic, root = false) {
  const attrs = [`id="${idOf(topic)}"`];
  if (root) attrs.push('structure-class="org.xmind.ui.map.clockwise"');
  if (topic.folded) attrs.push('branch="folded"');
  if (topic.link) attrs.push(`xlink:href="${xml(topic.link)}"`);
  const parts = [`<title>${xml(topic.title)}</title>`];
  if (topic.image) parts.push('<xhtml:img xhtml:src="xap:attachments/badge.png" svg:width="48" svg:height="48"/>');
  if (topic.markers) parts.push(`<marker-refs>${topic.markers.map((m) => `<marker-ref marker-id="${m}"/>`).join('')}</marker-refs>`);
  if (topic.labels) parts.push(`<labels>${topic.labels.map((l) => `<label>${xml(l)}</label>`).join('')}</labels>`);
  if (topic.notes) parts.push(`<notes><plain>${xml(topic.notes)}</plain></notes>`);
  if (topic.children) parts.push(`<children><topics type="attached">${topic.children.map((c) => xmindXml(c)).join('')}</topics></children>`);
  return `<topic ${attrs.join(' ')}>${parts.join('')}</topic>`;
}

write(
  'mindmaps/launch-plan-xmind8.xmind',
  zip([
    [
      'content.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="no"?><xmap-content xmlns="urn:xmind:xmap:xmlns:content:2.0" xmlns:fo="http://www.w3.org/1999/XSL/Format" xmlns:svg="http://www.w3.org/2000/svg" xmlns:xhtml="http://www.w3.org/1999/xhtml" xmlns:xlink="http://www.w3.org/1999/xlink" version="2.0"><sheet id="s1">${xmindXml(PLAN, true)}<title>Plan</title><relationships><relationship id="r1" end1="${RELATION.from}" end2="${RELATION.to}"><title>${RELATION.title}</title></relationship></relationships></sheet></xmap-content>`,
    ],
    ['meta.xml', '<?xml version="1.0" encoding="UTF-8" standalone="no"?><meta xmlns="urn:xmind:xmap:xmlns:meta:2.0" version="2.0"><Creator><Name>Peekbean sample generator</Name></Creator></meta>'],
    ['META-INF/manifest.xml', '<?xml version="1.0" encoding="UTF-8" standalone="no"?><manifest xmlns="urn:xmind:xmap:xmlns:manifest:1.0"><file-entry full-path="content.xml" media-type="text/xml"/><file-entry full-path="attachments/badge.png" media-type="image/png"/></manifest>'],
    ['attachments/badge.png', badge],
    ['Thumbnails/thumbnail.png', thumbnail],
  ]),
);

// ---- MindManager (Document.xml) -----------------------------------------------------------------------------------

const MM_ICONS = { 'priority-1': 'urn:mindjet:Prio1', 'priority-2': 'urn:mindjet:Prio2', 'flag-red': 'urn:mindjet:FlagRed', 'star-orange': 'urn:mindjet:StarOrange' };
const MM_PROGRESS = { 'task-done': '100', 'task-half': '50' };

function mindManagerTopic(topic) {
  const parts = [];
  if (topic.children) parts.push(`<ap:SubTopics>${topic.children.map(mindManagerTopic).join('')}</ap:SubTopics>`);
  if (topic.folded) parts.push('<ap:TopicViewGroup ViewIndex="0"><ap:Collapsed Collapsed="true"/></ap:TopicViewGroup>');
  const icons = (topic.markers ?? []).filter((m) => MM_ICONS[m]);
  if (icons.length) parts.push(`<ap:IconsGroup><ap:Icons>${icons.map((m) => `<ap:Icon xsi:type="ap:StockIcon" IconType="${MM_ICONS[m]}"/>`).join('')}</ap:Icons></ap:IconsGroup>`);
  const progress = (topic.markers ?? []).map((m) => MM_PROGRESS[m]).find(Boolean);
  if (progress) parts.push(`<ap:Task TaskPercentage="${progress}"${progress === '100' ? '' : ' DeadlineDate="2026-04-30T00:00:00"'}/>`);
  if (topic.link) parts.push(`<ap:Hyperlink Url="${xml(topic.link)}"/>`);
  if (topic.labels) parts.push(`<ap:TextLabels>${topic.labels.map((l) => `<ap:TextLabel TextLabelName="${xml(l)}"/>`).join('')}</ap:TextLabels>`);
  if (topic.image) parts.push('<ap:Image><ap:ImageData ImageType="png"><cor:Uri>mmarch://bin/badge.png</cor:Uri></ap:ImageData></ap:Image>');
  if (topic.notes) parts.push(`<ap:NotesGroup><ap:NotesXhtmlData PreviewPlainText="${xml(topic.notes)}"><xhtml:html xmlns:xhtml="http://www.w3.org/1999/xhtml"><xhtml:p>${xml(topic.notes)}</xhtml:p></xhtml:html></ap:NotesXhtmlData></ap:NotesGroup>`);
  parts.push(`<ap:Text PlainText="${xml(topic.title)}"><ap:Font/></ap:Text>`);
  return `<ap:Topic OId="${idOf(topic)}">${parts.join('')}</ap:Topic>`;
}

{
  const root = mindManagerTopic(PLAN).replace(
    '<ap:Text PlainText="Product launch">',
    '<ap:FloatingTopics><ap:Topic OId="floating"><ap:Text PlainText="Open questions"><ap:Font/></ap:Text></ap:Topic></ap:FloatingTopics><ap:Text PlainText="Product launch">',
  );
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<ap:Map xmlns:ap="http://schemas.mindjet.com/MindManager/Application/2003" xmlns:cor="http://schemas.mindjet.com/MindManager/Core/2003" xmlns:pri="http://schemas.mindjet.com/MindManager/Primitive/2003" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" OId="map"><ap:OneTopic>${root}</ap:OneTopic><ap:Relationships><ap:Relationship OId="rel"><ap:ConnectionGroup Index="0"><ap:Connection><ap:ObjectReference OIdRef="${RELATION.from}"/></ap:Connection></ap:ConnectionGroup><ap:ConnectionGroup Index="1"><ap:Connection><ap:ObjectReference OIdRef="${RELATION.to}"/></ap:Connection></ap:ConnectionGroup></ap:Relationship></ap:Relationships></ap:Map>
`;
  write('mindmaps/launch-plan.mmap', zip([['Document.xml', document], ['bin/badge.png', badge], ['Preview.png', thumbnail]]));
}

// ---- FreeMind and Freeplane ---------------------------------------------------------------------------------------

const FM_ICONS = { 'priority-1': 'full-1', 'priority-2': 'full-2', 'task-done': 'button_ok', 'flag-red': 'flag', 'star-orange': 'bookmark' };

function freemindNode(topic, depth, index, freeplane) {
  const attrs = [`ID="${idOf(topic)}"`];
  if (!(freeplane && topic.html)) attrs.push(`TEXT="${xml(topic.title)}"`);
  if (depth === 1) attrs.push(`POSITION="${index < 2 ? 'right' : 'left'}"`);
  if (topic.folded) attrs.push('FOLDED="true"');
  if (topic.link) attrs.push(`LINK="${xml(topic.link)}"`);
  const parts = [];
  if (freeplane && topic.html) parts.push(`<richcontent TYPE="NODE"><html><head/><body><p><b>${xml(topic.title)}</b></p></body></html></richcontent>`);
  for (const m of topic.markers ?? []) if (FM_ICONS[m]) parts.push(`<icon BUILTIN="${FM_ICONS[m]}"/>`);
  if (topic.notes) parts.push(`<richcontent TYPE="NOTE"><html><head/><body>${topic.notes.split('\n').map((l) => `<p>${xml(l)}</p>`).join('')}</body></html></richcontent>`);
  if (freeplane && topic.details) parts.push(`<richcontent TYPE="DETAILS"><html><head/><body><p>${xml(topic.details)}</p></body></html></richcontent>`);
  if (freeplane) for (const [k, v] of topic.attributes ?? []) parts.push(`<attribute NAME="${xml(k)}" VALUE="${xml(v)}"/>`);
  if (idOf(topic) === RELATION.from) parts.push(`<arrowlink DESTINATION="${RELATION.to}" MIDDLE_LABEL="${RELATION.title}"/>`);
  for (const [i, c] of (topic.children ?? []).entries()) parts.push(freemindNode(c, depth + 1, i, freeplane));
  return `<node ${attrs.join(' ')}>${parts.join('')}</node>`;
}

write(
  'mindmaps/launch-plan.mm',
  `<map version="1.0.1">\n<!-- To view this file, download free mind mapping software FreeMind from http://freemind.sourceforge.net -->\n${freemindNode(PLAN, 0, 0, false)}\n</map>\n`,
);

{
  const plan = structuredClone(PLAN);
  plan.children[1].html = true;
  plan.children[1].details = 'Owner: product team';
  plan.children[3].attributes = [
    ['Owner', 'Sales lead'],
    ['Budget', '12,000'],
  ];
  ids.clear();
  counter = 0;
  write('mindmaps/launch-plan-freeplane.mm', `<map version="freeplane 1.11.1">\n<!--To view this file, download free mind mapping software Freeplane from https://www.freeplane.org -->\n${freemindNode(plan, 0, 0, true)}\n</map>\n`);
}

for (const [rel, size] of written) console.log(`${rel.padEnd(40)} ${size.toLocaleString('en-US')} bytes`);
