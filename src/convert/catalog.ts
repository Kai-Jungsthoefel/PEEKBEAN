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
}

export interface TargetFormat {
  id: string;
  label: string;
  extension: string;
  /** What does not survive the conversion; left out when nothing gets lost. */
  loss?: string;
  /** False for targets that are no format of their own (the attachments of an e-mail): no page per conversion. */
  pages?: false;
}

export interface ConverterInfo {
  id: string;
  /** Kind of files, e.g. "Images". */
  label: string;
  icon: IconName;
  /** Viewers (core/registry.ts) whose files this converter takes; the viewers' format detection decides. */
  viewers: string[];
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
const raw = (slug: string) => ({ slug, label: slug.toUpperCase(), extensions: [slug], note: RAW });

const LOSSY_TABLE = 'Values and formulas are kept; formatting, charts and pictures are not.';
const MESH = 'Exact surfaces are turned into triangles.';

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
  targets: ['csv'],
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
      { slug: 'jxl', label: 'JPEG XL', extensions: ['jxl'] },
      { slug: 'gif', label: 'GIF', extensions: ['gif'], note: 'Animated GIFs give their first frame.' },
      { slug: 'bmp', label: 'BMP', extensions: ['bmp'] },
      { slug: 'tiff', label: 'TIFF', extensions: ['tif', 'tiff'] },
      { slug: 'ico', label: 'ICO', extensions: ['ico', 'cur'] },
      { slug: 'svg', label: 'SVG', extensions: ['svg'], note: FLATTENED },
      { slug: 'emf', label: 'EMF', extensions: ['emf', 'emz'], note: FLATTENED },
      { slug: 'wmf', label: 'WMF', extensions: ['wmf', 'wmz'], note: FLATTENED },
      { slug: 'psd', label: 'PSD', extensions: ['psd'], note: 'The flattened picture; the layers are merged.' },
      { slug: 'tga', label: 'TGA', extensions: ['tga'] },
      { slug: 'dds', label: 'DDS', extensions: ['dds'], note: 'The full-size picture; smaller mipmap levels are left out.' },
      { slug: 'exr', label: 'EXR', extensions: ['exr'], note: 'High dynamic range is tone mapped to a normal picture.' },
      { slug: 'hdr', label: 'HDR', extensions: ['hdr'], note: 'High dynamic range is tone mapped to a normal picture.' },
      raw('cr2'), raw('cr3'), raw('nef'), raw('arw'), raw('dng'), raw('raf'), raw('orf'), raw('rw2'),
    ],
    targets: [
      { id: 'png', label: 'PNG', extension: 'png' },
      { id: 'jpg', label: 'JPG', extension: 'jpg', loss: 'Lossy compression; transparent areas become white.' },
      { id: 'webp', label: 'WebP', extension: 'webp', loss: 'Lossy compression.' },
    ],
    options: [QUALITY],
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
      { slug: 'xls', label: 'XLS', extensions: ['xls'] },
      { slug: 'xlsb', label: 'XLSB', extensions: ['xlsb'] },
      { slug: 'ods', label: 'ODS', extensions: ['ods', 'fods'] },
      { slug: 'numbers', label: 'Numbers', extensions: ['numbers'] },
      { slug: 'csv', label: 'CSV', extensions: ['csv'] },
      { slug: 'tsv', label: 'TSV', extensions: ['tsv'] },
    ],
    targets: [
      { id: 'xlsx', label: 'XLSX', extension: 'xlsx', loss: LOSSY_TABLE },
      { id: 'ods', label: 'ODS', extension: 'ods', loss: LOSSY_TABLE },
      { id: 'csv', label: 'CSV', extension: 'csv', loss: 'Values only, without formatting or formulas; one file per sheet.' },
      { id: 'xls', label: 'XLS', extension: 'xls', loss: LOSSY_TABLE },
      { id: 'xlsb', label: 'XLSB', extension: 'xlsb', loss: LOSSY_TABLE },
      { id: 'fods', label: 'FODS', extension: 'fods', loss: LOSSY_TABLE },
      { id: 'html', label: 'HTML', extension: 'html', loss: 'One table per sheet as a web page; formulas become their values.' },
    ],
    options: [SEPARATOR, ENCODING],
  },
  {
    id: 'model3d',
    label: '3D models',
    icon: 'cube',
    viewers: ['model3d', 'step'],
    sources: [
      { slug: 'step', label: 'STEP', extensions: ['step', 'stp'], note: MESH },
      { slug: 'iges', label: 'IGES', extensions: ['iges', 'igs'], note: MESH },
      { slug: 'stl', label: 'STL', extensions: ['stl'] },
      { slug: 'obj', label: 'OBJ', extensions: ['obj'] },
      { slug: 'ply', label: 'PLY', extensions: ['ply'] },
      { slug: 'glb', label: 'GLB', extensions: ['glb'] },
      { slug: 'gltf', label: 'glTF', extensions: ['gltf'] },
      { slug: '3mf', label: '3MF', extensions: ['3mf'] },
      { slug: 'fbx', label: 'FBX', extensions: ['fbx'] },
      { slug: 'dae', label: 'DAE', extensions: ['dae'] },
      { slug: '3ds', label: '3DS', extensions: ['3ds'] },
      { slug: '3dm', label: '3DM', extensions: ['3dm'], note: 'Surfaces come as the render meshes Rhino saved in the file.' },
      { slug: 'usdz', label: 'USDZ', extensions: ['usdz'] },
      { slug: 'usd', label: 'USD', extensions: ['usd', 'usda', 'usdc'] },
      { slug: 'wrl', label: 'VRML', extensions: ['wrl', 'vrml', 'wrz'] },
      { slug: 'off', label: 'OFF', extensions: ['off'] },
      { slug: 'amf', label: 'AMF', extensions: ['amf'] },
    ],
    targets: [
      { id: 'glb', label: 'GLB', extension: 'glb' },
      { id: 'stl', label: 'STL', extension: 'stl', loss: 'Only the triangles; colors, materials and the part structure are lost.' },
      { id: 'obj', label: 'OBJ', extension: 'obj', loss: 'Geometry and structure; colors and materials are lost.' },
      { id: 'ply', label: 'PLY', extension: 'ply', loss: 'Geometry and vertex colors; materials and the part structure are lost.' },
      { id: 'usdz', label: 'USDZ', extension: 'usdz', loss: 'Materials other than standard PBR ones are simplified.' },
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
      { slug: 'rar', label: 'RAR', extensions: ['rar'] },
      { slug: '7z', label: '7Z', extensions: ['7z'] },
      { slug: 'tar', label: 'TAR', extensions: ['tar'] },
      { slug: 'tgz', label: 'TAR.GZ', extensions: ['tar.gz', 'tgz'] },
      { slug: 'gz', label: 'GZ', extensions: ['gz'] },
      { slug: 'bz2', label: 'BZ2', extensions: ['bz2', 'tbz2', 'tar.bz2'] },
      { slug: 'xz', label: 'XZ', extensions: ['xz', 'txz', 'tar.xz'] },
      { slug: 'zst', label: 'ZST', extensions: ['zst'] },
      { slug: 'iso', label: 'ISO', extensions: ['iso'] },
      { slug: 'cab', label: 'CAB', extensions: ['cab'] },
      { slug: 'lzh', label: 'LZH', extensions: ['lzh', 'lha'] },
    ],
    targets: [
      { id: 'zip', label: 'ZIP', extension: 'zip', loss: 'Unix permissions, owners and symbolic links are not kept.' },
      { id: 'tgz', label: 'TAR.GZ', extension: 'tar.gz' },
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
      .map((target) => ({ slug: `${source.slug}-to-${target.id}`, converter, source, target })),
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
