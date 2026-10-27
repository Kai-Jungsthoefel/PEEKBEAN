// SPDX-License-Identifier: GPL-3.0-or-later
// Reads IFC models with web-ifc (MPL-2.0): the spatial structure and merged geometry at once, the properties of one
// product on request. Free of worker globals (ifc.worker.ts drives it), so it also runs in Node for tests.
import {
  FILE_NAME, FILE_SCHEMA, IFCAPPLICATION, IFCOPENINGELEMENT, IFCOPENINGSTANDARDCASE, IFCPROJECT, IFCRELAGGREGATES,
  IFCRELASSOCIATESMATERIAL, IFCRELCONTAINEDINSPATIALSTRUCTURE, IFCRELDEFINESBYPROPERTIES, IFCRELDEFINESBYTYPE,
  IFCRELFILLSELEMENT, IFCRELNESTS, IFCRELVOIDSELEMENT, IFCSITE, IFCSPACE,
  type FlatMesh, type IfcAPI,
} from 'web-ifc';
import type { IfcBucket, IfcMaterial, IfcModel, IfcProperties, IfcPropertySection, IfcTreeNode } from './ifc-types';

interface RawLine {
  ID: number;
  type: number;
  arguments: unknown[];
}

/** Express ID of a reference argument, 0 if it is none. */
const ref = (v: unknown): number => (v && typeof v === 'object' && (v as { type?: number }).type === 5 ? Number((v as { value: number }).value) : 0);
const refs = (v: unknown): number[] => (Array.isArray(v) ? v.map(ref).filter(Boolean) : ref(v) ? [ref(v)] : []);
/** Text of a string, label or enumeration argument. */
const text = (v: unknown): string => (v && typeof v === 'object' && 'value' in v ? String((v as { value: unknown }).value ?? '') : '');

/** Containers of the spatial structure. Spaces count as elements: they are hidden by default and grouped like walls. */
const SPATIAL = /^Ifc(Site|Building|BuildingStorey|Facility|FacilityPart|Bridge|BridgePart|Road|RoadPart|Railway|RailwayPart|MarineFacility|MarinePart|Tunnel|TunnelPart|ExternalSpatialElement)$/i;
/** A new mesh starts after this many triangles, so picking, measuring and edges never work on huge meshes. */
const BUCKET_TRIANGLES = 200_000;
/** Shown see-through when the file gives them no color of their own. */
const SPACE_COLOR: IfcMaterial = { color: [0.45, 0.68, 0.85], opacity: 0.3 };
const OPENING_COLOR: IfcMaterial = { color: [0.95, 0.6, 0.22], opacity: 0.35 };

// ---- Units -------------------------------------------------------------------------------------------------

const PREFIXES: Record<string, string> = {
  EXA: 'E', PETA: 'P', TERA: 'T', GIGA: 'G', MEGA: 'M', KILO: 'k', HECTO: 'h', DECA: 'da',
  DECI: 'd', CENTI: 'c', MILLI: 'm', MICRO: 'µ', NANO: 'n', PICO: 'p', FEMTO: 'f', ATTO: 'a',
};
const SI_NAMES: Record<string, string> = {
  METRE: 'm', SQUARE_METRE: 'm²', CUBIC_METRE: 'm³', GRAM: 'g', SECOND: 's', RADIAN: 'rad', STERADIAN: 'sr',
  DEGREE_CELSIUS: '°C', KELVIN: 'K', WATT: 'W', JOULE: 'J', NEWTON: 'N', PASCAL: 'Pa', HERTZ: 'Hz', AMPERE: 'A',
  VOLT: 'V', OHM: 'Ω', LUMEN: 'lm', LUX: 'lx', CANDELA: 'cd', MOLE: 'mol', COULOMB: 'C', FARAD: 'F', HENRY: 'H',
  SIEMENS: 'S', TESLA: 'T', WEBER: 'Wb', BECQUEREL: 'Bq', GRAY: 'Gy', SIEVERT: 'Sv',
};
const CONVERTED_NAMES: Record<string, string> = {
  FOOT: 'ft', FEET: 'ft', INCH: 'in', YARD: 'yd', MILE: 'mi', 'SQUARE FOOT': 'ft²', 'SQUARE INCH': 'in²', 'SQUARE YARD': 'yd²',
  ACRE: 'ac', 'CUBIC FOOT': 'ft³', 'CUBIC INCH': 'in³', 'CUBIC YARD': 'yd³', GALLON: 'gal', LITRE: 'L', DEGREE: '°',
  POUND: 'lb', OUNCE: 'oz', TON: 't', MINUTE: 'min', HOUR: 'h', DAY: 'd',
};
/** SI units for derived quantities a file often leaves out of its unit assignment. */
const DEFAULT_UNITS: Record<string, string> = {
  THERMALTRANSMITTANCEUNIT: 'W/(m²·K)', MASSDENSITYUNIT: 'kg/m³', THERMALCONDUCTANCEUNIT: 'W/(m·K)', POWERUNIT: 'W',
  PRESSUREUNIT: 'Pa', FREQUENCYUNIT: 'Hz', ELECTRICCURRENTUNIT: 'A', ELECTRICVOLTAGEUNIT: 'V', LUMINOUSFLUXUNIT: 'lm',
  ILLUMINANCEUNIT: 'lx', VOLUMETRICFLOWRATEUNIT: 'm³/s', LINEARVELOCITYUNIT: 'm/s', THERMODYNAMICTEMPERATUREUNIT: 'K',
};
/** Unit kind of each measure type, to label property values. */
const MEASURE_UNITS: Record<string, string> = {
  IFCLENGTHMEASURE: 'LENGTHUNIT', IFCPOSITIVELENGTHMEASURE: 'LENGTHUNIT', IFCNONNEGATIVELENGTHMEASURE: 'LENGTHUNIT',
  IFCAREAMEASURE: 'AREAUNIT', IFCVOLUMEMEASURE: 'VOLUMEUNIT', IFCMASSMEASURE: 'MASSUNIT', IFCTIMEMEASURE: 'TIMEUNIT',
  IFCPLANEANGLEMEASURE: 'PLANEANGLEUNIT', IFCPOSITIVEPLANEANGLEMEASURE: 'PLANEANGLEUNIT',
  IFCTHERMALTRANSMITTANCEMEASURE: 'THERMALTRANSMITTANCEUNIT', IFCMASSDENSITYMEASURE: 'MASSDENSITYUNIT',
  IFCTHERMALCONDUCTIVITYMEASURE: 'THERMALCONDUCTANCEUNIT', IFCPOWERMEASURE: 'POWERUNIT', IFCPRESSUREMEASURE: 'PRESSUREUNIT',
  IFCFREQUENCYMEASURE: 'FREQUENCYUNIT', IFCELECTRICCURRENTMEASURE: 'ELECTRICCURRENTUNIT', IFCELECTRICVOLTAGEMEASURE: 'ELECTRICVOLTAGEUNIT',
  IFCLUMINOUSFLUXMEASURE: 'LUMINOUSFLUXUNIT', IFCILLUMINANCEMEASURE: 'ILLUMINANCEUNIT', IFCVOLUMETRICFLOWRATEMEASURE: 'VOLUMETRICFLOWRATEUNIT',
  IFCLINEARVELOCITYMEASURE: 'LINEARVELOCITYUNIT', IFCTHERMODYNAMICTEMPERATUREMEASURE: 'THERMODYNAMICTEMPERATUREUNIT',
};
const QUANTITY_VALUES: Record<string, [string, string]> = {
  IfcQuantityLength: ['LengthValue', 'LENGTHUNIT'], IfcQuantityArea: ['AreaValue', 'AREAUNIT'], IfcQuantityVolume: ['VolumeValue', 'VOLUMEUNIT'],
  IfcQuantityWeight: ['WeightValue', 'MASSUNIT'], IfcQuantityTime: ['TimeValue', 'TIMEUNIT'], IfcQuantityCount: ['CountValue', ''], IfcQuantityNumber: ['NumberValue', ''],
};

