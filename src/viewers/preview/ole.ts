// SPDX-License-Identifier: GPL-3.0-or-later
// CAD files in OLE compound containers: SolidWorks up to 2014, Autodesk Inventor and Siemens Solid Edge, plus any other
// OLE document as a fallback. They keep a preview picture and their document properties in OLE property sets.
import { formatNumber, section, type MetaRow, type MetaSection } from '../../metadata/model';
import { readCfb, type Cfb } from './cfb';
import { clipboardPicture, pictureArea } from './images';
import { DOCUMENT_SUMMARY, DOCUMENT_SUMMARY_LABELS, SUMMARY_INFORMATION, SUMMARY_LABELS, labelledRows, namedRows, propertyText, readPropertySets, type PropertySet } from './propset';
import { readSolidWorks } from './solidworks';
import type { PreviewImage, PreviewNode, PreviewResult } from './types';

// Inventor keeps the standard summary properties in sets of its own, under the same property IDs.
const INVENTOR_SUMMARY = '3d38de39-0588-4c14-bb37-18f4d5dd31c7';
const INVENTOR_DOCUMENT_SUMMARY = '8cf58000-da66-4ae6-8ff0-7b58406fb049';
const INVENTOR_USER_DEFINED = '9929adb8-6407-413e-b3dc-cb9ad2f564b7';
const INVENTOR_DESIGN_TRACKING = '32853f0f-3444-11d1-9e93-0060b03c1ca6';
const SOLID_EDGE_SUMMARY = 'cc024fa2-6eb5-11ce-8aa2-08003601e988';

/** Inventor's "Project" tab (Design Tracking Properties) by property ID. */
const DESIGN_TRACKING: Record<number, string> = {
  5: 'Part number',
  29: 'Description',
  56: 'Stock number',
  7: 'Project',
  9: 'Cost center',
  20: 'Material',
  72: 'Appearance',
  30: 'Vendor',
  48: 'Manufacturer',
  37: 'Standard',
  41: 'Designer',
  42: 'Engineer',
  43: 'Authority',
  10: 'Checked by',
  11: 'Date checked',
  12: 'Engineering approved by',
  13: 'Date engineering approved',
  34: 'Manufacturing approved by',
  35: 'Date manufacturing approved',
  4: 'Creation date',
  40: 'Design state',
  32: 'Document subtype',
  67: 'Last updated with',
};
const DESIGN_STATES: Record<number, string> = { 1: 'Work in progress', 2: 'Pending', 3: 'Released' };

const INVENTOR_KINDS: Record<string, string> = { ipt: 'Inventor part', iam: 'Inventor assembly', idw: 'Inventor drawing', ipn: 'Inventor presentation', ide: 'Inventor iFeature' };
/** Solid Edge's document status, by code. */
const SOLID_EDGE_STATUS = ['Available', 'In work', 'In review', 'Released', 'Baselined', 'Obsolete'];
const SOLID_EDGE_KINDS: Record<string, string> = { par: 'Solid Edge part', psm: 'Solid Edge sheet metal part', asm: 'Solid Edge assembly', dft: 'Solid Edge drawing', pwd: 'Solid Edge weldment' };

/** The largest picture among the clipboard properties of the sets. */
function clipboardPreview(sets: PropertySet[]): PreviewImage | null {
  let best: PreviewImage | null = null;
  for (const set of sets) {
    for (const value of set.values.values()) {
      if (typeof value !== 'object' || value instanceof Date || value instanceof Uint8Array || !value.data.length) continue;
      const picture = clipboardPicture(value.data);
      if (picture && (!best || pictureArea(picture) > pictureArea(best))) best = picture;
    }
  }
  return best;
}

function setsByStream(cfb: Cfb): Map<string, PropertySet[]> {
  const byStream = new Map<string, PropertySet[]>();
  for (const entry of cfb.entries) {
    if (entry.kind !== 'stream' || entry.size < 48 || entry.size > 4 * 1024 * 1024) continue;
    const bytes = cfb.read(entry.path);
    if (!bytes || bytes[0] !== 0xfe || bytes[1] !== 0xff) continue;
    const sets = readPropertySets(bytes);
    if (sets.length) byStream.set(entry.path, sets);
  }
  return byStream;
}

function dedupe(rows: MetaRow[]): MetaRow[] {
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.label) && seen.add(r.label));
}

export function fileNode(path: string): PreviewNode {
  const slash = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  return slash < 0 ? { name: path } : { name: path.slice(slash + 1), detail: path.slice(0, slash) };
}

