// SPDX-License-Identifier: GPL-3.0-or-later
// Metadata of a file for the info panel. Everything is read locally; each format's reader loads only when needed.
import { extensionOf, formatBytes, startsWith } from '../core/bytes';
import { RAW_EXTENSIONS } from '../viewers/camera-raw';
import { formatDate, row, section, type MetaSection } from './model';

export type { MetaRow, MetaSection } from './model';

const IMAGE = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'tif', 'tiff', 'heic', 'heif', 'avif', 'png', 'webp', 'jxl', ...RAW_EXTENSIONS]);
const MEDIA = new Set(['mp4', 'm4v', 'm4a', 'mov', 'qt', '3gp', '3g2', 'mp3', 'flac', 'webm', 'mkv', 'ogg', 'oga', 'ogv', 'opus', 'wav', 'aac']);
const OFFICE = new Set(['docx', 'docm', 'dotx', 'dotm', 'xlsx', 'xlsm', 'xltx', 'xltm', 'pptx', 'pptm', 'potx', 'potm', 'ppsx', 'ppsm']);
const OPEN_DOCUMENT = new Set(['odt', 'ods', 'odp', 'odg', 'ott', 'ots', 'otp']);

async function formatSections(file: File, extension: string, head: Uint8Array): Promise<MetaSection[]> {
  const isJpeg = startsWith(head, [0xff, 0xd8, 0xff]);
  const isPng = startsWith(head, [0x89, 0x50, 0x4e, 0x47]);
  if (IMAGE.has(extension) || isJpeg || isPng) return (await import('./exif')).imageMetadata(file, extension);
  if (MEDIA.has(extension) || startsWith(head, 'ftyp', 4)) return (await import('./media')).mediaMetadata(file, extension);
  if (extension === 'pdf' || startsWith(head, '%PDF')) return (await import('./documents')).pdfMetadata(file);
  if (OFFICE.has(extension)) return (await import('./documents')).officeMetadata(file);
  if (OPEN_DOCUMENT.has(extension)) return (await import('./documents')).openDocumentMetadata(file);
  if (['step', 'stp', 'p21'].includes(extension) || startsWith(head, 'ISO-10303-21')) return (await import('./cad')).stepMetadata(file);
  if (extension === 'dxf') return (await import('./cad')).dxfMetadata(file);
  if (extension === 'dwg' || startsWith(head, 'AC10')) return (await import('./cad')).dwgMetadata(head);
  if (['ttf', 'otf', 'woff'].includes(extension)) return (await import('./misc')).fontMetadata(file);
  if (startsWith(head, 'SQLite format 3\0')) return (await import('./misc')).sqliteMetadata(head);
  if (['html', 'htm', 'xhtml'].includes(extension)) return (await import('./misc')).htmlMetadata(file);
  if (extension === 'rtf' || startsWith(head, '{\\rtf')) return (await import('./books')).rtfMetadata(file);
  if (extension === 'epub' || (startsWith(head, 'PK\x03\x04') && startsWith(head, 'mimetypeapplication/epub+zip', 30))) return (await import('./books')).epubMetadata(file);
  if (extension === 'fb2') return (await import('./books')).fb2Metadata(file);
  return [];
}

export async function readMetadata(file: File): Promise<MetaSection[]> {
  const extension = extensionOf(file.name);
  const head = new Uint8Array(await file.slice(0, 128).arrayBuffer());
  const general = section('File', [
    row('Name', file.name),
    row('Size', `${formatBytes(file.size)} (${file.size.toLocaleString('en-US')} bytes)`),
    row('MIME type', file.type),
    // For files from disk this is the modification time of the file system; it changes when files are copied.
    row('File modified', file.lastModified ? formatDate(new Date(file.lastModified)) : ''),
  ]);
  let specific: MetaSection[];
  try {
    specific = await formatSections(file, extension, head);
  } catch (error) {
    console.warn('Metadata could not be read:', error);
    specific = [{ title: 'Note', rows: [{ label: 'Metadata', value: 'Could not be read; the file is probably damaged.' }] }];
  }
  return [...specific, ...(general ? [general] : [])];
}