const formatNumber = (v: number) =>
  (Math.abs(v) >= 1 || v === 0 ? v.toLocaleString('en-US', { maximumFractionDigits: 4 }) : v.toLocaleString('en-US', { maximumSignificantDigits: 6 })).replace(/^-/, '−');

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

// ---- Geometry accumulation -------------------------------------------------------------------------------------

/** Typed array that grows as it is filled. */
class Growable<T extends Float32Array | Uint32Array> {
  data: T;
  length = 0;
  constructor(private readonly make: (n: number) => T) {
    this.data = make(1024);
  }

  /** Makes room for `n` more values and returns the array to write them into, from `length` on. */
  reserve(n: number): T {
    if (this.length + n > this.data.length) {
      const next = this.make(Math.max(this.data.length * 2, this.length + n));
      next.set(this.data.subarray(0, this.length));
      this.data = next;
    }
    return this.data;
  }
}

/** Everything of one material within a bucket. */
interface Part {
  position: Growable<Float32Array>;
  normal: Growable<Float32Array>;
  index: Growable<Uint32Array>;
  /** Product record, first index, index count. */
  chunks: number[];
}

interface BucketBuilder {
  name: string;
  origin: [number, number, number];
  parts: Map<number, Part>;
  triangles: number;
  /** Feature edges as segments, and per element: product record, first vertex, vertex count. */
  edges: Growable<Float32Array>;
  edgeChunks: number[];
}

/** Angle between faces from which their common edge is drawn, as mountScene's own edges. */
const EDGE_ANGLE = 25;
const EDGE_COS = Math.cos((EDGE_ANGLE * Math.PI) / 180);

/**
 * Sharp and open edges of a triangle mesh (stride 6: position, normal) as segments, like three's EdgesGeometry but
 * with hash tables of numbers instead of strings, about ten times faster. Vertices closer than 1e-4 are welded.
 */
function featureEdges(vertices: ArrayLike<number>, indices: ArrayLike<number>): Float32Array {
  const n = vertices.length / 6;
  let size = 2;
  while (size < n * 2) size <<= 1;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const grid = new Float64Array(n * 3);
  const weld = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const x = Math.round(vertices[i * 6] * 1e4);
    const y = Math.round(vertices[i * 6 + 1] * 1e4);
    const z = Math.round(vertices[i * 6 + 2] * 1e4);
    grid[i * 3] = x;
    grid[i * 3 + 1] = y;
    grid[i * 3 + 2] = z;
    for (let h = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(z | 0, 83492791)) & mask; ; h = (h + 1) & mask) {
      const j = table[h];
      if (j === -1) {
        table[h] = i;
        weld[i] = i;
        break;
      }
      if (grid[j * 3] === x && grid[j * 3 + 1] === y && grid[j * 3 + 2] === z) {
        weld[i] = j;
        break;
      }
    }
  }
  const triangles = indices.length / 3;
  let edgeSize = 2;
  while (edgeSize < triangles * 6) edgeSize <<= 1;
  const edgeMask = edgeSize - 1;
  const edgeTable = new Int32Array(edgeSize).fill(-1);
  const from = new Int32Array(triangles * 3);
  const to = new Int32Array(triangles * 3);
  /** The first face of each edge, or −1 once a second one was seen. */
  const face = new Int32Array(triangles * 3);
  const normals = new Float64Array(triangles * 3);
  let edges = 0;
  const out: number[] = [];
  const emit = (a: number, b: number) =>
    out.push(vertices[a * 6], vertices[a * 6 + 1], vertices[a * 6 + 2], vertices[b * 6], vertices[b * 6 + 1], vertices[b * 6 + 2]);
  for (let t = 0; t < triangles; t++) {
    const corners = [weld[indices[t * 3]], weld[indices[t * 3 + 1]], weld[indices[t * 3 + 2]]];
    const [a, b, c] = corners;
    if (a === b || b === c || c === a) continue;
    const ux = vertices[b * 6] - vertices[a * 6];
    const uy = vertices[b * 6 + 1] - vertices[a * 6 + 1];
    const uz = vertices[b * 6 + 2] - vertices[a * 6 + 2];
    const vx = vertices[c * 6] - vertices[a * 6];
    const vy = vertices[c * 6 + 1] - vertices[a * 6 + 1];
    const vz = vertices[c * 6 + 2] - vertices[a * 6 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    normals[t * 3] = nx / length;
    normals[t * 3 + 1] = ny / length;
    normals[t * 3 + 2] = nz / length;
    for (let k = 0; k < 3; k++) {
      const p = corners[k];
      const q = corners[(k + 1) % 3];
      const u = p < q ? p : q;
      const v = p < q ? q : p;
      for (let h = (Math.imul(u, 73856093) ^ Math.imul(v, 19349663)) & edgeMask; ; h = (h + 1) & edgeMask) {
        const e = edgeTable[h];
        if (e === -1) {
          edgeTable[h] = edges;
          from[edges] = u;
          to[edges] = v;
          face[edges++] = t;
          break;
        }
        if (from[e] === u && to[e] === v) {
          const f = face[e];
          if (f >= 0) {
            const dot = normals[f * 3] * normals[t * 3] + normals[f * 3 + 1] * normals[t * 3 + 1] + normals[f * 3 + 2] * normals[t * 3 + 2];
            if (dot <= EDGE_COS) emit(u, v);
            face[e] = -1;
          }
          break;
        }
      }
    }
  }
  // Edges of a single face: the outline of open surfaces.
  for (let e = 0; e < edges; e++) if (face[e] >= 0) emit(from[e], to[e]);
  return Float32Array.from(out);
}

