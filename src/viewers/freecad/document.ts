// SPDX-License-Identifier: GPL-3.0-or-later
// Reads the object model of a FreeCAD document: Document.xml (objects, labels, placements, shapes, groups, links)
// and GuiDocument.xml (visibility, colors, transparency), plus the small binary color and material files they refer to.

/** Rotation as quaternion (x, y, z, w) and translation, in mm. */
export interface Placement {
  position: [number, number, number];
  quaternion: [number, number, number, number];
}

/** sRGB color, components 0–1. */
export type Rgb = [number, number, number];

export interface Appearance {
  /** One color for the whole shape, or one per face (in the shape's face order). */
  colors: Rgb[];
  /** 0 = opaque, 1 = invisible. */
  transparency: number;
}

export interface FcObject {
  name: string;
  type: string;
  label: string;
  placement: Placement | null;
  /** ZIP entry with the shape as BREP text, or the BREP text itself when the document embeds it. */
  shape: { file: string } | { text: string } | { binary: true } | null;
  /** Children of groups, parts and bodies. */
  group: string[];
  /** Objects whose children are listed in `group`. */
  container: boolean;
  /** Children are placed relative to this object (App::Part, PartDesign::Body). */
  placesChildren: boolean;
  /** For PartDesign bodies: the body shows its own shape instead of its features. */
  showsTip: boolean;
  link: {
    target: string;
    external: boolean;
    /** The target's own placement applies too (LinkTransform). */
    transform: boolean;
    placement: Placement;
    scale: [number, number, number];
    /** Link arrays: the placement of each element, relative to the link. */
    elements: Placement[];
  } | null;
  /** Other objects this one refers to by a link that makes them its child (Origin). */
  owned: string[];
  visible: boolean;
  appearance: Appearance | null;
  lineColor: Rgb | null;
}

export interface FcDocument {
  /** FreeCAD version from ProgramVersion, e.g. "0.21" or "1.0". */
  version: string;
  label: string;
  objects: Map<string, FcObject>;
  /** Object names in document order. */
  order: string[];
}

export type ReadEntry = (name: string) => Promise<Uint8Array | null>;

const child = (el: Element | null | undefined, tag: string) => (el ? [...el.children].find((c) => c.tagName === tag) ?? null : null);

/** Properties of an object (or view provider) by name: the <Property> element. */
function properties(el: Element): Map<string, Element> {
  const map = new Map<string, Element>();
  for (const p of child(el, 'Properties')?.children ?? []) {
    if (p.tagName === 'Property') map.set(p.getAttribute('name') ?? '', p);
  }
  return map;
}

const valueOf = (prop: Element | undefined, tag: string, attr = 'value') => prop?.getElementsByTagName(tag)[0]?.getAttribute(attr) ?? null;
const boolOf = (prop: Element | undefined) => {
  const value = valueOf(prop, 'Bool');
  return value === null ? null : value === 'true';
};

function placementOf(prop: Element | undefined): Placement | null {
  const el = prop?.getElementsByTagName('PropertyPlacement')[0];
  if (!el) return null;
  const num = (name: string) => Number(el.getAttribute(name) ?? 0) || 0;
  const position: [number, number, number] = [num('Px'), num('Py'), num('Pz')];
  if (el.hasAttribute('Q0')) return { position, quaternion: [num('Q0'), num('Q1'), num('Q2'), num('Q3')] };
  // Older files: angle around an axis.
  const angle = num('A');
  const axis = [num('Ox'), num('Oy'), num('Oz')];
  const length = Math.hypot(...axis) || 1;
  const s = Math.sin(angle / 2) / length;
  return { position, quaternion: [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)] };
}

/** FreeCAD packs colors as 0xRRGGBBAA. */
const unpack = (value: number): Rgb => [((value >>> 24) & 255) / 255, ((value >>> 16) & 255) / 255, ((value >>> 8) & 255) / 255];

function colorOf(prop: Element | undefined): Rgb | null {
  const value = valueOf(prop, 'PropertyColor');
  return value === null ? null : unpack(Number(value));
}

/** PropertyColorList: count, then packed colors. */
function colorList(data: Uint8Array): Rgb[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = data.byteLength >= 4 ? view.getUint32(0, true) : 0;
  const colors: Rgb[] = [];
  for (let i = 0; i < count && 8 + i * 4 <= data.byteLength; i++) colors.push(unpack(view.getUint32(4 + i * 4, true)));
  return colors;
}

