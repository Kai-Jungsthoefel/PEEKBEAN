// SPDX-License-Identifier: GPL-3.0-or-later
// Document properties: PDF info dictionary (pdf.js), Office Open XML docProps and OpenDocument meta.xml (zip.js).
import { BlobReader, TextWriter, ZipReader, configure, type Entry } from '@zip.js/zip.js';
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { formatNumber, row, section, xmlDate, xmlText, type MetaRow, type MetaSection } from './model';

configure({ useWebWorkers: false, useCompressionStream: true });
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

export async function pdfMetadata(file: File): Promise<MetaSection[]> {
  // Without a password handler, encrypted files fail with a PasswordException; the viewer asks for the password.
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const pdf = await task.promise;
    const { info } = (await pdf.getMetadata()) as { info: Record<string, unknown> };
    const date = (value: unknown) => (typeof value === 'string' ? pdfjsLib.PDFDateString.toDateObject(value) : null);
    const flags = [info.IsAcroFormPresent && 'form', info.IsXFAPresent && 'XFA form', info.IsSignaturesPresent && 'signatures', info.IsCollectionPresent && 'portfolio']
      .filter(Boolean)
      .join(', ');
    const custom = (info.Custom ?? {}) as Record<string, unknown>;
    const result = [
      section('Document', [
        row('Title', info.Title),
        row('Author', info.Author),
        row('Subject', info.Subject),
        row('Keywords', info.Keywords),
        row('Created', date(info.CreationDate)),
        row('Modified', date(info.ModDate)),
        row('Pages', pdf.numPages),
      ]),
      section('Origin', [
        row('Created with', info.Creator),
        row('PDF producer', info.Producer),
        row('PDF version', info.PDFFormatVersion),
        row('Fast web view', info.IsLinearized ? 'yes' : ''),
        row('Contains', flags),
      ]),
      section('Other properties', Object.entries(custom).map(([key, value]) => row(key, typeof value === 'object' && value && 'name' in value ? (value as { name: string }).name : value))),
    ];
    return result.filter((s): s is MetaSection => s !== null);
  } catch (error) {
    if ((error as { name?: string })?.name === 'PasswordException') return [{ title: 'Document', rows: [{ label: 'Protection', value: 'Password protected; properties can be read only after opening' }] }];
    throw error;
  } finally {
    await task.destroy();
  }
}

async function readXml(entries: Entry[], name: string): Promise<Document | null> {
  const entry = entries.find((e) => e.filename === name);
  if (!entry || entry.directory) return null;
  const xml = await entry.getData(new TextWriter());
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  return doc.getElementsByTagName('parsererror').length ? null : doc;
}

/** Word, Excel and PowerPoint (also macro-enabled files and templates). */
export async function officeMetadata(file: File): Promise<MetaSection[]> {
  const zip = new ZipReader(new BlobReader(file));
  try {
    const entries = await zip.getEntries();
    const core = await readXml(entries, 'docProps/core.xml');
    const app = await readXml(entries, 'docProps/app.xml');
    const custom = await readXml(entries, 'docProps/custom.xml');
    const c = (name: string) => (core ? xmlText(core, name) : '');
    const a = (name: string) => (app ? xmlText(app, name) : '');
    const minutes = Number(a('TotalTime'));
    const customRows: (MetaRow | null)[] = custom
      ? [...custom.getElementsByTagNameNS('*', 'property')].map((p) => row(p.getAttribute('name') ?? '', p.textContent))
      : [];
    return [
      section('Document', [
        row('Title', c('title')),
        row('Subject', c('subject')),
        row('Author', c('creator')),
        row('Keywords', c('keywords')),
        row('Category', c('category')),
        row('Description', c('description')),
        row('Status', c('contentStatus')),
        row('Created', xmlDate(c('created'))),
        row('Modified', xmlDate(c('modified'))),
        row('Last saved by', c('lastModifiedBy')),
        row('Last printed', xmlDate(c('lastPrinted'))),
        row('Version', c('revision')),
      ]),
      section('Statistics', [
        row('Pages', a('Pages')),
        row('Slides', a('Slides')),
        row('Hidden slides', Number(a('HiddenSlides')) ? a('HiddenSlides') : ''),
        row('Notes', Number(a('Notes')) ? a('Notes') : ''),
        row('Words', a('Words') ? formatNumber(Number(a('Words'))) : ''),
        row('Characters', a('Characters') ? formatNumber(Number(a('Characters'))) : ''),
        row('Editing time', minutes > 0 ? `${formatNumber(minutes)} min` : ''),
      ]),
      section('Origin', [
        row('Application', [a('Application'), a('AppVersion')].filter(Boolean).join(' ')),
        row('Template', a('Template')),
        row('Company', a('Company')),
        row('Manager', a('Manager')),
      ]),
      section('Custom properties', customRows),
    ].filter((s): s is MetaSection => s !== null);
  } finally {
    await zip.close();
  }
}

/** OpenDocument text, spreadsheet, presentation and drawing (LibreOffice). */
export async function openDocumentMetadata(file: File): Promise<MetaSection[]> {
  const zip = new ZipReader(new BlobReader(file));
  try {
    const meta = await readXml(await zip.getEntries(), 'meta.xml');
    if (!meta) return [];
    const m = (name: string) => xmlText(meta, name);
    const statistic = meta.getElementsByTagNameNS('*', 'document-statistic')[0];
    const stat = (name: string) => statistic?.getAttributeNS(statistic.namespaceURI, name) ?? statistic?.getAttribute(`meta:${name}`) ?? '';
    const editing = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/.exec(m('editing-duration'));
    const minutes = editing ? Number(editing[1] ?? 0) * 1440 + Number(editing[2] ?? 0) * 60 + Number(editing[3] ?? 0) : 0;
    return [
      section('Document', [
        row('Title', m('title')),
        row('Subject', m('subject')),
        row('Description', m('description')),
        row('Keywords', [...meta.getElementsByTagNameNS('*', 'keyword')].map((k) => k.textContent ?? '')),
        row('Created by', m('initial-creator')),
        row('Created', xmlDate(m('creation-date'))),
        row('Last saved by', m('creator')),
        row('Modified', xmlDate(m('date'))),
        row('Editing cycles', m('editing-cycles')),
        row('Editing time', minutes > 0 ? `${formatNumber(minutes)} min` : ''),
      ]),
      section('Statistics', [row('Pages', stat('page-count')), row('Tables', stat('table-count')), row('Words', stat('word-count')), row('Images', stat('image-count'))]),
      section('Origin', [row('Application', m('generator'))]),
    ].filter((s): s is MetaSection => s !== null);
  } finally {
    await zip.close();
  }
}
