// SPDX-License-Identifier: GPL-3.0-or-later
// What the converter turns into what. Plain data without browser code: the build reads it as well, to write one page
// per conversion (jpg-to-png.html …) that search engines find. The code that converts is in converters/.
import type { IconName } from '../core/icons';

export interface ConvertOption {
  id: string;
  label: string;
  choices: { value: string; label: string }[];
  initial: string;
  /** Targets the option applies to; all when left out. */
  targets?: string[];
}

export interface SourceFormat {
  /** Name in page addresses, e.g. "jpg" in jpg-to-png.html. */
  slug: string;
  label: string;
  extensions: string[];
  /** What is read from the file when that is not simply its content, e.g. the preview a camera embedded. */
  note?: string;
  /** Searched for mainly with the main targets (CR2 to JPG, hardly CR2 to WebP); see ConversionPair.indexed. */
  minor?: true;
}

export interface TargetFormat {
  id: string;
  label: string;
  extension: string;
  /** What does not survive the conversion; left out when nothing gets lost. */
  loss?: string;
  /** False for targets that are no format of their own (the attachments of an e-mail): no page per conversion. */
  pages?: false;
  /** Wanted mainly from the main sources (PNG to WebP, hardly CR2 to WebP); see ConversionPair.indexed. */
  minor?: true;
}

export interface ConverterInfo {
  id: string;
  /** Kind of files, e.g. "Images". */
  label: string;
  icon: IconName;
  /** Viewers (core/registry.ts) whose files this converter takes; the viewers' format detection decides. */
  viewers: string[];
  /** Takes only files with one of its sources' extensions: the text viewer shows far more than JSON or subtitles. */
  strict?: true;
  sources: SourceFormat[];
  targets: TargetFormat[];
  options?: ConvertOption[];
}

export interface ConversionPair {
  /** "jpg-to-png": the page jpg-to-png.html preselects this conversion. */
  slug: string;
  converter: ConverterInfo;
  source: SourceFormat;
  target: TargetFormat;
  /**
   * False from a minor source to a minor target. Such a page still exists for the search on the converter page, but
   * asks search engines to leave it out: hundreds of near-identical pages nobody searches for count as doorway pages.
   */
  indexed: boolean;
}

const QUALITY: ConvertOption = {
  id: 'quality',
  label: 'Quality',
  choices: [
    { value: '0.92', label: 'High' },
    { value: '0.8', label: 'Medium' },
    { value: '0.6', label: 'Small file' },
  ],
  initial: '0.92',
  targets: ['jpg', 'webp'],
};

const FLATTENED = 'The vector graphic becomes pixels at its own size.';
const RAW = 'The picture the camera embedded in the raw file; the raw data itself is not developed.';
const raw = (slug: string): SourceFormat => ({ slug, label: slug.toUpperCase(), extensions: [slug], note: RAW, minor: true });

const LOSSY_TABLE = 'Values and formulas are kept; formatting, charts and pictures are not.';
const MESH = 'Exact surfaces are turned into triangles.';
const SOUND_TRACK = 'Only the sound track; the picture is left out.';

const SEPARATOR: ConvertOption = {
  id: 'separator',
  label: 'Separator',
  choices: [
    { value: ',', label: 'Comma' },
    { value: ';', label: 'Semicolon' },
    { value: '\t', label: 'Tab' },
  ],
  initial: ',',
  targets: ['csv'],
};

const ENCODING: ConvertOption = {
  id: 'encoding',
  label: 'Encoding',
  // Without a byte order mark, Excel reads CSV in the legacy Windows code page and breaks non-ASCII text.
  choices: [
    { value: 'bom', label: 'UTF-8 for Excel' },
    { value: 'plain', label: 'UTF-8' },
  ],
  initial: 'bom',
  targets: ['csv', 'tsv'],
};

