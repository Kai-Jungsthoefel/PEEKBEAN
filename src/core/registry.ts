// SPDX-License-Identifier: GPL-3.0-or-later
import { extensionOf, looksLikeText, startsWith } from './bytes';
import type { ViewerDefinition } from './types';

const SNIFF_LENGTH = 4096;

function containsAscii(head: Uint8Array, needle: string, within: number): boolean {
  const limit = Math.min(head.length, within) - needle.length;
  for (let i = 0; i <= limit; i++) {
    if (startsWith(head, needle, i)) return true;
  }
  return false;
}

const latin1 = (head: Uint8Array, length = 512) => String.fromCharCode(...head.subarray(0, length));

// ISO base media files (MP4, MOV, HEIC, AVIF) all start with an "ftyp" box; the brand tells them apart.
const IMAGE_BRANDS = ['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1'];
function ftypBrand(head: Uint8Array): string | null {
  return startsWith(head, 'ftyp', 4) ? latin1(head.subarray(8, 12)) : null;
}

export const textViewer: ViewerDefinition = {
  id: 'text',
  label: 'Text / source code',
  icon: 'text',
  extensions: [
    'txt', 'log', 'rst', 'json', 'jsonc', 'json5', 'geojson', 'xml', 'xsd', 'xsl', 'ini', 'cfg', 'conf', 'properties',
    'env', 'yaml', 'yml', 'toml', 'css', 'scss', 'less', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'vue',
    'svelte', 'py', 'rb', 'php', 'pl', 'lua', 'r', 'java', 'kt', 'kts', 'scala', 'groovy', 'gradle', 'c', 'h', 'cpp',
    'cc', 'cxx', 'hpp', 'hh', 'cs', 'fs', 'go', 'rs', 'swift', 'dart', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1',
    'bat', 'cmd', 'sql', 'graphql', 'proto', 'tex', 'bib', 'diff', 'patch', 'dockerfile', 'makefile', 'cmake', 'tf',
    'srt', 'vtt', 'jsonl', 'ndjson', 'reg', 'vbs', 'asm', 'xaml', 'service', 'editorconfig',
  ],
  load: () => import('../viewers/text'),
};

export const hexViewer: ViewerDefinition = {
  id: 'hex',
  label: 'Binary data (hex)',
  icon: 'binary',
  extensions: [],
  load: () => import('../viewers/hex'),
};

