// SPDX-License-Identifier: GPL-3.0-or-later
// SolidWorks parts, assemblies and drawings. Both container generations (OLE up to 2014, the own container since 2015)
// hold the same streams: PNG previews, XML with the configurations and the component tree, and the properties as OLE
// property sets (old) or Office-style XML (new).
import { formatDate, row, section, type MetaRow, type MetaSection } from '../../metadata/model';
import { dibToBmp, findPicture, hasSignature } from './images';
import { SUMMARY_INFORMATION, SUMMARY_LABELS, USER_DEFINED, labelledRows, namedRows, type PropertySet } from './propset';
import { elements, textOf, xmlFrom } from './xml';
import type { PreviewImage, PreviewList, PreviewNode, PreviewResult } from './types';

export interface SwSource {
  names: string[];
  read(name: string): Promise<Uint8Array | null>;
  /** OLE property sets of a stream, in files before 2015. */
  propertySets?(name: string): PropertySet[];
}

const KINDS: Record<string, string> = { sldprt: 'SolidWorks part', sldasm: 'SolidWorks assembly', slddrw: 'SolidWorks drawing' };
const ZLB_MAGIC = [0x23, 0x1d, 0xd5, 0x71, 0xda, 0x81, 0x48, 0xa2, 0xa8, 0x58, 0x98, 0xb2, 0x1b, 0x89, 0xef, 0x99];
const LIMITS = 'This is the preview picture SolidWorks saved in the file. The 3D model cannot be shown: SolidWorks files are a closed format. Save the model as STEP in SolidWorks to view it here in 3D.';

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** A stream by name; files before 2015 add "__ZLB" to compressed streams and wrap them in a small header. */
async function stream(src: SwSource, name: string): Promise<Uint8Array | null> {
  const lower = name.toLowerCase();
  const found = src.names.find((n) => n.toLowerCase() === lower || n.toLowerCase() === `${lower}__zlb`);
  const bytes = found ? await src.read(found) : null;
  if (!bytes || !hasSignature(bytes, ZLB_MAGIC) || bytes.length < 24) return bytes;
  const compressed = new DataView(bytes.buffer, bytes.byteOffset + 20, 4).getUint32(0, true);
  return inflate(bytes.subarray(24, 24 + compressed));
}

async function xml(src: SwSource, name: string): Promise<string> {
  const bytes = await stream(src, name).catch(() => null);
  return bytes ? xmlFrom(bytes) : '';
}