export const CONVERTERS: ConverterInfo[] = [
  {
    id: 'image',
    label: 'Images',
    icon: 'image',
    viewers: ['image'],
    sources: [
      { slug: 'jpg', label: 'JPG', extensions: ['jpg', 'jpeg', 'jfif', 'pjpeg'] },
      { slug: 'png', label: 'PNG', extensions: ['png', 'apng'] },
      { slug: 'webp', label: 'WebP', extensions: ['webp'] },
      { slug: 'heic', label: 'HEIC', extensions: ['heic', 'heif'] },
      { slug: 'avif', label: 'AVIF', extensions: ['avif'] },
      { slug: 'jxl', label: 'JPEG XL', extensions: ['jxl'], minor: true },
      { slug: 'gif', label: 'GIF', extensions: ['gif'], note: 'Animated GIFs give their first frame.' },
      { slug: 'bmp', label: 'BMP', extensions: ['bmp'], minor: true },
      { slug: 'tiff', label: 'TIFF', extensions: ['tif', 'tiff'], minor: true },
      { slug: 'ico', label: 'ICO', extensions: ['ico', 'cur'], minor: true },
      { slug: 'svg', label: 'SVG', extensions: ['svg'], note: FLATTENED },
      { slug: 'emf', label: 'EMF', extensions: ['emf', 'emz'], note: FLATTENED, minor: true },
      { slug: 'wmf', label: 'WMF', extensions: ['wmf', 'wmz'], note: FLATTENED, minor: true },
      { slug: 'psd', label: 'PSD', extensions: ['psd'], note: 'The flattened picture; the layers are merged.', minor: true },
      { slug: 'tga', label: 'TGA', extensions: ['tga'], minor: true },
      { slug: 'dds', label: 'DDS', extensions: ['dds'], note: 'The full-size picture; smaller mipmap levels are left out.', minor: true },
      { slug: 'exr', label: 'EXR', extensions: ['exr'], note: 'High dynamic range is tone mapped to a normal picture.', minor: true },
      { slug: 'hdr', label: 'HDR', extensions: ['hdr'], note: 'High dynamic range is tone mapped to a normal picture.', minor: true },
      raw('cr2'), raw('cr3'), raw('nef'), raw('arw'), raw('dng'), raw('raf'), raw('orf'), raw('rw2'),
    ],
    targets: [
      { id: 'png', label: 'PNG', extension: 'png' },
      { id: 'jpg', label: 'JPG', extension: 'jpg', loss: 'Lossy compression; transparent areas become white.' },
      { id: 'webp', label: 'WebP', extension: 'webp', loss: 'Lossy compression.', minor: true },
      { id: 'pdf', label: 'PDF', extension: 'pdf' },
      { id: 'ico', label: 'ICO', extension: 'ico', loss: 'Square icon sizes up to 256 × 256 pixels.', minor: true },
    ],
    options: [
      QUALITY,
      {
        id: 'page',
        label: 'Page size',
        choices: [
          { value: 'picture', label: 'Same as picture' },
          { value: 'a4', label: 'A4' },
          { value: 'letter', label: 'US Letter' },
        ],
        initial: 'picture',
        targets: ['pdf'],
      },
      {
        id: 'sizes',
        label: 'Sizes',
        choices: [
          { value: '16,24,32,48,64,128,256', label: 'Windows, 16 to 256' },
          { value: '16,32,48', label: 'Favicon, 16 to 48' },
        ],
        initial: '16,24,32,48,64,128,256',
        targets: ['ico'],
      },
    ],
  },
  {
    id: 'audio',
    label: 'Audio',
    icon: 'media',
    viewers: ['media'],
    sources: [
      { slug: 'mp3', label: 'MP3', extensions: ['mp3'] },
      { slug: 'm4a', label: 'M4A', extensions: ['m4a', 'm4b'] },
      { slug: 'aac', label: 'AAC', extensions: ['aac'] },
      { slug: 'flac', label: 'FLAC', extensions: ['flac'] },
      { slug: 'ogg', label: 'OGG', extensions: ['ogg', 'oga'] },
      { slug: 'opus', label: 'Opus', extensions: ['opus'] },
      { slug: 'wav', label: 'WAV', extensions: ['wav'] },
      { slug: 'mp4', label: 'MP4', extensions: ['mp4', 'm4v'], note: SOUND_TRACK },
      { slug: 'webm', label: 'WebM', extensions: ['webm', 'weba'], note: SOUND_TRACK, minor: true },
      { slug: 'mov', label: 'MOV', extensions: ['mov'], note: SOUND_TRACK, minor: true },
      { slug: 'mkv', label: 'MKV', extensions: ['mkv'], note: SOUND_TRACK, minor: true },
    ],
    targets: [{ id: 'wav', label: 'WAV', extension: 'wav' }],
    options: [
      {
        id: 'bits',
        label: 'Bit depth',
        choices: [
          { value: '16', label: '16-bit' },
          { value: '24', label: '24-bit' },
          { value: '32', label: '32-bit float' },
        ],
        initial: '16',
      },
    ],
  },
  {
    id: 'pdf',
    label: 'PDF documents',
    icon: 'file',
    viewers: ['pdf'],
    sources: [{ slug: 'pdf', label: 'PDF', extensions: ['pdf'] }],
    targets: [
      { id: 'png', label: 'PNG', extension: 'png', loss: 'One picture per page; text can no longer be selected.' },
      { id: 'jpg', label: 'JPG', extension: 'jpg', loss: 'One picture per page with lossy compression; text can no longer be selected.' },
    ],
    options: [
      {
        id: 'resolution',
        label: 'Resolution',
        choices: [
          { value: '72', label: 'Screen, 72 dpi' },
          { value: '150', label: 'Medium, 150 dpi' },
          { value: '300', label: 'Print, 300 dpi' },
        ],
        initial: '150',
      },
      QUALITY,
    ],
  },
  {
    id: 'office',
    label: 'Word and PowerPoint',
    icon: 'doc',
    viewers: ['docx', 'pptx'],
    sources: [
      { slug: 'docx', label: 'DOCX', extensions: ['docx', 'docm', 'dotx', 'dotm'] },
      { slug: 'pptx', label: 'PPTX', extensions: ['pptx', 'pptm', 'ppsx', 'potx'] },
    ],
    targets: [
      {
        id: 'pdf',
        label: 'PDF',
        extension: 'pdf',
        loss: 'Office fonts such as Calibri and Arial are replaced by open fonts with the same widths; shadows, glow and picture effects are simplified.',
      },
    ],
  },
  {
    id: 'spreadsheet',
    label: 'Spreadsheets',
    icon: 'table',
    viewers: ['spreadsheet'],
    sources: [
      { slug: 'xlsx', label: 'XLSX', extensions: ['xlsx', 'xlsm', 'xltx'] },
      { slug: 'xls', label: 'XLS', extensions: ['xls'], minor: true },
      { slug: 'xlsb', label: 'XLSB', extensions: ['xlsb'], minor: true },
      { slug: 'ods', label: 'ODS', extensions: ['ods', 'fods'], minor: true },
      { slug: 'numbers', label: 'Numbers', extensions: ['numbers'] },
      { slug: 'csv', label: 'CSV', extensions: ['csv'] },
      { slug: 'tsv', label: 'TSV', extensions: ['tsv'], minor: true },
    ],
    targets: [
      { id: 'xlsx', label: 'XLSX', extension: 'xlsx', loss: LOSSY_TABLE },
      { id: 'ods', label: 'ODS', extension: 'ods', loss: LOSSY_TABLE },
      { id: 'csv', label: 'CSV', extension: 'csv', loss: 'Values only, without formatting or formulas; one file per sheet.' },
      { id: 'xls', label: 'XLS', extension: 'xls', loss: LOSSY_TABLE },
      { id: 'xlsb', label: 'XLSB', extension: 'xlsb', loss: LOSSY_TABLE, minor: true },
      { id: 'fods', label: 'FODS', extension: 'fods', loss: LOSSY_TABLE, minor: true },
      { id: 'html', label: 'HTML', extension: 'html', loss: 'One table per sheet as a web page; formulas become their values.' },
      { id: 'json', label: 'JSON', extension: 'json', loss: 'An array with one object per row, named by the column names; one file per sheet. Formulas become their values.' },
      { id: 'tsv', label: 'TSV', extension: 'tsv', loss: 'Values only, separated by tabs; one file per sheet.', minor: true },
      { id: 'md', label: 'Markdown', extension: 'md', loss: 'A Markdown table per sheet with the column names as its header; values as displayed.', minor: true },
    ],
    options: [SEPARATOR, ENCODING],
  },
  {
    id: 'data',
    label: 'Data',
    icon: 'text',
    viewers: ['text'],
    strict: true,
    sources: [
      { slug: 'json', label: 'JSON', extensions: ['json'] },
      { slug: 'yaml', label: 'YAML', extensions: ['yaml', 'yml'] },
      { slug: 'jsonl', label: 'JSON Lines', extensions: ['jsonl', 'ndjson'], minor: true },
      { slug: 'jsonc', label: 'JSONC', extensions: ['jsonc'], minor: true },
      { slug: 'json5', label: 'JSON5', extensions: ['json5'], minor: true },
    ],
    targets: [
      { id: 'json', label: 'JSON', extension: 'json' },
      { id: 'yaml', label: 'YAML', extension: 'yaml' },
      { id: 'jsonl', label: 'JSON Lines', extension: 'jsonl', minor: true },
    ],
    options: [
      {
        id: 'layout',
        label: 'Layout',
        choices: [
          { value: 'pretty', label: 'Indented' },
          { value: 'minified', label: 'Minified' },
        ],
        initial: 'pretty',
        targets: ['json'],
      },
    ],
  },
  {
    id: 'subtitles',
    label: 'Subtitles',
    icon: 'text',
    viewers: ['text'],
    strict: true,
    sources: [
      { slug: 'srt', label: 'SRT', extensions: ['srt'] },
      { slug: 'vtt', label: 'VTT', extensions: ['vtt'] },
    ],
    targets: [
      { id: 'srt', label: 'SRT', extension: 'srt', loss: 'Positions, styles and voice tags of WebVTT are left out; speakers stay in front of their text.' },
      { id: 'vtt', label: 'VTT', extension: 'vtt' },
    ],
  },
  {
    id: 'model3d',
    label: '3D models',
    icon: 'cube',
    viewers: ['model3d', 'step'],
    sources: [
      { slug: 'step', label: 'STEP', extensions: ['step', 'stp'], note: MESH, minor: true },
      { slug: 'iges', label: 'IGES', extensions: ['iges', 'igs'], note: MESH, minor: true },
      { slug: 'stl', label: 'STL', extensions: ['stl'] },
      { slug: 'obj', label: 'OBJ', extensions: ['obj'] },
      { slug: 'ply', label: 'PLY', extensions: ['ply'], minor: true },
      { slug: 'glb', label: 'GLB', extensions: ['glb'] },
      { slug: 'gltf', label: 'glTF', extensions: ['gltf'] },
      { slug: '3mf', label: '3MF', extensions: ['3mf'], minor: true },
      { slug: 'fbx', label: 'FBX', extensions: ['fbx'] },
      { slug: 'dae', label: 'DAE', extensions: ['dae'], minor: true },
      { slug: '3ds', label: '3DS', extensions: ['3ds'], minor: true },
      { slug: '3dm', label: '3DM', extensions: ['3dm'], note: 'Surfaces come as the render meshes Rhino saved in the file.', minor: true },
      { slug: 'usdz', label: 'USDZ', extensions: ['usdz'], minor: true },
      { slug: 'usd', label: 'USD', extensions: ['usd', 'usda', 'usdc'], minor: true },
      { slug: 'wrl', label: 'VRML', extensions: ['wrl', 'vrml', 'wrz'], minor: true },
      { slug: 'off', label: 'OFF', extensions: ['off'], minor: true },
      { slug: 'amf', label: 'AMF', extensions: ['amf'], minor: true },
    ],
    targets: [
      { id: 'glb', label: 'GLB', extension: 'glb' },
      { id: 'stl', label: 'STL', extension: 'stl', loss: 'Only the triangles; colors, materials and the part structure are lost.' },
      { id: 'obj', label: 'OBJ', extension: 'obj', loss: 'Geometry and structure; colors and materials are lost.' },
      { id: 'ply', label: 'PLY', extension: 'ply', loss: 'Geometry and vertex colors; materials and the part structure are lost.', minor: true },
      { id: 'usdz', label: 'USDZ', extension: 'usdz', loss: 'Materials other than standard PBR ones are simplified.', minor: true },
    ],
  },
  {
    id: 'drawing',
    label: 'CAD drawings',
    icon: 'drawing',
    viewers: ['dwg', 'hpgl'],
    sources: [
      { slug: 'dwg', label: 'DWG', extensions: ['dwg'] },
      { slug: 'plt', label: 'PLT', extensions: ['plt'], note: 'HP-GL plot files: one layer per pen.' },
      { slug: 'hpgl', label: 'HPGL', extensions: ['hpgl', 'hpg', 'hgl'], note: 'One layer per pen.' },
    ],
    targets: [{ id: 'dxf', label: 'DXF', extension: 'dxf' }],
  },
  {
    id: 'archive',
    label: 'Archives',
    icon: 'archive',
    viewers: ['archive'],
    sources: [
      { slug: 'zip', label: 'ZIP', extensions: ['zip'] },
      { slug: 'rar', label: 'RAR', extensions: ['rar'], minor: true },
      { slug: '7z', label: '7Z', extensions: ['7z'], minor: true },
      { slug: 'tar', label: 'TAR', extensions: ['tar'] },
      { slug: 'tgz', label: 'TAR.GZ', extensions: ['tar.gz', 'tgz'] },
      { slug: 'gz', label: 'GZ', extensions: ['gz'], minor: true },
      { slug: 'bz2', label: 'BZ2', extensions: ['bz2', 'tbz2', 'tar.bz2'], minor: true },
      { slug: 'xz', label: 'XZ', extensions: ['xz', 'txz', 'tar.xz'], minor: true },
      { slug: 'zst', label: 'ZST', extensions: ['zst'], minor: true },
      { slug: 'iso', label: 'ISO', extensions: ['iso'], minor: true },
      { slug: 'cab', label: 'CAB', extensions: ['cab'], minor: true },
      { slug: 'lzh', label: 'LZH', extensions: ['lzh', 'lha'], minor: true },
    ],
    targets: [
      { id: 'zip', label: 'ZIP', extension: 'zip', loss: 'Unix permissions, owners and symbolic links are not kept.' },
      { id: 'tgz', label: 'TAR.GZ', extension: 'tar.gz', minor: true },
    ],
  },
  {
    id: 'comic',
    label: 'Comic books',
    icon: 'book',
    viewers: ['comic'],
    sources: [
      { slug: 'cbr', label: 'CBR', extensions: ['cbr'] },
      { slug: 'cb7', label: 'CB7', extensions: ['cb7'] },
      { slug: 'cbt', label: 'CBT', extensions: ['cbt'] },
      { slug: 'cbz', label: 'CBZ', extensions: ['cbz'] },
    ],
    targets: [{ id: 'cbz', label: 'CBZ', extension: 'cbz' }],
  },
  {
    id: 'map',
    label: 'Map data',
    icon: 'map',
    viewers: ['map'],
    sources: [
      // A shapefile usually comes as a ZIP with its .dbf and .prj (modules.ts sends such ZIPs here).
      { slug: 'shp', label: 'Shapefile', extensions: ['shp', 'zip'], note: 'A .shp file alone has no attributes; in a ZIP with its .dbf and .prj files they are kept.' },
      { slug: 'kml', label: 'KML', extensions: ['kml'] },
      { slug: 'kmz', label: 'KMZ', extensions: ['kmz'] },
      { slug: 'gpx', label: 'GPX', extensions: ['gpx'] },
      { slug: 'tcx', label: 'TCX', extensions: ['tcx'] },
      { slug: 'geojson', label: 'GeoJSON', extensions: ['geojson'] },
      { slug: 'topojson', label: 'TopoJSON', extensions: ['topojson'] },
    ],
    targets: [
      { id: 'geojson', label: 'GeoJSON', extension: 'geojson', loss: 'Coordinates in WGS84 longitude and latitude; styles are not kept.' },
      { id: 'kml', label: 'KML', extension: 'kml', loss: 'Attributes as extended data; only simple styles.' },
      { id: 'gpx', label: 'GPX', extension: 'gpx', loss: 'Only points and lines; areas and most attributes are left out.' },
      { id: 'csv', label: 'CSV', extension: 'csv', loss: 'One row per feature with its attributes; the geometry as WKT.' },
      { id: 'shp', label: 'Shapefile', extension: 'zip', loss: 'Field names of at most 10 characters; one set of files per geometry type, in a ZIP.' },
    ],
    options: [SEPARATOR, ENCODING],
  },
  {
    id: 'email',
    label: 'E-mails',
    icon: 'mail',
    viewers: ['email'],
    sources: [
      { slug: 'msg', label: 'MSG', extensions: ['msg'] },
      { slug: 'eml', label: 'EML', extensions: ['eml'] },
    ],
    targets: [
      { id: 'eml', label: 'EML', extension: 'eml', loss: 'Outlook-only properties such as categories, flags and follow-ups are not kept.' },
      { id: 'html', label: 'HTML', extension: 'html', loss: 'The message with its header as a web page; attachments are left out.' },
      { id: 'attachments', label: 'Attachments', extension: 'zip', pages: false },
    ],
  },
  {
    id: 'database',
    label: 'Databases',
    icon: 'database',
    viewers: ['access', 'sqlite', 'columnar'],
    sources: [
      { slug: 'mdb', label: 'MDB', extensions: ['mdb', 'mde'] },
      { slug: 'accdb', label: 'ACCDB', extensions: ['accdb', 'accde'] },
      { slug: 'sqlite', label: 'SQLite', extensions: ['sqlite', 'sqlite3', 'db', 'db3'] },
      { slug: 'parquet', label: 'Parquet', extensions: ['parquet', 'pq'] },
      { slug: 'arrow', label: 'Arrow', extensions: ['arrow', 'feather', 'ipc', 'arrows'] },
    ],
    targets: [
      { id: 'xlsx', label: 'XLSX', extension: 'xlsx', loss: 'One sheet per table; queries, forms, indexes and relations are not kept.' },
      { id: 'csv', label: 'CSV', extension: 'csv', loss: 'One file per table; types, indexes and relations are not kept.' },
      { id: 'sqlite', label: 'SQLite', extension: 'sqlite', loss: 'Tables with their data; queries, forms, reports and macros are not kept.' },
    ],
    options: [SEPARATOR, ENCODING],
  },
];