export const viewers: ViewerDefinition[] = [
  {
    id: 'pdf',
    label: 'PDF document',
    category: 'documents',
    icon: 'file',
    extensions: ['pdf'],
    // The spec allows junk before the header, readers accept it within the first KB.
    sniff: (head) => containsAscii(head, '%PDF-', 1024),
    load: () => import('../viewers/pdf'),
  },
  {
    id: 'docx',
    label: 'Word document',
    category: 'documents',
    icon: 'doc',
    extensions: ['docx', 'docm', 'dotx', 'dotm'],
    load: () => import('../viewers/docx'),
  },
  {
    id: 'spreadsheet',
    label: 'Spreadsheet',
    category: 'documents',
    icon: 'table',
    extensions: ['xlsx', 'xlsm', 'xlsb', 'xls', 'xltx', 'ods', 'fods', 'numbers', 'csv', 'tsv'],
    load: () => import('../viewers/spreadsheet'),
  },
  {
    id: 'pptx',
    label: 'Presentation',
    category: 'documents',
    icon: 'slides',
    extensions: ['pptx', 'pptm', 'ppsx', 'potx'],
    load: () => import('../viewers/pptx'),
  },
  {
    id: 'dxf',
    label: 'DXF drawing',
    category: 'cad',
    icon: 'drawing',
    extensions: ['dxf'],
    sniff: (head) =>
      startsWith(head, 'AutoCAD Binary DXF') || /^\s*(?:999\r?\n[^\n]*\n\s*)*0\r?\n\s*SECTION/.test(latin1(head)),
    load: () => import('../viewers/dxf'),
  },
  {
    id: 'dwg',
    label: 'DWG drawing',
    category: 'cad',
    icon: 'drawing',
    extensions: ['dwg'],
    sniff: (head) => /^AC(?:1\d{3}|[12]\.\d\d)/.test(latin1(head, 6)),
    load: () => import('../viewers/dwg'),
  },
  {
    id: 'step',
    label: 'CAD model (STEP, IGES)',
    category: 'cad',
    icon: 'cad',
    extensions: ['step', 'stp', 'p21', 'iges', 'igs', 'brep', 'brp'],
    sniff: (head) =>
      startsWith(head, 'ISO-10303-21;') ||
      startsWith(head, 'DBRep_DrawableShape') ||
      /^.{72}S\s*0*1\r?\n/.test(latin1(head, 90)),
    load: () => import('../viewers/step'),
  },
  {
    id: 'model3d',
    label: '3D model',
    category: 'cad',
    icon: 'cube',
    extensions: [
      'stl', 'obj', 'ply', 'glb', 'gltf', '3mf', '3dm', 'fbx', 'dae', '3ds', 'amf', 'wrl', 'vrml', 'wrz', 'vtk', 'vtp',
      'usd', 'usda', 'usdc', 'usdz', 'pcd', 'xyz', 'off', 'bim', 'vox',
    ],
    sniff: (head) =>
      startsWith(head, 'glTF') ||
      startsWith(head, 'ply\n') ||
      startsWith(head, 'ply\r\n') ||
      startsWith(head, 'Kaydara FBX Binary') ||
      startsWith(head, '3D Geometry File Format') ||
      startsWith(head, 'PXR-USDC'),
    load: () => import('../viewers/model3d'),
  },
  {
    id: 'gcode',
    label: 'CNC program (G-code)',
    category: 'cad',
    icon: 'toolpath',
    // .nc is also NetCDF; the viewer turns binary files away, and "View as" offers the hex view.
    extensions: ['nc', 'gcode', 'gco', 'ngc', 'tap', 'cnc', 'mpf', 'eia'],
    load: () => import('../viewers/gcode'),
  },
  {
    id: 'image',
    label: 'Image',
    category: 'media',
    icon: 'image',
    extensions: [
      'png', 'apng', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'cur', 'svg',
      'tif', 'tiff', 'psd', 'heic', 'heif', 'tga', 'dds', 'exr', 'hdr', 'ktx2', 'emf', 'wmf', 'emz', 'wmz',
    ],
    sniff: (head) =>
      startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
      startsWith(head, [0xff, 0xd8, 0xff]) ||
      startsWith(head, 'GIF87a') ||
      startsWith(head, 'GIF89a') ||
      (startsWith(head, 'RIFF') && startsWith(head, 'WEBP', 8)) ||
      startsWith(head, 'II*\0') ||
      startsWith(head, 'MM\0*') ||
      startsWith(head, '8BPS') ||
      startsWith(head, 'DDS ') ||
      startsWith(head, [0x76, 0x2f, 0x31, 0x01]) ||
      startsWith(head, '#?RADIANCE') ||
      startsWith(head, [0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb]) ||
      // Placeable WMF, and EMF (record 1 with " EMF" at byte 40).
      startsWith(head, [0xd7, 0xcd, 0xc6, 0x9a]) ||
      (startsWith(head, [1, 0, 0, 0]) && startsWith(head, ' EMF', 40)) ||
      IMAGE_BRANDS.includes(ftypBrand(head) ?? ''),
    load: () => import('../viewers/image'),
  },
  {
    id: 'media',
    label: 'Audio / Video',
    category: 'media',
    icon: 'media',
    extensions: [
      'mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'weba',
    ],
    sniff: (head) => {
      const brand = ftypBrand(head);
      return (
        (brand !== null && !IMAGE_BRANDS.includes(brand)) ||
        startsWith(head, [0x1a, 0x45, 0xdf, 0xa3]) ||
        startsWith(head, 'OggS') ||
        startsWith(head, 'fLaC') ||
        startsWith(head, 'ID3') ||
        (startsWith(head, 'RIFF') && startsWith(head, 'WAVE', 8))
      );
    },
    load: () => import('../viewers/media'),
  },
  {
    id: 'email',
    label: 'E-mail',
    category: 'data',
    icon: 'mail',
    extensions: ['eml', 'msg'],
    sniff: (head) =>
      /^(?:Return-Path|Received|Delivered-To|Message-ID|MIME-Version|From|DKIM-Signature|X-[\w-]+)\s*:/i.test(latin1(head, 200)),
    container: true,
    load: () => import('../viewers/email'),
  },
  {
    id: 'archive',
    label: 'Archive',
    category: 'data',
    icon: 'archive',
    extensions: [
      'zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst', 'lz4', 'cab', 'iso', 'lzh', 'lha',
      'cpio', 'ar', 'deb', 'rpm', 'jar', 'war', 'apk', 'xpi', 'nupkg', 'whl',
    ],
    sniff: (head) =>
      startsWith(head, 'PK\x03\x04') ||
      startsWith(head, 'PK\x05\x06') ||
      startsWith(head, [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]) ||
      startsWith(head, 'Rar!\x1a\x07') ||
      startsWith(head, [0x1f, 0x8b]) ||
      startsWith(head, 'BZh') ||
      startsWith(head, [0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]) ||
      startsWith(head, 'MSCF') ||
      startsWith(head, 'ustar', 257),
    // DOCX, XLSX, PPTX, 3MF, JAR … are ZIP files too.
    container: true,
    load: () => import('../viewers/archive'),
  },
  {
    id: 'font',
    label: 'Font',
    category: 'media',
    icon: 'font',
    extensions: ['ttf', 'otf', 'woff', 'woff2', 'ttc'],
    // Plain TrueType starts with 00 01 00 00, too common in other binaries to rely on; the extension covers it.
    sniff: (head) => startsWith(head, 'OTTO') || startsWith(head, 'wOFF') || startsWith(head, 'wOF2') || startsWith(head, 'ttcf'),
    load: () => import('../viewers/font'),
  },
  {
    id: 'sqlite',
    label: 'SQLite database',
    category: 'data',
    icon: 'database',
    extensions: ['sqlite', 'sqlite3', 'db', 'db3', 'gpkg', 'mbtiles'],
    sniff: (head) => startsWith(head, 'SQLite format 3\0'),
    load: () => import('../viewers/sqlite'),
  },
  {
    id: 'comic',
    label: 'Comic book',
    category: 'documents',
    icon: 'book',
    extensions: ['cbz', 'cbr', 'cb7', 'cbt'],
    load: () => import('../viewers/comic'),
  },
  {
    id: 'notebook',
    label: 'Jupyter notebook',
    category: 'documents',
    icon: 'notebook',
    extensions: ['ipynb'],
    load: () => import('../viewers/notebook'),
  },
  {
    id: 'ical',
    label: 'Calendar or contacts',
    category: 'data',
    icon: 'calendar',
    extensions: ['ics', 'ical', 'ifb', 'vcs', 'vcf', 'vcard'],
    sniff: (head) => /^\s*BEGIN:(VCALENDAR|VCARD)\r?\n/i.test(latin1(head, 64)),
    load: () => import('../viewers/ical'),
  },
  {
    id: 'shortcut',
    label: 'Shortcut',
    category: 'data',
    icon: 'link',
    extensions: ['lnk', 'url', 'desktop', 'webloc'],
    sniff: (head) => startsWith(head, [0x4c, 0, 0, 0, 0x01, 0x14, 0x02, 0x00]) || startsWith(head, '[InternetShortcut]'),
    load: () => import('../viewers/shortcut'),
  },
  {
    id: 'markdown',
    label: 'Markdown',
    category: 'documents',
    icon: 'markdown',
    extensions: ['md', 'markdown', 'mdown', 'mkd'],
    load: () => import('../viewers/markdown'),
  },
  {
    id: 'html',
    label: 'Web page (HTML)',
    category: 'data',
    icon: 'globe',
    extensions: ['html', 'htm', 'xhtml', 'mht'],
    load: () => import('../viewers/html'),
  },
  textViewer,
  hexViewer,
];

/** Picks a viewer: file signature first, then extension, then a text/binary guess. */
export async function detectViewer(file: File): Promise<ViewerDefinition> {
  const head = new Uint8Array(await file.slice(0, SNIFF_LENGTH).arrayBuffer());
  const ext = extensionOf(file.name) || file.name.toLowerCase();
  const bySignature = viewers.find((v) => v.sniff?.(head));
  const byExtension = viewers.find((v) => v.extensions.includes(ext));
  if (bySignature && !(bySignature.container && byExtension)) return bySignature;
  return byExtension ?? bySignature ?? (looksLikeText(head) ? textViewer : hexViewer);
}