function baseName(path: string): string {
  return path.slice(Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/')) + 1);
}

/** User-defined properties of an Office-style properties XML (docProps/custom.xml, Config-N-Properties.xml). */
function xmlUserProperties(text: string): MetaRow[] {
  const user = elements(text, 'propertySection').find((s) => s.attrs.name === 'UserDefinedProperties');
  if (!user) return [];
  return elements(user.inner, 'property')
    .filter((p) => p.attrs.name)
    .map((p) => ({ label: p.attrs.name, value: textOf(`<v>${p.inner}</v>`, 'v') }))
    .filter((r) => r.value);
}

function isoDate(value: string): string {
  const date = new Date(value);
  return value && !Number.isNaN(date.getTime()) ? formatDate(date) : '';
}

/** The component tree of an assembly from swXmlContents/COMPINSTANCETREE, with the files it references. */
function components(text: string): { tree: PreviewNode[]; files: PreviewNode[] } {
  const files = new Map(elements(text, 'swFile').map((f) => [f.attrs.id, f.attrs]));
  const models = new Map(elements(text, 'swModel').map((m) => [m.attrs.id, { attrs: m.attrs, refs: elements(m.inner, 'swReference').map((r) => r.attrs) }]));
  const configurations = elements(text, 'swConfiguration');
  const active = configurations.find((c) => c.attrs.swMostRecentConfiguration === 'YES') ?? configurations[0];
  const rootId = active?.attrs.swModelRef ?? '';
  let count = 0;
  const build = (modelId: string, depth: number, path: Set<string>): PreviewNode[] =>
    (models.get(modelId)?.refs ?? []).map((ref) => {
      count++;
      const child = models.get(ref.swModelRef);
      const file = files.get(child?.attrs.swFileRef ?? '');
      const flags = [ref.swSuppressed === 'YES' && 'suppressed', ref.swHidden === 'YES' && 'hidden', ref.swExcludeFromBOM === 'YES' && 'excluded from BOM'].filter(Boolean);
      const configuration = ref.swConfigurationName && ref.swConfigurationName !== 'Default' ? `configuration ${ref.swConfigurationName}` : '';
      const nested = !path.has(ref.swModelRef) && depth < 24 && count < 5000 ? build(ref.swModelRef, depth + 1, new Set([...path, ref.swModelRef])) : [];
      return {
        name: `${ref.swName ?? '?'}<${ref.swReferenceNumber ?? '1'}>`,
        detail: [file ? baseName(file.swPath ?? '') : '', configuration, ...flags].filter(Boolean).join(' · '),
        muted: ref.swSuppressed === 'YES' || ref.swHidden === 'YES',
        ...(nested.length ? { children: nested } : {}),
      };
    });
  const tree = rootId ? build(rootId, 0, new Set([rootId])) : [];
  const own = models.get(rootId)?.attrs.swFileRef;
  const referenced = [...files.entries()]
    .filter(([id]) => id !== own)
    .map(([, f]) => ({ name: baseName(f.swPath ?? ''), detail: [(f.swDocType ?? '').toLowerCase(), f.swPath ?? ''].filter(Boolean).join(' · ') }));
  return { tree, files: referenced };
}

/**
 * Versions that saved the file, from the version history stream (each entry marked FF FE FF 00, then a 32-bit version
 * number). Since SolidWorks 2011 (4000) every release adds 1000: 7000 is 2014, 15000 is 2022.
 */
async function versionHistory(src: SwSource): Promise<number[]> {
  const name = src.names.find((n) => /^_MO_VERSION_\d+\/History$/i.test(n));
  const bytes = name ? await src.read(name) : null;
  if (!bytes) return [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versions: number[] = [];
  for (let i = 0; i + 8 <= bytes.length; i++) {
    if (bytes[i] !== 0xff || bytes[i + 1] !== 0xfe || bytes[i + 2] !== 0xff || bytes[i + 3] !== 0) continue;
    const version = view.getUint32(i + 4, true);
    if (version >= 1000 && version < 100_000) versions.push(version);
  }
  return versions;
}

function release(version: number): string {
  return version >= 4000 ? `SolidWorks ${2011 + Math.floor((version - 4000) / 1000)}` : '';
}

export async function readSolidWorks(src: SwSource, extension: string): Promise<PreviewResult> {
  // Configurations and their materials.
  const keywords = await xml(src, 'swXmlContents/KeyWords');
  const configurations = new Map<number, { name: string; material: string }>();
  for (const c of elements(keywords, 'Configuration')) {
    configurations.set(Number(c.attrs.id), { name: c.attrs.Name ?? '', material: (c.attrs.Material ?? '').replace(/^Material <not specified>$/, '') });
  }
  const configName = (index: number) => configurations.get(index)?.name || `${index + 1}`;

  // Previews: one for the document, one per configuration in newer files; old files may only have a DIB.
  const images: PreviewImage[] = [];
  for (const name of src.names.filter((n) => /(^|\/)(Config-\d+-)?PreviewPNG$/i.test(n))) {
    const bytes = await src.read(name);
    const picture = bytes && findPicture(bytes);
    if (!picture) continue;
    const config = /Config-(\d+)-/i.exec(name);
    images.push({ ...picture, label: config ? `Configuration ${configName(Number(config[1]))}` : 'Preview' });
  }
  images.sort((a, b) => Number(b.label === 'Preview') - Number(a.label === 'Preview'));
  if (!images.length) {
    const dib = await src.read('Preview');
    const picture = dib && dib.length > 48 ? (dibToBmp(dib.subarray(4)) ?? dibToBmp(dib) ?? findPicture(dib)) : null;
    if (picture) images.push(picture);
  }

  // Document properties: OLE sets up to 2014, Office-style XML since.
  const sets = (name: string) => src.propertySets?.(name) ?? [];
  const core = await xml(src, 'docProps/core.xml');
  const summary = core
    ? [
        row('Title', textOf(core, 'title')),
        row('Subject', textOf(core, 'subject')),
        row('Author', textOf(core, 'creator')),
        row('Keywords', textOf(core, 'keywords')),
        row('Comments', textOf(core, 'description')),
        row('Last saved by', textOf(core, 'lastModifiedBy')),
        row('Created', isoDate(textOf(core, 'created'))),
        row('Last saved', isoDate(textOf(core, 'modified'))),
      ]
    : labelledRows(sets('\x05SummaryInformation').find((s) => s.fmtid === SUMMARY_INFORMATION), SUMMARY_LABELS);
  const custom = await xml(src, 'docProps/custom.xml');
  const customRows = custom ? xmlUserProperties(custom) : namedRows(sets('\x05DocumentSummaryInformation').find((s) => s.fmtid === USER_DEFINED));

  const history = await versionHistory(src);
  const materials = [...new Set([...configurations.values()].map((c) => c.material).filter(Boolean))];
  const configNames = [...configurations.values()].map((c) => c.name).filter(Boolean);
  const sections: (MetaSection | null)[] = [
    section('Model', [
      row(configNames.length > 1 ? `Configurations (${configNames.length})` : 'Configuration', configNames.join(', ')),
      row(materials.length > 1 ? 'Materials' : 'Material', materials.join(', ')),
      row('Created with', history.length > 1 ? release(history[0]) : ''),
      row('Last saved with', release(history[history.length - 1] ?? 0)),
    ]),
    section('Summary', summary),
    section('Custom properties', customRows),
  ];

  // Configuration-specific properties and cut lists (weldments, sheet metal).
  for (const name of src.names) {
    const match = /(?:^|\/)Config-(\d+)-(Properties|Cutlist-Properties)(\.xml)?$/i.exec(name);
    if (!match) continue;
    const config = configName(Number(match[1]));
    if (match[2].toLowerCase() === 'properties') {
      const rows = match[3] ? xmlUserProperties(xmlFrom((await src.read(name)) ?? new Uint8Array())) : namedRows(sets(name).find((s) => s.fmtid === USER_DEFINED));
      sections.push(section(`Properties of configuration ${config}`, rows));
    } else {
      const text = xmlFrom((await src.read(name)) ?? new Uint8Array());
      for (const feature of elements(text, 'Feature').slice(0, 20)) {
        const rows = elements(feature.inner, 'CustomProperty').map((p) => ({ label: p.attrs.Name ?? '', value: textOf(`<v>${p.inner}</v>`, 'v') }));
        sections.push(section(`Cut list item ${feature.attrs.Name ?? ''}${configurations.size > 1 ? ` (${config})` : ''}`, rows.filter((r) => r.label && r.value)));
      }
    }
  }

  const lists: PreviewList[] = [];
  const tree = await xml(src, 'swXmlContents/COMPINSTANCETREE');
  if (tree) {
    const { tree: nodes, files } = components(tree);
    if (nodes.length) lists.push({ title: 'Components', nodes });
    if (files.length) lists.push({ title: 'Referenced files', nodes: files });
  }

  return {
    kind: KINDS[extension] ?? 'SolidWorks document',
    images,
    limits: LIMITS,
    sections: sections.filter((s): s is MetaSection => !!s),
    lists,
  };
}