/** Paths of the parts and subassemblies an Inventor document references: UTF-16 strings in the UFRxDoc stream. */
function inventorReferences(bytes: Uint8Array | null, ownName: string): string[] {
  if (!bytes) return [];
  const found = new Set<string>();
  for (const shift of [0, 1]) {
    const text = new TextDecoder('utf-16le').decode(bytes.subarray(shift, shift + ((bytes.length - shift) & ~1)));
    // A length or flag character may follow the path directly, so there is no check for the end of the name.
    for (const match of text.matchAll(/(?:[A-Za-z]:\\|\\\\)[^\0-\x1f<>"|?*]*?\.(?:ipt|iam|ipn|idw|dwg|ide)/gi)) {
      // The template the document was made from appears in a notice ("Document … was created using …").
      if (!text.startsWith(' was created', match.index + match[0].length)) found.add(match[0]);
    }
  }
  // One of the paths is where the document itself was saved.
  return [...found].filter((path) => fileNode(path).name.toLowerCase() !== ownName.toLowerCase());
}

export async function readOle(data: Uint8Array, extension: string, fileName: string): Promise<PreviewResult> {
  const cfb = readCfb(data);
  const byStream = setsByStream(cfb);
  const sets = [...byStream.values()].flat();
  const find = (fmtid: string) => sets.find((s) => s.fmtid === fmtid);
  const has = (path: string) => cfb.entries.some((e) => e.path.toLowerCase() === path.toLowerCase());

  if (has('ISolidWorksInformation') || has('Header2') || ['sldprt', 'sldasm', 'slddrw'].includes(extension)) {
    return readSolidWorks(
      { names: cfb.entries.filter((e) => e.kind === 'stream').map((e) => e.path), read: async (name) => cfb.read(name), propertySets: (name) => byStream.get(name) ?? [] },
      extension,
    );
  }

  if (has('RSeStorage') || find(INVENTOR_DESIGN_TRACKING)) {
    const tracking = find(INVENTOR_DESIGN_TRACKING);
    const picture = clipboardPreview([find(INVENTOR_SUMMARY), find(SUMMARY_INFORMATION)].filter((s): s is PropertySet => !!s)) ?? clipboardPreview(sets);
    const references = inventorReferences(cfb.read('UFRxDoc'), fileName);
    const subtype = propertyText(tracking?.values.get(32));
    return {
      kind: INVENTOR_KINDS[extension] ?? (subtype === 'Assembly' ? 'Inventor assembly' : 'Inventor document'),
      images: picture ? [picture] : [],
      limits: 'This is the preview picture Inventor saved in the file. The 3D model cannot be shown: Inventor files are a closed format. Export the model as STEP in Inventor to view it here in 3D.',
      sections: [
        section('Project', labelledRows(tracking, DESIGN_TRACKING, { 40: (v) => DESIGN_STATES[Number(v)] ?? '' })),
        section('Summary', labelledRows(find(INVENTOR_SUMMARY) ?? find(SUMMARY_INFORMATION), SUMMARY_LABELS)),
        section('Document', labelledRows(find(INVENTOR_DOCUMENT_SUMMARY) ?? find(DOCUMENT_SUMMARY), DOCUMENT_SUMMARY_LABELS)),
        section('Custom properties', namedRows(find(INVENTOR_USER_DEFINED))),
      ].filter((s): s is MetaSection => !!s),
      lists: references.length ? [{ title: 'Referenced files', nodes: references.map(fileNode) }] : [],
    };
  }

  const savingApp = propertyText(find(SOLID_EDGE_SUMMARY)?.values.get(2));
  const solidEdge = /solid edge/i.test(savingApp) || extension in SOLID_EDGE_KINDS;
  const picture = clipboardPreview(sets);
  const summary = find(SUMMARY_INFORMATION);
  const application = propertyText(summary?.values.get(18)) || savingApp;
  // Solid Edge and other applications name their own sets' properties; internal bookkeeping is left out.
  const internal = /^(Status|Username|CreationLocale|Hardware|Document Content Type|Large DIB|Small DIB|SCHEMA_REV|DOCUMENT_COUNT|Accuracy|Name of Saving Application)$/i;
  const named = dedupe(sets.filter((s) => ![SUMMARY_INFORMATION, DOCUMENT_SUMMARY].includes(s.fmtid)).flatMap((s) => namedRows(s, internal))).map((r) =>
    solidEdge && r.label === 'Design Status' ? { ...r, value: SOLID_EDGE_STATUS[Number(r.value)] ?? r.value } : r,
  );
  const streams = cfb.entries.filter((e) => e.kind === 'stream' && !e.path.includes('/'));
  return {
    kind: SOLID_EDGE_KINDS[extension] ?? (solidEdge ? 'Solid Edge document' : application ? `${application} document` : 'OLE compound document'),
    images: picture ? [picture] : [],
    limits: solidEdge
      ? 'This is the preview picture Solid Edge saved in the file. The 3D model cannot be shown: Solid Edge files are a closed format. Save the model as STEP in Solid Edge to view it here in 3D.'
      : 'This is an OLE compound document of an application OPSIS cannot show. Shown are the preview picture and the properties it carries.',
    sections: [
      section('Summary', labelledRows(summary, SUMMARY_LABELS)),
      section('Document', labelledRows(find(DOCUMENT_SUMMARY), DOCUMENT_SUMMARY_LABELS)),
      section(solidEdge ? 'Properties' : 'Custom properties', named),
    ].filter((s): s is MetaSection => !!s),
    lists: solidEdge
      ? []
      : [{ title: 'Streams', nodes: streams.slice(0, 200).map((e) => ({ name: e.name.replace(/^\x05/, ''), detail: `${formatNumber(e.size, 0)} bytes` })), total: streams.length }],
  };
}