/** A product: spatial container or element. */
interface Product {
  id: number;
  record: number;
  ifcClass: string;
  hasGeometry: boolean;
}

export class IfcReader {
  private readonly classNames = new Map<number, string>();
  private readonly unitSymbols = new Map<string, string>();
  /** Express ID of a unit → its symbol. */
  private readonly unitById = new Map<number, string>();
  private lengthUnit = { unit: 'mm', perMetre: 1000 };
  // Relationships, by express ID.
  private readonly parentOf = new Map<number, number>();
  private readonly childrenOf = new Map<number, number[]>();
  private readonly containedIn = new Map<number, number>();
  private readonly containerChildren = new Map<number, number[]>();
  private readonly hostOf = new Map<number, number>();
  private readonly spatial = new Set<number>();
  private relationsForProperties: { psets: Map<number, number[]>; type: Map<number, number>; material: Map<number, number> } | null = null;

  constructor(private readonly api: IfcAPI, private readonly model: number) {}

  private className(typeCode: number): string {
    let name = this.classNames.get(typeCode);
    if (name === undefined) {
      name = this.api.GetNameFromTypeCode(typeCode) || 'IfcProduct';
      this.classNames.set(typeCode, name);
    }
    return name;
  }

  private classOf(id: number): string {
    return this.className(this.api.GetLineType(this.model, id));
  }

  private ids(type: number): number[] {
    const vector = this.api.GetLineIDsWithType(this.model, type);
    const list: number[] = [];
    for (let i = 0; i < vector.size(); i++) list.push(vector.get(i));
    return list;
  }

  private raw(ids: number[]): RawLine[] {
    const lines: RawLine[] = [];
    for (let i = 0; i < ids.length; i += 4096) lines.push(...(this.api.GetRawLinesData(this.model, ids.slice(i, i + 4096)) as RawLine[]));
    return lines;
  }

  private line(id: number): Record<string, any> | null {
    try {
      return id ? this.api.GetLine(this.model, id) : null;
    } catch {
      return null;
    }
  }

  // ---- Header and units ------------------------------------------------------------------------------------------

  private header(): { schema: string; application: string } {
    const schemaLine = this.api.GetHeaderLine(this.model, FILE_SCHEMA);
    const schema = text((schemaLine?.arguments?.[0] as unknown[] | undefined)?.[0]) || this.api.GetModelSchema(this.model);
    let application = '';
    const [appId] = this.ids(IFCAPPLICATION);
    if (appId) {
      const [, version, fullName] = this.raw([appId])[0]?.arguments ?? [];
      const name = text(fullName);
      const v = text(version);
      application = name && v && !name.includes(v) ? `${name} ${v}` : name;
    }
    if (!application) {
      const args = this.api.GetHeaderLine(this.model, FILE_NAME)?.arguments ?? [];
      application = text(args[5]) || text(args[4]);
    }
    return { schema: schema.toUpperCase(), application: application.trim() };
  }

  private unitSymbol(id: number): string {
    const known = this.unitById.get(id);
    if (known !== undefined) return known;
    const unit = this.line(id);
    let symbol = '';
    const cls = unit ? this.className(unit.type) : '';
    if (cls === 'IfcSIUnit') {
      symbol = `${PREFIXES[text(unit!.Prefix)] ?? ''}${SI_NAMES[text(unit!.Name)] ?? text(unit!.Name).toLowerCase()}`;
    } else if (cls.startsWith('IfcConversionBasedUnit')) {
      const name = text(unit!.Name).toUpperCase().replace(/_/g, ' ').trim();
      symbol = CONVERTED_NAMES[name] ?? CONVERTED_NAMES[name.replace(/S$/, '')] ?? name.toLowerCase();
    } else if (cls === 'IfcDerivedUnit') {
      symbol = text(unit!.UserDefinedType) || DEFAULT_UNITS[text(unit!.UnitType)] || '';
    } else if (cls === 'IfcContextDependentUnit') {
      symbol = text(unit!.Name).toLowerCase();
    }
    this.unitById.set(id, symbol);
    return symbol;
  }

  private readUnits(project: number): void {
    const assignment = this.line(ref(this.line(project)?.UnitsInContext));
    for (const id of refs(assignment?.Units)) {
      const unit = this.line(id);
      const type = text(unit?.UnitType);
      if (!type) continue;
      this.unitSymbols.set(type, this.unitSymbol(id));
      if (type === 'LENGTHUNIT' && this.className(unit!.type).startsWith('IfcConversionBasedUnit')) {
        // web-ifc hands out metres; imperial files keep their own unit.
        const symbol = this.unitSymbol(id);
        if (symbol === 'ft') this.lengthUnit = { unit: 'ft', perMetre: 1 / 0.3048 };
        else if (symbol === 'in') this.lengthUnit = { unit: 'in', perMetre: 1 / 0.0254 };
      }
    }
  }

  // ---- Structure ---------------------------------------------------------------------------------------------

  private readRelations(): void {
    const decompose = (type: number) => {
      for (const rel of this.raw(this.ids(type))) {
        const parent = ref(rel.arguments[4]);
        for (const child of refs(rel.arguments[5])) {
          if (this.parentOf.has(child)) continue;
          this.parentOf.set(child, parent);
          const list = this.childrenOf.get(parent);
          if (list) list.push(child);
          else this.childrenOf.set(parent, [child]);
        }
      }
    };
    decompose(IFCRELAGGREGATES);
    decompose(IFCRELNESTS);
    for (const rel of this.raw(this.ids(IFCRELCONTAINEDINSPATIALSTRUCTURE))) {
      const container = ref(rel.arguments[5]);
      for (const element of refs(rel.arguments[4])) {
        if (this.containedIn.has(element)) continue;
        this.containedIn.set(element, container);
        const list = this.containerChildren.get(container);
        if (list) list.push(element);
        else this.containerChildren.set(container, [element]);
      }
    }
    // Openings belong where the element they cut belongs; windows and doors where their opening does.
    for (const rel of this.raw(this.ids(IFCRELVOIDSELEMENT))) this.hostOf.set(ref(rel.arguments[5]), ref(rel.arguments[4]));
    for (const rel of this.raw(this.ids(IFCRELFILLSELEMENT))) {
      const filling = ref(rel.arguments[5]);
      if (!this.hostOf.has(filling)) this.hostOf.set(filling, ref(rel.arguments[4]));
    }
  }