/** PropertyMaterialList (FreeCAD 1.0+): count, then per material ambient, diffuse, specular, emissive, shininess, transparency. */
function materialList(data: Uint8Array): Appearance | null {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (data.byteLength < 4) return null;
  let offset = 0;
  let count = view.getInt32(0, true);
  // Development builds wrote a negative version number first.
  if (count < 0) {
    offset = 4;
    count = view.getUint32(4, true);
  }
  const colors: Rgb[] = [];
  let transparency = 0;
  for (let i = 0; i < count && offset + 4 + (i + 1) * 24 <= data.byteLength; i++) {
    const base = offset + 4 + i * 24;
    colors.push(unpack(view.getUint32(base + 4, true)));
    if (i === 0) transparency = view.getFloat32(base + 20, true);
  }
  return colors.length ? { colors, transparency: Math.min(1, Math.max(0, transparency || 0)) } : null;
}

/** PropertyPlacementList: count, then position and rotation quaternion per placement, as doubles (or floats). */
function placementList(data: Uint8Array): Placement[] {
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = data.byteLength >= 4 ? view.getUint32(0, true) : 0;
  const size = count && data.byteLength - 4 === count * 28 ? 4 : 8;
  const at = (i: number) => (size === 8 ? view.getFloat64(4 + i * 8, true) : view.getFloat32(4 + i * 4, true));
  const list: Placement[] = [];
  for (let i = 0; i < count && 4 + (i + 1) * 7 * size <= data.byteLength; i++) {
    const v = Array.from({ length: 7 }, (_, k) => at(i * 7 + k));
    list.push({ position: [v[0], v[1], v[2]], quaternion: [v[3], v[4], v[5], v[6]] });
  }
  return list;
}

const GROUP = /(^|::)GroupExtension/;
const PLACING_GROUP = /(^|::)(GeoFeatureGroupExtension|OriginGroupExtension)/;
/** Types that are containers in files written before group extensions existed. */
const CONTAINER_TYPES = new Set(['App::Part', 'App::DocumentObjectGroup', 'PartDesign::Body', 'Assembly::AssemblyObject']);