/** Every conversion that gets its own page: each source to each target of its converter, except to itself. */
export const PAIRS: ConversionPair[] = CONVERTERS.flatMap((converter) =>
  converter.sources.flatMap((source) =>
    converter.targets
      .filter((target) => target.id !== source.slug && target.pages !== false)
      .map((target) => ({ slug: `${source.slug}-to-${target.id}`, converter, source, target, indexed: !(source.minor && target.minor) })),
  ),
);

export function findPair(slug: string): ConversionPair | undefined {
  return PAIRS.find((pair) => pair.slug === slug);
}

/** File name of a conversion's page, relative to the site root. */
export const pairPage = (pair: ConversionPair) => `${pair.slug}.html`;

/** Options of a converter that apply to a target. */
export function optionsFor(converter: ConverterInfo, target: string): ConvertOption[] {
  return (converter.options ?? []).filter((option) => !option.targets || option.targets.includes(target));
}

export function initialOptions(converter: ConverterInfo): Record<string, string> {
  return Object.fromEntries((converter.options ?? []).map((option) => [option.id, option.initial]));
}

/**
 * The source format of a file, by its name or just its extension, when the converter lists it. The longest matching
 * extension wins, so "data.tar.gz" is TAR.GZ and not GZ.
 */
export function sourceFor(converter: ConverterInfo, name: string): SourceFormat | undefined {
  const lower = name.toLowerCase();
  let best: SourceFormat | undefined;
  let length = 0;
  for (const source of converter.sources) {
    for (const extension of source.extensions) {
      if (extension.length > length && (lower === extension || lower.endsWith(`.${extension}`))) {
        best = source;
        length = extension.length;
      }
    }
  }
  return best;
}

/** The first target that is not the file's own format (by name or extension): a PNG goes to JPG by default. */
export function defaultTarget(converter: ConverterInfo, name: string): TargetFormat {
  const own = sourceFor(converter, name)?.slug;
  return converter.targets.find((target) => target.id !== own) ?? converter.targets[0];
}