  /** Spatial containers below the project, following the aggregation from the top. */
  private findSpatial(projects: number[]): void {
    const queue = [...projects];
    for (const id of queue) {
      this.spatial.add(id);
      for (const child of this.childrenOf.get(id) ?? []) {
        if (!this.spatial.has(child) && SPATIAL.test(this.classOf(child))) queue.push(child);
      }
    }
  }

  /** The element an element is a part of (aggregation, nesting), if any. */
  private elementParent(id: number): number {
    const parent = this.parentOf.get(id) ?? 0;
    return parent && !this.spatial.has(parent) ? parent : 0;
  }

  private readonly containerCache = new Map<number, number>();
  /** Spatial container of a product: where it is contained, or where its whole, host or opening is. 0 if none. */
  private containerOf(id: number, depth = 0): number {
    const cached = this.containerCache.get(id);
    if (cached !== undefined) return cached;
    let container = 0;
    if (depth < 64) {
      const contained = this.containedIn.get(id);
      const parent = this.parentOf.get(id);
      if (contained) container = this.spatial.has(contained) ? contained : this.containerOf(contained, depth + 1);
      else if (parent) container = this.spatial.has(parent) ? parent : this.containerOf(parent, depth + 1);
      else if (this.hostOf.has(id)) container = this.containerOf(this.hostOf.get(id)!, depth + 1);
    }
    this.containerCache.set(id, container);
    return container;
  }

  /** Top-level element of a part (a stair for its flight); the element itself if it is none. */
  private topElement(id: number): number {
    for (let depth = 0; depth < 64; depth++) {
      const parent = this.elementParent(id);
      if (!parent) break;
      id = parent;
    }
    return id;
  }

  // ---- Model ---------------------------------------------------------------------------------------------------

