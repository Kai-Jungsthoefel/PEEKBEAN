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

// ISO base media files (MP4, MOV, HEIC, AVIF, Canon CR3) all start with an "ftyp" box; the brand tells them apart.
// OLE compound files: Office 97–2003, Outlook messages, Inventor, Solid Edge, SolidWorks up to 2014.
const OLE_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const IMAGE_BRANDS = ['avif', 'avis', 'heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1', 'crx '];
function ftypBrand(head: Uint8Array): string | null {
  return startsWith(head, 'ftyp', 4) ? latin1(head.subarray(8, 12)) : null;
}

export const textViewer: ViewerDefinition = {
  id: 'text',
  label: 'Text / source code',
  icon: 'text',
  extensions: [
    'txt', 'log', 'rst', 'json', 'jsonc', 'json5', 'xml', 'xsd', 'xsl', 'ini', 'cfg', 'conf', 'properties',
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

const PCB_EXTENSIONS = [
  'gbr', 'ger', 'gtl', 'gbl', 'gts', 'gbs', 'gto', 'gbo', 'gtp', 'gbp', 'gko', 'gm1', 'gml', 'g1', 'g2', 'gp1', 'gp2',
  'drl', 'xln', 'exc', 'drd',
];

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
    id: 'rtf',
    label: 'Rich Text document',
    category: 'documents',
    icon: 'doc',
    extensions: ['rtf'],
    // Also catches .doc files that are really RTF.
    sniff: (head) => startsWith(head, '{\\rtf'),
    load: () => import('../viewers/rtf'),
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
    id: 'hpgl',
    label: 'Plot file (HPGL)',
    category: 'cad',
    icon: 'drawing',
    // .plt is also used by gnuplot scripts; the viewer shows those as text.
    extensions: ['plt', 'hpgl', 'hpg', 'hgl'],
    sniff: (head) =>
      /^\s*(?:BP[^;]*;\s*)?IN\s*;/.test(latin1(head, 64)) ||
      /^\x1bE?\x1b%-?[01]B\s*(?:BP|IN)/.test(latin1(head, 64)) ||
      /^(?:\x1b%-12345X)?@PJL[^]*?ENTER LANGUAGE\s*=\s*HPGL2/i.test(latin1(head, 2048)),
    load: () => import('../viewers/hpgl'),
  },
  {
    id: 'pcb',
    label: 'Circuit board (Gerber)',
    category: 'cad',
    icon: 'chip',
    extensions: PCB_EXTENSIONS,
    // Only Gerber X2 and KiCad drill files name themselves; older files are known by their extension.
    sniff: (head) => {
      const text = latin1(head, head.length);
      return /^\s*(?:%|G04|M48)/.test(text) && /TF\.FileFunction,/.test(text) && (/%FS[LT]?[AI]X\d\dY\d\d\*%/.test(text) || /^M48\r?$/m.test(text));
    },
    wholeArchive: {
      label: 'Open as circuit board',
      title: 'Show the Gerber and drill files together as a circuit board',
      accepts: (names) => names.some((name) => PCB_EXTENSIONS.includes(extensionOf(name))),
    },
    load: () => import('../viewers/pcb'),
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
    id: 'ifc',
    label: 'BIM model (IFC)',
    category: 'cad',
    icon: 'building',
    extensions: ['ifc'],
    // A STEP file whose header names an IFC schema, or an IFC model view definition. Must come before STEP.
    sniff: (head) =>
      startsWith(head, 'ISO-10303-21;') && /FILE_SCHEMA\s*\(\s*\(\s*'IFC|ViewDefinition\s*\[/i.test(latin1(head, head.length)),
    load: () => import('../viewers/ifc'),
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
    id: 'freecad',
    label: 'FreeCAD document',
    category: 'cad',
    icon: 'cad',
    // A ZIP: the archive's signature matches too, the extension decides.
    extensions: ['fcstd', 'fcbak'],
    load: () => import('../viewers/freecad'),
  },
  {
    id: 'pointcloud',
    label: 'Point cloud (LAS/LAZ)',
    category: 'cad',
    icon: 'points',
    extensions: ['las', 'laz'],
    sniff: (head) => startsWith(head, 'LASF'),
    load: () => import('../viewers/pointcloud'),
  },
  {
    id: 'cadpreview',
    label: 'CAD model (preview picture)',
    category: 'cad',
    icon: 'cad',
    // Closed formats: the preview picture the application saved, the properties and the component tree.
    extensions: [
      'sldprt', 'sldasm', 'slddrw', 'ipt', 'iam', 'idw', 'ipn', 'prt', 'par', 'psm', 'pwd', 'dft', 'catpart', 'catproduct',
      'catdrawing', 'blend', 'blend1',
    ],
    // NX, CATIA V5, Creo (also "part.prt.3"), Blender, and OLE compound files: Inventor, Solid Edge, SolidWorks up to
    // 2014. OLE is shared with Word, Excel and Outlook files, so their viewers win by extension.
    sniff: (head) =>
      startsWith(head, 'SPLMSSTR') ||
      startsWith(head, 'V5_CFV2\0') ||
      startsWith(head, '#UGC:') ||
      startsWith(head, 'BLENDER') ||
      startsWith(head, OLE_SIGNATURE),
    container: (head) => startsWith(head, OLE_SIGNATURE),
    load: () => import('../viewers/preview'),
  },
  {
    id: 'image',
    label: 'Image',
    category: 'media',
    icon: 'image',
    extensions: [
      'png', 'apng', 'jpg', 'jpeg', 'jfif', 'pjpeg', 'gif', 'webp', 'avif', 'bmp', 'ico', 'cur', 'svg',
      'tif', 'tiff', 'psd', 'heic', 'heif', 'tga', 'dds', 'exr', 'hdr', 'ktx2', 'emf', 'wmf', 'emz', 'wmz', 'jxl', 'kra', 'krz', 'ora',
      // Camera raw (the embedded preview is shown).
      'dng', 'cr2', 'cr3', 'crw', 'nef', 'nrw', 'arw', 'srf', 'sr2', 'orf', 'rw2', 'rwl', 'raf', 'pef', 'srw', '3fr', 'iiq',
      'erf', 'kdc', 'dcr', 'mos', 'mrw', 'x3f',
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
      // JPEG XL codestream and container.
      startsWith(head, [0xff, 0x0a]) ||
      startsWith(head, [0, 0, 0, 0x0c, 0x4a, 0x58, 0x4c, 0x20, 0x0d, 0x0a, 0x87, 0x0a]) ||
      // Camera raw: Fujifilm, Olympus, Panasonic, Canon CRW, Minolta, Sigma (TIFF-based raws are covered above).
      ['FUJIFILMCCD-RAW', 'IIRO', 'IIRS', 'MMOR', 'IIU\0', '\0MRM', 'FOVb'].some((s) => startsWith(head, s)) ||
      startsWith(head, 'HEAPCCDR', 6) ||
      IMAGE_BRANDS.includes(ftypBrand(head) ?? ''),
    load: () => import('../viewers/image'),
  },
  {
    id: 'designpreview',
    label: 'Design file (preview picture)',
    category: 'media',
    icon: 'image',
    // Illustrator files with a PDF part open in the PDF viewer by their signature.
    extensions: ['pdn', 'afphoto', 'afdesign', 'afpub', 'af', 'indd', 'indt', 'fig', 'eps', 'epsf', 'ai'],
    sniff: (head) =>
      startsWith(head, 'PDN3') ||
      startsWith(head, [0x00, 0xff, 0x4b, 0x41]) ||
      startsWith(head, [0x06, 0x06, 0xed, 0xf5, 0xd8, 0x1d, 0x46, 0xe5, 0xbd, 0x31, 0xef, 0xe7, 0xfe, 0x74, 0xb7, 0x1d]) ||
      startsWith(head, 'fig-kiwi') ||
      startsWith(head, [0xc5, 0xd0, 0xd3, 0xc6]),
    load: () => import('../viewers/preview'),
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
    id: 'access',
    label: 'Access database',
    category: 'data',
    icon: 'database',
    extensions: ['mdb', 'accdb', 'mde', 'accde'],
    sniff: (head) => startsWith(head, 'Standard Jet DB', 4) || startsWith(head, 'Standard ACE DB', 4),
    load: () => import('../viewers/access'),
  },
  {
    id: 'columnar',
    label: 'Parquet / Arrow table',
    category: 'data',
    icon: 'table',
    extensions: ['parquet', 'pq', 'arrow', 'feather', 'ipc', 'arrows'],
    sniff: (head) => startsWith(head, 'PAR1') || startsWith(head, 'ARROW1'),
    load: () => import('../viewers/columnar'),
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
    id: 'ebook',
    label: 'E-book',
    category: 'documents',
    icon: 'book',
    extensions: ['epub', 'fb2'],
    // EPUB: a ZIP whose first entry is the uncompressed file "mimetype". FB2: XML with a <FictionBook> root.
    sniff: (head) =>
      (startsWith(head, 'PK\x03\x04') && startsWith(head, 'mimetypeapplication/epub+zip', 30)) || containsAscii(head, '<FictionBook', 1024),
    load: () => import('../viewers/ebook'),
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
    id: 'mindmap',
    label: 'Mind map',
    category: 'documents',
    icon: 'tree',
    // XMind and MindManager files are ZIPs (their extension decides); FreeMind and Freeplane maps are XML. .mm is also
    // Objective-C++: the viewer shows such files as text.
    extensions: ['xmind', 'mmap', 'mmat', 'xmmap', 'mm'],
    sniff: (head) => /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<map\s+version=/.test(latin1(head).replace(/^\xef\xbb\xbf/, '')),
    load: () => import('../viewers/mindmap'),
  },
  {
    id: 'map',
    label: 'Map data (GIS)',
    category: 'data',
    icon: 'map',
    // Shapefiles inside a ZIP open via "View as" or the archive's "Open as map".
    extensions: ['shp', 'kml', 'kmz', 'gpx', 'tcx', 'geojson', 'topojson'],
    // Only the root element of KML, GPX and TCX, and GeoJSON/TopoJSON that start with their "type".
    sniff: (head) =>
      /^(?:\xef\xbb\xbf)?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*<(?:\w+:)?(?:kml|gpx|TrainingCenterDatabase)[\s>]/.test(latin1(head, 1024)) ||
      /^(?:\xef\xbb\xbf)?\s*\{\s*"type"\s*:\s*"(?:FeatureCollection|Feature|Topology)"/.test(latin1(head, 256)),
    // The map viewer reads shapefile sets from ZIP archives only.
    wholeArchive: {
      label: 'Open as map',
      title: 'Show the shapefiles in this archive on a map',
      accepts: (names, kind) => kind === 'ZIP' && names.some((name) => extensionOf(name) === 'shp'),
    },
    load: () => import('../viewers/map'),
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
    id: 'certificate',
    label: 'Certificate',
    category: 'data',
    icon: 'shield',
    extensions: ['pem', 'crt', 'cer', 'der', 'p7b', 'p7c', 'csr', 'p12', 'pfx', 'key'],
    sniff: (head) => /^\s*-----BEGIN /.test(latin1(head, 64)),
    load: () => import('../viewers/certificate'),
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
  const sniffed = viewers.filter((v) => v.sniff?.(head));
  const container = (v: ViewerDefinition) => (typeof v.container === 'function' ? v.container(head) : !!v.container);
  // A specific signature (an EPUB's mimetype entry) beats a container one (any ZIP).
  const bySignature = sniffed.find((v) => !container(v)) ?? sniffed[0];
  const byExtension = viewers.find((v) => v.extensions.includes(ext));
  // A source code extension says nothing about binary data (a Solid Edge assembly is an .asm file too).
  const textByName = byExtension === textViewer && !looksLikeText(head);
  if (bySignature && !(container(bySignature) && byExtension && !textByName)) return bySignature;
  return byExtension ?? bySignature ?? (looksLikeText(head) ? textViewer : hexViewer);
}