export async function readDocument(documentXml: string, guiXml: string | null, readEntry: ReadEntry): Promise<FcDocument> {
  const parser = new DOMParser();
  const doc = parser.parseFromString(documentXml, 'application/xml');
  const root = doc.documentElement;
  if (root.tagName !== 'Document' || doc.getElementsByTagName('parsererror').length) throw new Error('Document.xml is not a FreeCAD document.');
  const programVersion = root.getAttribute('ProgramVersion') ?? '';
  const version = /^(\d+\.\d+)/.exec(programVersion)?.[1] ?? '';
  const docProps = properties(root);
  const label = valueOf(docProps.get('Label'), 'String') ?? '';

  const types = new Map<string, string>();
  const order: string[] = [];
  for (const o of child(root, 'Objects')?.children ?? []) {
    if (o.tagName !== 'Object') continue;
    const name = o.getAttribute('name') ?? '';
    types.set(name, o.getAttribute('type') ?? '');
    order.push(name);
  }

  const objects = new Map<string, FcObject>();
  for (const o of child(root, 'ObjectData')?.children ?? []) {
    if (o.tagName !== 'Object') continue;
    const name = o.getAttribute('name') ?? '';
    const type = types.get(name) ?? '';
    const props = properties(o);
    const extensions = [...(child(o, 'Extensions')?.children ?? [])].map((e) => e.getAttribute('type') ?? '');
    const partEl = props.get('Shape')?.getElementsByTagName('Part')[0];
    let shape: FcObject['shape'] = null;
    if (partEl) {
      const file = partEl.getAttribute('file');
      if (file) shape = /\.bin$/i.test(file) ? { binary: true } : { file };
      else if (partEl.getAttribute('binary') === '1') shape = { binary: true };
      else if (partEl.getAttribute('brep') === '1' && partEl.textContent?.trim()) shape = { text: partEl.textContent };
    }
    const links = (prop: Element | undefined) => [...(prop?.getElementsByTagName('Link') ?? [])].map((l) => l.getAttribute('value') ?? '').filter(Boolean);
    const container = extensions.some((e) => GROUP.test(e)) || CONTAINER_TYPES.has(type);
    const placesChildren = extensions.some((e) => PLACING_GROUP.test(e)) || (container && type !== 'App::DocumentObjectGroup' && props.has('Placement'));

    let link: FcObject['link'] = null;
    const linked = props.get('LinkedObject');
    if (linked && (type.startsWith('App::Link') || extensions.some((e) => /LinkExtension/.test(e)))) {
      const xlink = linked.getElementsByTagName('XLink')[0] ?? linked.getElementsByTagName('Link')[0];
      const target = xlink?.getAttribute('name') ?? xlink?.getAttribute('value') ?? '';
      const scale = props.get('ScaleVector')?.getElementsByTagName('PropertyVector')[0];
      const uniform = Number(valueOf(props.get('Scale'), 'Float') ?? 1) || 1;
      link = {
        target,
        external: Boolean(xlink?.getAttribute('file')),
        transform: boolOf(props.get('LinkTransform')) ?? false,
        placement: placementOf(props.get('Placement')) ?? placementOf(props.get('LinkPlacement')) ?? { position: [0, 0, 0], quaternion: [0, 0, 0, 1] },
        scale: scale ? (['valueX', 'valueY', 'valueZ'].map((a) => Number(scale.getAttribute(a) ?? 1) || 1) as [number, number, number]) : [uniform, uniform, uniform],
        elements: [],
      };
      const count = Number(valueOf(props.get('ElementCount'), 'Integer') ?? 0) || 0;
      const listFile = valueOf(props.get('PlacementList'), 'PlacementList', 'file');
      if (count > 0 && listFile) link.elements = placementList((await readEntry(listFile)) ?? new Uint8Array()).slice(0, count);
    }

    objects.set(name, {
      name,
      type,
      label: valueOf(props.get('Label'), 'String') || name,
      placement: placementOf(props.get('Placement')),
      shape,
      group: container ? links(props.get('Group')) : [],
      container,
      placesChildren,
      showsTip: false,
      link,
      owned: links(props.get('Origin')),
      // Without a GUI file, the visibility stored by the application decides.
      visible: boolOf(props.get('Visibility')) ?? true,
      appearance: null,
      lineColor: null,
    });
  }

  if (guiXml) await readGui(parser, guiXml, objects, readEntry);
  return { version, label, objects, order: order.filter((n) => objects.has(n)) };
}

async function readGui(parser: DOMParser, guiXml: string, objects: Map<string, FcObject>, readEntry: ReadEntry): Promise<void> {
  const gui = parser.parseFromString(guiXml, 'application/xml');
  for (const vp of gui.getElementsByTagName('ViewProvider')) {
    const object = objects.get(vp.getAttribute('name') ?? '');
    if (!object) continue;
    const props = properties(vp);
    object.visible = boolOf(props.get('Visibility')) ?? object.visible;
    object.lineColor = colorOf(props.get('LineColor'));
    // PartDesign body display mode: 0 "Through" shows the features, 1 "Tip" the body's own shape.
    object.showsTip = object.type === 'PartDesign::Body' && valueOf(props.get('DisplayModeBody'), 'Integer') === '1';

    const transparency = Number(valueOf(props.get('Transparency'), 'Integer') ?? 0) / 100 || 0;
    const appearanceFile = valueOf(props.get('ShapeAppearance'), 'MaterialList', 'file');
    if (appearanceFile) {
      const data = await readEntry(appearanceFile);
      const appearance = data ? materialList(data) : null;
      if (appearance) {
        object.appearance = { colors: appearance.colors, transparency: appearance.transparency || transparency };
        continue;
      }
    }
    // Up to FreeCAD 0.21: one shape color, optionally a color per face.
    const shapeColor = colorOf(props.get('ShapeColor'));
    const diffuseFile = valueOf(props.get('DiffuseColor'), 'ColorList', 'file');
    const perFace = diffuseFile ? colorList((await readEntry(diffuseFile)) ?? new Uint8Array()) : [];
    if (perFace.length > 1) object.appearance = { colors: perFace, transparency };
    else if (shapeColor || perFace.length) object.appearance = { colors: [perFace[0] ?? shapeColor!], transparency };
  }
}