  readModel(progress: (message: string, fraction?: number) => void): { model: IfcModel; transfer: ArrayBuffer[] } {
    const api = this.api;
    const { schema, application } = this.header();
    const projects = this.ids(IFCPROJECT);
    if (projects.length) this.readUnits(projects[0]);
    this.readRelations();
    this.findSpatial(projects.slice(0, 1));

    // ---- Products, numbered in the order they are met ----
    const products: Product[] = [];
    const productOf = new Map<number, Product>();
    const product = (id: number): Product => {
      let p = productOf.get(id);
      if (!p) {
        p = { id, record: products.length, ifcClass: this.classOf(id), hasGeometry: false };
        products.push(p);
        productOf.set(id, p);
      }
      return p;
    };
    // Bounding boxes per product record, in doubles: a box far from the origin must stay exact.
    let boxData = new Float64Array(6 * 1024).fill(NaN);
    const boxOf = (record: number): Float64Array => {
      if (boxData.length < (record + 1) * 6) {
        const next = new Float64Array(Math.max(boxData.length * 2, (record + 1) * 6)).fill(NaN);
        next.set(boxData);
        boxData = next;
      }
      return boxData;
    };

    // ---- Geometry, merged per storey and class ----
    const materials: IfcMaterial[] = [];
    const materialIndex = new Map<string, number>();
    const materialOf = (m: IfcMaterial) => {
      const key = `${m.color.map((c) => Math.round(c * 255)).join(',')},${Math.round(m.opacity * 255)}`;
      let index = materialIndex.get(key);
      if (index === undefined) {
        index = materials.push(m) - 1;
        materialIndex.set(key, index);
      }
      return index;
    };
    const buckets: BucketBuilder[] = [];
    const openBuckets = new Map<string, BucketBuilder>();
    const { perMetre } = this.lengthUnit;
    const seen = new Set<number>();
    /** Edges per shared geometry (windows, furniture and other repeated items), in its own coordinates. */
    const edgeCache = new Map<number, Float32Array>();
    let lastProgress = 0;

    const addMesh = (mesh: FlatMesh) => {
      const id = mesh.expressID;
      // A copy of the C++ list, which JavaScript has to free.
      const geometries = mesh.geometries as FlatMesh['geometries'] & { delete(): void };
      try {
        if (!seen.has(id)) addGeometries(id, geometries);
      } finally {
        geometries.delete();
      }
      seen.add(id);
      const now = Date.now();
      if (now - lastProgress > 150) {
        lastProgress = now;
        progress(`Computing geometry … ${seen.size.toLocaleString('en-US')} elements`);
      }
    };

    const addGeometries = (id: number, geometries: FlatMesh['geometries']) => {
      const p = product(id);
      const top = this.topElement(id);
      const isOpening = /^IfcOpening/i.test(p.ifcClass);
      const groupClass = isOpening ? p.ifcClass : this.classOf(top);
      const container = this.containerOf(id);
      const key = `${container}|${groupClass}`;
      let bucket = openBuckets.get(key);
      if (!bucket || bucket.triangles > BUCKET_TRIANGLES) {
        bucket = { name: groupClass, origin: [NaN, NaN, NaN], parts: new Map(), triangles: 0, edges: new Growable((k) => new Float32Array(k)), edgeChunks: [] };
        buckets.push(bucket);
        openBuckets.set(key, bucket);
      }
      let [minX, minY, minZ, maxX, maxY, maxZ] = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
      const edgeStart = bucket.edges.length / 3;

      for (let g = 0; g < geometries.size(); g++) {
        const placed = geometries.get(g);
        const geometry = api.GetGeometry(this.model, placed.geometryExpressID);
        // Views into the WebAssembly memory: used up before the next call into web-ifc.
        const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
        const indices = api.GetIndexArray(geometry.GetIndexData(), geometry.GetIndexDataSize());
        if (vertices.length === 0 || indices.length === 0) {
          geometry.delete();
          continue;
        }
        let material: IfcMaterial = { color: [placed.color.x, placed.color.y, placed.color.z], opacity: placed.color.w };
        if (isOpening) material = OPENING_COLOR;
        else if (p.ifcClass === 'IfcSpace' && material.opacity > 0.99) material = { color: SPACE_COLOR.color, opacity: SPACE_COLOR.opacity };
        const m = placed.flatTransformation;
        // web-ifc places geometry in metres with Y up; back to the file's Z up, in the display unit.
        const s = perMetre;
        const a = [s * m[0], s * m[4], s * m[8], s * m[12], -s * m[2], -s * m[6], -s * m[10], -s * m[14], s * m[1], s * m[5], s * m[9], s * m[13]];
        if (Number.isNaN(bucket.origin[0])) bucket.origin = [a[3], a[7], a[11]];
        const [ox, oy, oz] = bucket.origin;
        // Normals turn with the placement only; mirrored placements reverse the winding.
        const n = [m[0], m[4], m[8], -m[2], -m[6], -m[10], m[1], m[5], m[9]];
        const det = n[0] * (n[4] * n[8] - n[5] * n[7]) - n[1] * (n[3] * n[8] - n[5] * n[6]) + n[2] * (n[3] * n[7] - n[4] * n[6]);

        const materialNumber = materialOf(material);
        let part: Part | undefined = bucket.parts.get(materialNumber);
        if (!part) {
          part = {
            position: new Growable((k) => new Float32Array(k)),
            normal: new Growable((k) => new Float32Array(k)),
            index: new Growable((k) => new Uint32Array(k)),
            chunks: [],
          };
          bucket.parts.set(materialNumber, part);
        }
        const count = vertices.length / 6;
        const base = part.position.length / 3;
        const pos = part.position.reserve(count * 3);
        const nor = part.normal.reserve(count * 3);
        let w = part.position.length;
        for (let v = 0; v < vertices.length; v += 6, w += 3) {
          const x = vertices[v];
          const y = vertices[v + 1];
          const z = vertices[v + 2];
          const px = a[0] * x + a[1] * y + a[2] * z + a[3];
          const py = a[4] * x + a[5] * y + a[6] * z + a[7];
          const pz = a[8] * x + a[9] * y + a[10] * z + a[11];
          if (px < minX) minX = px;
          if (px > maxX) maxX = px;
          if (py < minY) minY = py;
          if (py > maxY) maxY = py;
          if (pz < minZ) minZ = pz;
          if (pz > maxZ) maxZ = pz;
          pos[w] = px - ox;
          pos[w + 1] = py - oy;
          pos[w + 2] = pz - oz;
          const nx = vertices[v + 3];
          const ny = vertices[v + 4];
          const nz = vertices[v + 5];
          const qx = n[0] * nx + n[1] * ny + n[2] * nz;
          const qy = n[3] * nx + n[4] * ny + n[5] * nz;
          const qz = n[6] * nx + n[7] * ny + n[8] * nz;
          const len = Math.hypot(qx, qy, qz) || 1;
          nor[w] = qx / len;
          nor[w + 1] = qy / len;
          nor[w + 2] = qz / len;
        }
        part.position.length = w;
        part.normal.length = w;
        const first = part.index.length;
        const idx = part.index.reserve(indices.length);
        const flip = det < 0;
        for (let i = 0; i < indices.length; i += 3) {
          idx[first + i] = base + indices[i];
          idx[first + i + 1] = base + indices[flip ? i + 2 : i + 1];
          idx[first + i + 2] = base + indices[flip ? i + 1 : i + 2];
        }
        part.index.length = first + indices.length;
        bucket.triangles += indices.length / 3;

        let segments = edgeCache.get(placed.geometryExpressID);
        if (!segments) {
          segments = featureEdges(vertices, indices);
          edgeCache.set(placed.geometryExpressID, segments);
        }
        const edges = bucket.edges.reserve(segments.length);
        let e = bucket.edges.length;
        for (let k = 0; k < segments.length; k += 3, e += 3) {
          const x = segments[k];
          const y = segments[k + 1];
          const z = segments[k + 2];
          edges[e] = a[0] * x + a[1] * y + a[2] * z + a[3] - ox;
          edges[e + 1] = a[4] * x + a[5] * y + a[6] * z + a[7] - oy;
          edges[e + 2] = a[8] * x + a[9] * y + a[10] * z + a[11] - oz;
        }
        bucket.edges.length = e;
        const chunks: number[] = part.chunks;
        const last = chunks.length - 3;
        if (last >= 0 && chunks[last] === p.record && chunks[last + 1] + chunks[last + 2] === first) chunks[last + 2] += indices.length;
        else chunks.push(p.record, first, indices.length);
        geometry.delete();
      }
      const edgeEnd = bucket.edges.length / 3;
      if (edgeEnd > edgeStart) bucket.edgeChunks.push(p.record, edgeStart, edgeEnd - edgeStart);
      if (minX <= maxX) {
        p.hasGeometry = true;
        boxOf(p.record).set([minX, minY, minZ, maxX, maxY, maxZ], p.record * 6);
      }
    };

    progress('Computing geometry …');
    // web-ifc's own count restarts with every IFC class, so progress is a running number.
    api.StreamAllMeshes(this.model, addMesh);
    // StreamAllMeshes leaves out spaces and openings (and site terrain); they are there to be shown on demand.
    api.StreamAllMeshesWithTypes(this.model, [IFCSPACE, IFCOPENINGELEMENT, IFCOPENINGSTANDARDCASE, IFCSITE], addMesh);

    // ---- Tree ----
    progress('Reading the building structure …');
    // Every contained element, every part of a known product, and the wholes of parts become products.
    for (const id of this.spatial) product(id);
    for (const ids of this.containerChildren.values()) for (const id of ids) product(id);
    for (let i = 0; i < products.length; i++) {
      const id = products[i].id;
      for (const child of this.childrenOf.get(id) ?? []) product(child);
      const parent = this.parentOf.get(id);
      if (parent && !productOf.has(parent) && products[i].hasGeometry) product(parent);
    }
    const lines = new Map<number, unknown[]>();
    for (const line of this.raw(products.map((p) => p.id))) lines.set(line.ID, line.arguments);
    const nameOf = (p: Product): string => {
      const args = lines.get(p.id) ?? [];
      const name = text(args[2]).trim();
      if (p.ifcClass === 'IfcProject') return name || text(args[5]).trim() || 'Project';
      if (this.spatial.has(p.id) || p.ifcClass === 'IfcSpace') {
        const long = text(args[7]).trim();
        return [name, long].filter((s, i, all) => s && all.indexOf(s) === i).join(' · ') || p.ifcClass;
      }
      return name || `${p.ifcClass} #${p.id}`;
    };
    const elevationOf = (id: number) => {
      const value = Number(text(lines.get(id)?.[9]));
      return Number.isFinite(value) ? value : NaN;
    };

    const elementNode = (p: Product, depth: number): IfcTreeNode | null => {
      const children = depth < 32 ? (this.childrenOf.get(p.id) ?? []).flatMap((c) => {
        const child = productOf.get(c);
        const node = child && !this.spatial.has(c) ? elementNode(child, depth + 1) : null;
        return node ? [node] : [];
      }) : [];
      // Elements without geometry or parts (ports, annotations) only clutter the tree.
      if (!p.hasGeometry && children.length === 0) return null;
      children.sort((x, y) => collator.compare(x.name, y.name));
      return { kind: 'element', id: p.id, ifcClass: p.ifcClass, name: nameOf(p), children, first: 0, count: 0 };
    };

    /** The top-level elements of a container, one group per IFC class. */
    const groups = (elements: Product[]): IfcTreeNode[] => {
      const byClass = new Map<string, IfcTreeNode[]>();
      for (const p of elements) {
        const node = elementNode(p, 0);
        if (!node) continue;
        const list = byClass.get(p.ifcClass);
        if (list) list.push(node);
        else byClass.set(p.ifcClass, [node]);
      }
      return [...byClass.entries()]
        .sort(([a], [b]) => collator.compare(a, b))
        .map(([ifcClass, nodes]) => {
          nodes.sort((x, y) => collator.compare(x.name, y.name));
          return { kind: 'group' as const, id: 0, ifcClass, name: ifcClass, children: nodes, first: 0, count: 0 };
        });
    };

    const topLevel = new Map<number, Product[]>();
    for (const p of products) {
      if (this.spatial.has(p.id) || this.elementParent(p.id)) continue;
      const container = this.containerOf(p.id);
      const list = topLevel.get(container);
      if (list) list.push(p);
      else topLevel.set(container, [p]);
    }

    const spatialNode = (id: number, depth: number): IfcTreeNode => {
      const p = product(id);
      const subs = (this.childrenOf.get(id) ?? []).filter((c) => this.spatial.has(c) && depth < 32).map((c) => spatialNode(c, depth + 1));
      if (subs.length > 1 && subs.every((s) => s.ifcClass === 'IfcBuildingStorey' && !Number.isNaN(elevationOf(s.id)))) {
        subs.sort((x, y) => elevationOf(x.id) - elevationOf(y.id));
      }
      return { kind: 'spatial', id, ifcClass: p.ifcClass, name: nameOf(p), children: [...subs, ...groups(topLevel.get(id) ?? [])], first: 0, count: 0 };
    };

    const roots: IfcTreeNode[] = projects.length ? [spatialNode(projects[0], 0)] : [];
    const orphans = groups(topLevel.get(0) ?? []);
    let root: IfcTreeNode;
    if (roots.length && !orphans.length) root = roots[0];
    else if (roots.length) {
      root = roots[0];
      root.children.push({ kind: 'group', id: 0, ifcClass: '', name: 'Not in the spatial structure', children: orphans, first: 0, count: 0 });
    } else {
      root = { kind: 'group', id: 0, ifcClass: '', name: 'Model', children: orphans, first: 0, count: 0 };
    }

    // ---- Numbering in tree order ----
    const elementOfRecord = new Int32Array(products.length).fill(-1);
    const order: Product[] = [];
    const number = (node: IfcTreeNode) => {
      node.first = order.length;
      if (node.kind !== 'group') {
        const p = productOf.get(node.id)!;
        elementOfRecord[p.record] = order.length;
        order.push(p);
      }
      for (const child of node.children) number(child);
      node.count = order.length - node.first;
    };
    number(root);
    // Geometry the structure does not reach (broken or cyclic relationships) still gets a place in the tree.
    const unreached = products.filter((p) => p.hasGeometry && elementOfRecord[p.record] < 0);
    if (unreached.length) {
      const extra = groups(unreached);
      for (const group of extra) for (const node of group.children) node.children = [];
      const node: IfcTreeNode = { kind: 'group', id: 0, ifcClass: '', name: 'Not in the spatial structure', children: extra, first: 0, count: 0 };
      root.children.push(node);
      number(node);
      root.count = order.length - root.first;
    }

    const classes: string[] = [];
    const classIndex = new Map<string, number>();
    const ids = new Uint32Array(order.length);
    const classOf = new Uint16Array(order.length);
    const elementBoxes = new Float64Array(order.length * 6).fill(NaN);
    order.forEach((p, i) => {
      ids[i] = p.id;
      let c = classIndex.get(p.ifcClass);
      if (c === undefined) {
        c = classes.push(p.ifcClass) - 1;
        classIndex.set(p.ifcClass, c);
      }
      classOf[i] = c;
      if (p.hasGeometry && boxData.length >= (p.record + 1) * 6) elementBoxes.set(boxData.subarray(p.record * 6, p.record * 6 + 6), i * 6);
    });

    // ---- Buckets: materials one after another, centered on their own middle ----
    const transfer: ArrayBuffer[] = [];
    const result: IfcBucket[] = [];
    for (const bucket of buckets) {
      let vertexCount = 0;
      let indexCount = 0;
      for (const part of bucket.parts.values()) {
        vertexCount += part.position.length / 3;
        indexCount += part.index.length;
      }
      if (indexCount === 0) continue;
      const position = new Float32Array(vertexCount * 3);
      const normal = new Float32Array(vertexCount * 3);
      const index = new Uint32Array(indexCount);
      const groupList: number[] = [];
      const chunkList: number[] = [];
      let v = 0;
      let i = 0;
      for (const [materialNumber, part] of bucket.parts) {
        position.set(part.position.data.subarray(0, part.position.length), v * 3);
        normal.set(part.normal.data.subarray(0, part.normal.length), v * 3);
        const source = part.index.data;
        for (let k = 0; k < part.index.length; k++) index[i + k] = source[k] + v;
        groupList.push(i, part.index.length, materialNumber);
        for (let c = 0; c < part.chunks.length; c += 3) chunkList.push(elementOfRecord[part.chunks[c]], part.chunks[c + 1] + i, part.chunks[c + 2]);
        v += part.position.length / 3;
        i += part.index.length;
      }
      // Center the vertices: the mesh position then marks its middle, which also sorts transparent meshes well.
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let k = 0; k < position.length; k += 3) {
        for (let axis = 0; axis < 3; axis++) {
          const value = position[k + axis];
          if (value < lo[axis]) lo[axis] = value;
          if (value > hi[axis]) hi[axis] = value;
        }
      }
      const center = lo.map((l, axis) => Math.fround((l + hi[axis]) / 2));
      for (let k = 0; k < position.length; k += 3) {
        position[k] -= center[0];
        position[k + 1] -= center[1];
        position[k + 2] -= center[2];
      }
      const edges = bucket.edges.data.slice(0, bucket.edges.length);
      for (let k = 0; k < edges.length; k += 3) {
        edges[k] -= center[0];
        edges[k + 1] -= center[1];
        edges[k + 2] -= center[2];
      }
      const origin: [number, number, number] = [bucket.origin[0] + center[0], bucket.origin[1] + center[1], bucket.origin[2] + center[2]];
      const groupsArray = Uint32Array.from(groupList);
      const chunksArray = Uint32Array.from(chunkList);
      const edgeChunks = Uint32Array.from(bucket.edgeChunks, (v, k) => (k % 3 === 0 ? elementOfRecord[v] : v));
      result.push({ name: bucket.name, origin, position, normal, index, groups: groupsArray, chunks: chunksArray, edges, edgeChunks });
      transfer.push(position.buffer, normal.buffer, index.buffer, groupsArray.buffer, chunksArray.buffer, edges.buffer, edgeChunks.buffer);
    }
    transfer.push(ids.buffer, classOf.buffer, elementBoxes.buffer);
    const model: IfcModel = {
      schema,
      application,
      unit: this.lengthUnit.unit,
      root,
      ids,
      classOf,
      classes,
      boxes: elementBoxes,
      materials,
      buckets: result,
    };
    return { model, transfer };
  }

  // ---- Properties ----------------------------------------------------------------------------------------------

  private propertyRelations() {
    if (this.relationsForProperties) return this.relationsForProperties;
    const psets = new Map<number, number[]>();
    for (const rel of this.raw(this.ids(IFCRELDEFINESBYPROPERTIES))) {
      // IFC4 allows a set of property sets here.
      const definitions = refs(rel.arguments[5]);
      for (const object of refs(rel.arguments[4])) {
        const list = psets.get(object);
        if (list) list.push(...definitions);
        else psets.set(object, [...definitions]);
      }
    }
    const type = new Map<number, number>();
    for (const rel of this.raw(this.ids(IFCRELDEFINESBYTYPE))) for (const object of refs(rel.arguments[4])) type.set(object, ref(rel.arguments[5]));
    const material = new Map<number, number>();
    for (const rel of this.raw(this.ids(IFCRELASSOCIATESMATERIAL))) for (const object of refs(rel.arguments[4])) material.set(object, ref(rel.arguments[5]));
    this.relationsForProperties = { psets, type, material };
    return this.relationsForProperties;
  }

  /** A property or quantity value as text, with its unit. */
  private format(value: unknown, unitType = '', unitRef = 0): string {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map((v) => this.format(v, unitType, unitRef)).filter(Boolean).join(', ');
    if (typeof value !== 'object') return typeof value === 'number' ? formatNumber(value) : String(value);
    const v = value as { type?: number; name?: string; value?: unknown };
    if (v.type === 5) return this.nameOf(Number(v.value));
    const measure = (v.name ?? '').toUpperCase();
    const raw = v.value;
    if (typeof raw === 'boolean') return raw ? 'Yes' : 'No';
    if (measure === 'IFCLOGICAL' || measure === 'IFCBOOLEAN') {
      if (raw === 'T' || raw === 1 || raw === 'TRUE') return 'Yes';
      if (raw === 'F' || raw === 0 || raw === 'FALSE') return 'No';
      return 'Unknown';
    }
    const number = typeof raw === 'number' ? raw : typeof raw === 'string' && measure.endsWith('MEASURE') && raw.trim() !== '' ? Number(raw) : NaN;
    if (!Number.isNaN(number)) {
      const kind = unitType || MEASURE_UNITS[measure] || '';
      let symbol = unitRef ? this.unitSymbol(unitRef) : kind ? (this.unitSymbols.get(kind) ?? DEFAULT_UNITS[kind] ?? '') : '';
      let shown = number;
      if (kind === 'PLANEANGLEUNIT' && (symbol === 'rad' || symbol === '')) {
        shown = (number * 180) / Math.PI;
        symbol = '°';
      }
      return `${formatNumber(shown)}${symbol ? (symbol === '°' ? symbol : ` ${symbol}`) : ''}`;
    }
    return raw === null || raw === undefined ? '' : String(raw);
  }

  private nameOf(id: number): string {
    const line = this.line(id);
    if (!line) return `#${id}`;
    return text(line.Name) || `${this.className(line.type)} #${id}`;
  }

  /** Rows of one property (complex properties nest theirs under their name). */
  private propertyRows(id: number, prefix: string, depth = 0): [string, string][] {
    const p = this.line(id);
    if (!p) return [];
    const cls = this.className(p.type);
    const name = `${prefix}${text(p.Name)}`;
    const unit = ref(p.Unit);
    switch (cls) {
      case 'IfcPropertySingleValue':
        return [[name, this.format(p.NominalValue, '', unit)]];
      case 'IfcPropertyEnumeratedValue':
        return [[name, this.format(p.EnumerationValues)]];
      case 'IfcPropertyListValue':
        return [[name, this.format(p.ListValues, '', unit)]];
      case 'IfcPropertyBoundedValue': {
        const lower = this.format(p.LowerBoundValue, '', unit);
        const upper = this.format(p.UpperBoundValue, '', unit);
        const set = this.format(p.SetPointValue, '', unit);
        return [[name, [lower || upper ? `${lower || '…'} – ${upper || '…'}` : '', set ? `set point ${set}` : ''].filter(Boolean).join(', ')]];
      }
      case 'IfcPropertyTableValue': {
        const defining = (p.DefiningValues ?? []) as unknown[];
        const defined = (p.DefinedValues ?? []) as unknown[];
        return [[name, defining.map((d, i) => `${this.format(d)} → ${this.format(defined[i])}`).join('; ')]];
      }
      case 'IfcPropertyReferenceValue':
        return [[name, ref(p.PropertyReference) ? this.nameOf(ref(p.PropertyReference)) : '']];
      case 'IfcComplexProperty':
        return depth < 8 ? refs(p.HasProperties).flatMap((child) => this.propertyRows(child, `${name} / `, depth + 1)) : [];
      default:
        return [[name, '']];
    }
  }

  private quantityRows(id: number, prefix: string, depth = 0): [string, string][] {
    const q = this.line(id);
    if (!q) return [];
    const cls = this.className(q.type);
    const name = `${prefix}${text(q.Name)}`;
    if (cls === 'IfcPhysicalComplexQuantity') {
      return depth < 8 ? refs(q.HasQuantities).flatMap((child) => this.quantityRows(child, `${name} / `, depth + 1)) : [];
    }
    const [field, unitType] = QUANTITY_VALUES[cls] ?? ['', ''];
    const value = field ? q[field] : null;
    const number = value && typeof value === 'object' ? Number((value as { value: unknown }).value) : Number(value);
    if (!field || Number.isNaN(number)) return [[name, '']];
    const unit = ref(q.Unit);
    const symbol = unit ? this.unitSymbol(unit) : unitType ? (this.unitSymbols.get(unitType) ?? '') : '';
    return [[name, `${formatNumber(number)}${symbol ? ` ${symbol}` : ''}`]];
  }

  /** A property set, quantity set or other property definition as a section. */
  private definitionSection(id: number, suffix = ''): (IfcPropertySection & { quantities?: boolean }) | null {
    const d = this.line(id);
    if (!d) return null;
    const cls = this.className(d.type);
    const title = `${text(d.Name) || cls}${suffix}`;
    if (cls === 'IfcPropertySet') return { title, rows: refs(d.HasProperties).flatMap((p) => this.propertyRows(p, '')) };
    if (cls === 'IfcElementQuantity') return { title, rows: refs(d.Quantities).flatMap((q) => this.quantityRows(q, '')), quantities: true };
    // Predefined property sets (door lining, window panel …): their plain attributes.
    const rows: [string, string][] = [];
    for (const [key, value] of Object.entries(d)) {
      if (['expressID', 'type', 'GlobalId', 'OwnerHistory', 'Name', 'Description'].includes(key) || value === null || value === undefined) continue;
      if (typeof value === 'object' && (value as { type?: number }).type === 5) continue;
      const shown = this.format(value);
      if (shown) rows.push([key, shown]);
    }
    return { title, rows };
  }

  private materialRows(id: number, depth = 0): [string, string][] {
    const m = this.line(id);
    if (!m || depth > 4) return [];
    const cls = this.className(m.type);
    const length = (v: unknown) => this.format(v, 'LENGTHUNIT');
    switch (cls) {
      case 'IfcMaterial':
        return [[text(m.Name) || 'Material', text(m.Category)]];
      case 'IfcMaterialLayerSetUsage':
        return this.materialRows(ref(m.ForLayerSet), depth + 1);
      case 'IfcMaterialProfileSetUsage':
      case 'IfcMaterialProfileSetUsageTapering':
        return this.materialRows(ref(m.ForProfileSet), depth + 1);
      case 'IfcMaterialLayerSet':
        return refs(m.MaterialLayers).flatMap((layer) => this.materialRows(layer, depth + 1));
      case 'IfcMaterialLayer':
      case 'IfcMaterialLayerWithOffsets':
        return [[this.nameOf(ref(m.Material)), [text(m.Name), length(m.LayerThickness)].filter(Boolean).join(', ')]];
      case 'IfcMaterialProfileSet':
        return refs(m.MaterialProfiles).flatMap((profile) => this.materialRows(profile, depth + 1));
      case 'IfcMaterialProfile':
      case 'IfcMaterialProfileWithOffsets':
        return [[this.nameOf(ref(m.Material)), [text(m.Name), ref(m.Profile) ? this.nameOf(ref(m.Profile)) : ''].filter(Boolean).join(', ')]];
      case 'IfcMaterialConstituentSet':
        return refs(m.MaterialConstituents).flatMap((c) => this.materialRows(c, depth + 1));
      case 'IfcMaterialConstituent':
        return [[this.nameOf(ref(m.Material)), text(m.Name)]];
      case 'IfcMaterialList':
        return refs(m.Materials).flatMap((material) => this.materialRows(material, depth + 1));
      default:
        return [[text(m.Name) || cls, '']];
    }
  }

  properties(id: number): IfcProperties {
    const element = this.line(id);
    if (!element) throw new Error(`#${id} is missing from the file.`);
    const ifcClass = this.className(element.type);
    const relations = this.propertyRelations();
    const attributes: [string, string][] = [];
    const attribute = (label: string, value: string) => value && attributes.push([label, value]);
    attribute('Name', text(element.Name));
    attribute('Long name', text(element.LongName));
    attribute('IFC class', ifcClass);
    const predefined = text(element.PredefinedType);
    if (predefined && predefined !== 'NOTDEFINED') attribute('Predefined type', predefined);
    attribute('Object type', text(element.ObjectType));
    attribute('Tag', text(element.Tag));
    attribute('Description', text(element.Description));
    attribute('GlobalId', text(element.GlobalId));
    if (element.Elevation) attribute('Elevation', this.format(element.Elevation, 'LENGTHUNIT'));
    if (element.OverallWidth) attribute('Overall width', this.format(element.OverallWidth, 'LENGTHUNIT'));
    if (element.OverallHeight) attribute('Overall height', this.format(element.OverallHeight, 'LENGTHUNIT'));
    const typeId = relations.type.get(id) ?? 0;
    const typeLine = this.line(typeId);
    if (typeLine) attribute('Type', `${text(typeLine.Name) || '(unnamed)'} (${this.className(typeLine.type)})`);
    attribute('Express ID', `#${id}`);

    const sections: IfcPropertySection[] = [{ title: 'Attributes', rows: attributes }];
    type Section = NonNullable<ReturnType<IfcReader['definitionSection']>>;
    const own = (relations.psets.get(id) ?? []).map((d) => this.definitionSection(d)).filter((s): s is Section => s !== null);
    const fromType = refs(typeLine?.HasPropertySets).map((d) => this.definitionSection(d, ' (type)')).filter((s): s is Section => s !== null);
    const byTitle = (x: Section, y: Section) => collator.compare(x.title, y.title);
    // Property sets first, then those of the type, then quantities.
    for (const s of [...own.filter((s) => !s.quantities).sort(byTitle), ...fromType.sort(byTitle), ...own.filter((s) => s.quantities).sort(byTitle)]) {
      sections.push({ title: s.title, rows: s.rows });
    }
    const materialId = relations.material.get(id) ?? relations.material.get(typeId) ?? 0;
    const materials = materialId ? this.materialRows(materialId) : [];
    if (materials.length) sections.push({ title: 'Materials', rows: materials });
    return { id, name: text(element.Name) || text(element.LongName) || ifcClass, ifcClass, sections: sections.filter((s) => s.rows.length) };
  }
}
