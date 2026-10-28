// SPDX-License-Identifier: GPL-3.0-or-later
// Writes samples/cad/small-building.ifc: an IFC4 model of a two-storey building drawn from scratch here, so it can be
// published as CC0-1.0 like the other samples. Project with units (mm, m², m³, kg), site, building, two storeys,
// slabs, a roof, walls with layered materials, openings filled by windows and a door, a column, a beam, rooms
// (IfcSpace), colors via surface styles, property sets with single and enumerated values, and quantity sets.
// Deterministic: fixed time stamps, GlobalIds derived from names. No third-party libraries.
// Usage: node scripts/generate-ifc-samples.mjs
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', 'samples');
const FILE = 'cad/small-building.ifc';
// 2024-01-01T00:00:00Z
const TIMESTAMP = 1704067200;

// ---- STEP writer --------------------------------------------------------------------------------------------

const lines = [];
/** Adds an entity and returns its reference. */
const add = (entity) => {
  lines.push(entity);
  return `#${lines.length}`;
};
/** STEP real: always with a decimal point. */
const real = (v) => {
  const s = Number(v.toPrecision(12)).toString().toUpperCase();
  if (s.includes('E')) return s.includes('.') ? s : s.replace('E', '.E');
  return s.includes('.') ? s : `${s}.`;
};
/** STEP string; characters beyond ASCII as \X2\ hex escapes. */
const str = (s) => {
  if (s === null || s === undefined) return '$';
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0);
    if (code === 0x27) out += "''";
    else if (code === 0x5c) out += '\\\\';
    else if (code >= 0x20 && code < 0x7f) out += ch;
    else out += `\\X2\\${code.toString(16).toUpperCase().padStart(4, '0')}\\X0\\`;
  }
  return `'${out}'`;
};
const list = (items) => `(${items.join(',')})`;
const enumValue = (v) => `.${v}.`;

/** IFC GlobalId: 128 bits from a hash of the name, in IFC's 22-character base-64 form. */
const GUID_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';
const usedGuids = new Set();
function guid(key) {
  if (usedGuids.has(key)) throw new Error(`GlobalId key used twice: ${key}`);
  usedGuids.add(key);
  const bytes = createHash('sha256').update(`peekbean-small-building/${key}`).digest().subarray(0, 16);
  // Version 4 / variant bits, like a random UUID.
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  let n = BigInt(`0x${bytes.toString('hex')}`);
  let out = '';
  for (let i = 0; i < 22; i++) {
    out = GUID_CHARS[Number(n & 63n)] + out;
    n >>= 6n;
  }
  return `'${out}'`;
}

// ---- Shared resources ---------------------------------------------------------------------------------------

const person = add(`IFCPERSON($,${str('Example')},$,$,$,$,$,$)`);
const organization = add(`IFCORGANIZATION($,${str('Example')},$,$,$)`);
const personOrg = add(`IFCPERSONANDORGANIZATION(${person},${organization},$)`);
const application = add(`IFCAPPLICATION(${organization},${str('1.0')},${str('Peekbean sample generator')},${str('Peekbean')})`);
const owner = add(`IFCOWNERHISTORY(${personOrg},${application},$,.ADDED.,$,$,$,${TIMESTAMP})`);

const point = (x, y, z) => add(`IFCCARTESIANPOINT(${list(z === undefined ? [real(x), real(y)] : [real(x), real(y), real(z)])})`);
const direction = (x, y, z) => add(`IFCDIRECTION(${list(z === undefined ? [real(x), real(y)] : [real(x), real(y), real(z)])})`);
const origin = point(0, 0, 0);
const origin2d = point(0, 0);
const zAxis = direction(0, 0, 1);
const xAxis = direction(1, 0, 0);
const yAxis = direction(0, 1, 0);
const worldPlacement = add(`IFCAXIS2PLACEMENT3D(${origin},${zAxis},${xAxis})`);
const trueNorth = direction(0, 1);

/** Placement at (x, y, z); `along` is the local X axis (the direction a wall runs in), `up` the local Z axis. */
function axis(x, y, z, along = null, up = null) {
  const location = x === 0 && y === 0 && z === 0 ? origin : point(x, y, z);
  return add(`IFCAXIS2PLACEMENT3D(${location},${up ?? '$'},${along ?? '$'})`);
}
const placement = (relativeTo, x, y, z, along = null) => add(`IFCLOCALPLACEMENT(${relativeTo ?? '$'},${axis(x, y, z, along)})`);

const context = add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,${str('Model')},3,1.E-05,${worldPlacement},${trueNorth})`);
const bodyContext = add(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT(${str('Body')},${str('Model')},*,*,*,*,${context},$,.MODEL_VIEW.,$)`);

const units = add(`IFCUNITASSIGNMENT(${list([
  add('IFCSIUNIT(*,.LENGTHUNIT.,.MILLI.,.METRE.)'),
  add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)'),
  add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)'),
  add('IFCSIUNIT(*,.MASSUNIT.,.KILO.,.GRAM.)'),
  add('IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)'),
])})`);

// ---- Styles: one surface style per kind of material (sRGB 0–1, transparency 0 = opaque) ----------------------

function surfaceStyle(name, [r, g, b], transparency = 0) {
  const colour = add(`IFCCOLOURRGB($,${real(r)},${real(g)},${real(b)})`);
  const rendering = add(`IFCSURFACESTYLERENDERING(${colour},${real(transparency)},$,$,$,$,$,$,.NOTDEFINED.)`);
  return add(`IFCSURFACESTYLE(${str(name)},.BOTH.,(${rendering}))`);
}
const STYLE = {
  wall: surfaceStyle('Rendered masonry', [0.86, 0.83, 0.77]),
  slab: surfaceStyle('Concrete', [0.62, 0.62, 0.6]),
  roof: surfaceStyle('Roof membrane', [0.52, 0.27, 0.22]),
  frame: surfaceStyle('Window frame', [0.94, 0.94, 0.92]),
  glass: surfaceStyle('Glass', [0.55, 0.75, 0.88], 0.6),
  door: surfaceStyle('Oak', [0.6, 0.42, 0.24]),
  column: surfaceStyle('Exposed concrete', [0.72, 0.72, 0.7]),
  beam: surfaceStyle('Steel, coated', [0.3, 0.42, 0.58]),
  space: surfaceStyle('Room', [0.45, 0.72, 0.5], 0.8),
};

// ---- Geometry: extruded profiles, each with a surface style ------------------------------------------------

// Profiles always get a position: it is optional in IFC4, but required in IFC2x3 and expected by many readers.
const profileCenter = add(`IFCAXIS2PLACEMENT2D(${origin2d},$)`);
/** Rectangle of xDim × yDim centered at (cx, cy) in the profile plane. */
const rectangle = (cx, cy, xDim, yDim) =>
  add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,${cx === 0 && cy === 0 ? profileCenter : add(`IFCAXIS2PLACEMENT2D(${point(cx, cy)},$)`)},${real(xDim)},${real(yDim)})`);
const hollowRectangle = (xDim, yDim, wall) => add(`IFCRECTANGLEHOLLOWPROFILEDEF(.AREA.,$,${profileCenter},${real(xDim)},${real(yDim)},${real(wall)},$,$)`);
const circle = (radius) => add(`IFCCIRCLEPROFILEDEF(.AREA.,$,${profileCenter},${real(radius)})`);

/** Extrudes a profile by `depth` along the local Z of `position` (default: straight up from the element origin). */
function extrusion(profile, depth, style, position = worldPlacement) {
  const solid = add(`IFCEXTRUDEDAREASOLID(${profile},${position},${zAxis},${real(depth)})`);
  if (style) add(`IFCSTYLEDITEM(${solid},(${style}),$)`);
  return solid;
}
const shape = (...items) => add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${add(`IFCSHAPEREPRESENTATION(${bodyContext},${str('Body')},${str('SweptSolid')},${list(items)})`)}))`);

// ---- Properties and quantities --------------------------------------------------------------------------------

const bool = (v) => `IFCBOOLEAN(${v ? '.T.' : '.F.'})`;
const label = (v) => `IFCLABEL(${str(v)})`;
const text = (v) => `IFCTEXT(${str(v)})`;
const single = (name, value) => add(`IFCPROPERTYSINGLEVALUE(${str(name)},$,${value},$)`);
const enumerated = (name, ...values) => add(`IFCPROPERTYENUMERATEDVALUE(${str(name)},$,${list(values.map(label))},$)`);

function propertySet(key, name, objects, properties) {
  const pset = add(`IFCPROPERTYSET(${guid(`pset/${key}`)},${owner},${str(name)},$,${list(properties)})`);
  add(`IFCRELDEFINESBYPROPERTIES(${guid(`pset-rel/${key}`)},${owner},$,$,${list(objects)},${pset})`);
}

/** Quantities in project units (mm, m², m³, kg) unless they name their own. */
const length = (name, v) => add(`IFCQUANTITYLENGTH(${str(name)},$,$,${real(v)},$)`);
const area = (name, v) => add(`IFCQUANTITYAREA(${str(name)},$,$,${real(v)},$)`);
const volume = (name, v) => add(`IFCQUANTITYVOLUME(${str(name)},$,$,${real(v)},$)`);
const weight = (name, v) => add(`IFCQUANTITYWEIGHT(${str(name)},$,$,${real(v)},$)`);
const count = (name, v) => add(`IFCQUANTITYCOUNT(${str(name)},$,$,${real(v)},$)`);

function quantitySet(key, name, object, quantities) {
  const qset = add(`IFCELEMENTQUANTITY(${guid(`qset/${key}`)},${owner},${str(name)},$,$,${list(quantities)})`);
  add(`IFCRELDEFINESBYPROPERTIES(${guid(`qset-rel/${key}`)},${owner},$,$,(${object}),${qset})`);
}

// ---- Materials ---------------------------------------------------------------------------------------------

const material = (name, category) => add(`IFCMATERIAL(${str(name)},$,${str(category)})`);
const MATERIAL = {
  brick: material('Brick', 'Masonry'),
  insulation: material('Mineral wool', 'Insulation'),
  concrete: material('Concrete C30/37', 'Concrete'),
  aluminium: material('Aluminium', 'Metal'),
  glass: material('Float glass', 'Glass'),
  oak: material('Oak', 'Wood'),
  steel: material('Steel S235', 'Steel'),
};
const wallLayers = add(`IFCMATERIALLAYERSET(${list([
  add(`IFCMATERIALLAYER(${MATERIAL.brick},240.,.F.,${str('Load-bearing masonry')},$,$,$)`),
  add(`IFCMATERIALLAYER(${MATERIAL.insulation},60.,.F.,${str('Insulation')},$,$,$)`),
])},${str('Exterior wall 300')},$)`);
const windowMaterials = add(`IFCMATERIALCONSTITUENTSET(${str('Window')},$,${list([
  add(`IFCMATERIALCONSTITUENT(${str('Frame')},$,${MATERIAL.aluminium},$,$)`),
  add(`IFCMATERIALCONSTITUENT(${str('Glazing')},$,${MATERIAL.glass},$,$)`),
])})`);

const materialUses = new Map();
const useMaterial = (materialRef, object) => materialUses.set(materialRef, [...(materialUses.get(materialRef) ?? []), object]);

// ---- Spatial structure ---------------------------------------------------------------------------------------

const project = add(`IFCPROJECT(${guid('project')},${owner},${str('Small building')},${str('Sample project for the IFC viewer')},$,$,$,(${context}),${units})`);
const sitePlacement = placement(null, 0, 0, 0);
const site = add(`IFCSITE(${guid('site')},${owner},${str('Site')},$,$,${sitePlacement},$,$,.ELEMENT.,$,$,$,$,$)`);
const buildingPlacement = placement(sitePlacement, 0, 0, 0);
const building = add(`IFCBUILDING(${guid('building')},${owner},${str('Small building')},$,$,${buildingPlacement},$,$,.ELEMENT.,$,$,$)`);
add(`IFCRELAGGREGATES(${guid('rel/project-site')},${owner},$,$,${project},(${site}))`);
add(`IFCRELAGGREGATES(${guid('rel/site-building')},${owner},$,$,${site},(${building}))`);

// Building outline 10 × 8 m, walls 300 mm, storeys 3 m high with 250 mm slabs.
const WIDTH = 10000;
const DEPTH = 8000;
const WALL = 300;
const STOREY = 3000;
const SLAB = 250;
const WALL_HEIGHT = STOREY - SLAB;

let wallNumber = 0;
let windowNumber = 0;

function wall(storeyKey, storeyPlacement, name, [x0, y0], [x1, y1], contained) {
  const key = `${storeyKey}/${name}`;
  const side = Math.hypot(x1 - x0, y1 - y0);
  const along = direction((x1 - x0) / side, (y1 - y0) / side, 0);
  const wallPlacement = placement(storeyPlacement, x0, y0, 0, along);
  // The profile runs along local X; local Y points into the building. Each wall stops where the next one begins.
  const len = side - WALL;
  const body = extrusion(rectangle(len / 2, WALL / 2, len, WALL), WALL_HEIGHT, STYLE.wall);
  wallNumber++;
  const ref = add(`IFCWALL(${guid(key)},${owner},${str(name)},$,${str('Exterior wall 300')},${wallPlacement},${shape(body)},${str(`W${String(wallNumber).padStart(2, '0')}`)},.SOLIDWALL.)`);
  contained.push(ref);
  add(`IFCRELASSOCIATESMATERIAL(${guid(`material/${key}`)},${owner},$,$,(${ref}),${add(`IFCMATERIALLAYERSETUSAGE(${wallLayers},.AXIS2.,.POSITIVE.,0.,$)`)})`);
  propertySet(key, 'Pset_WallCommon', [ref], [
    single('Reference', label('EW-300')),
    enumerated('Status', 'NEW'),
    single('IsExternal', bool(true)),
    single('LoadBearing', bool(true)),
    single('FireRating', label('REI 90')),
    single('ThermalTransmittance', 'IFCTHERMALTRANSMITTANCEMEASURE(0.28)'),
  ]);
  const netSide = (len * WALL_HEIGHT) / 1e6;
  quantitySet(key, 'Qto_WallBaseQuantities', ref, [
    length('Length', len),
    length('Width', WALL),
    length('Height', WALL_HEIGHT),
    area('GrossSideArea', netSide),
    volume('GrossVolume', (len * WALL * WALL_HEIGHT) / 1e9),
  ]);
  return { ref, key, placement: wallPlacement, length: len };
}

/** Opening through a wall at `offset` along it, `sill` above the floor, and the window or door filling it. */
function opening(host, contained, kind, offset, sill, width, height) {
  const key = `${host.key}/opening-${offset}`;
  const openingPlacement = placement(host.placement, offset, 0, sill);
  // A little deeper than the wall, so the cut goes clean through.
  const body = extrusion(rectangle(width / 2, WALL / 2, width, WALL + 100), height, null);
  const openingRef = add(`IFCOPENINGELEMENT(${guid(key)},${owner},${str('Opening')},$,$,${openingPlacement},${shape(body)},$,.OPENING.)`);
  add(`IFCRELVOIDSELEMENT(${guid(`voids/${key}`)},${owner},$,$,${host.ref},${openingRef})`);

  // Frame and leaf or glazing stand in the middle of the wall, in the wall's vertical plane, `depth` thick.
  const inWallPlane = (dx, dz, depth) => add(`IFCAXIS2PLACEMENT3D(${point(dx, (WALL - depth) / 2, dz)},${yAxis},${xAxis})`);
  const fillPlacement = placement(openingPlacement, 0, 0, 0);
  let fill;
  if (kind === 'window') {
    windowNumber++;
    const name = `Window ${windowNumber}`;
    const frame = extrusion(hollowRectangle(width, height, 60), 80, STYLE.frame, inWallPlane(width / 2, height / 2, 80));
    const glazing = extrusion(rectangle(0, 0, width - 120, height - 120), 24, STYLE.glass, inWallPlane(width / 2, height / 2, 24));
    fill = add(`IFCWINDOW(${guid(`${key}/window`)},${owner},${str(name)},$,${str('Single-panel window')},${fillPlacement},${shape(frame, glazing)},${str(`WI${String(windowNumber).padStart(2, '0')}`)},${real(height)},${real(width)},.WINDOW.,.SINGLE_PANEL.,$)`);
    useMaterial(windowMaterials, fill);
    propertySet(`${key}/window`, 'Pset_WindowCommon', [fill], [
      single('Reference', label('WI-1500')),
      single('IsExternal', bool(true)),
      single('ThermalTransmittance', 'IFCTHERMALTRANSMITTANCEMEASURE(1.1)'),
      single('GlazingAreaFraction', 'IFCPOSITIVERATIOMEASURE(0.78)'),
    ]);
    quantitySet(`${key}/window`, 'Qto_WindowBaseQuantities', fill, [length('Width', width), length('Height', height), area('Area', (width * height) / 1e6)]);
  } else {
    const leaf = extrusion(rectangle(0, 0, width - 100, height - 50), 50, STYLE.door, inWallPlane(width / 2, (height - 50) / 2, 50));
    // Frame: two jambs and a head, open at the floor.
    const jamb = (dx) => extrusion(rectangle(0, 0, 50, height), 120, STYLE.frame, inWallPlane(dx, height / 2, 120));
    const head = extrusion(rectangle(0, 0, width, 50), 120, STYLE.frame, inWallPlane(width / 2, height - 25, 120));
    fill = add(`IFCDOOR(${guid(`${key}/door`)},${owner},${str('Entrance door')},$,${str('Single swing door')},${fillPlacement},${shape(leaf, jamb(25), jamb(width - 25), head)},${str('D01')},${real(height)},${real(width)},.DOOR.,.SINGLE_SWING_LEFT.,$)`);
    useMaterial(MATERIAL.oak, fill);
    propertySet(`${key}/door`, 'Pset_DoorCommon', [fill], [
      single('Reference', label('D-1000')),
      single('IsExternal', bool(true)),
      single('FireRating', label('EI 30')),
      single('HandicapAccessible', bool(true)),
    ]);
    quantitySet(`${key}/door`, 'Qto_DoorBaseQuantities', fill, [length('Width', width), length('Height', height), area('Area', (width * height) / 1e6)]);
  }
  add(`IFCRELFILLSELEMENT(${guid(`fills/${key}`)},${owner},$,$,${openingRef},${fill})`);
  contained.push(fill);
}

function slab(key, storeyPlacement, name, z, x0, y0, x1, y1, thickness, type, style, contained) {
  const slabPlacement = placement(storeyPlacement, 0, 0, z);
  const body = extrusion(rectangle((x0 + x1) / 2, (y0 + y1) / 2, x1 - x0, y1 - y0), thickness, style);
  const ref = add(`IFCSLAB(${guid(key)},${owner},${str(name)},$,$,${slabPlacement},${shape(body)},$,.${type}.)`);
  contained.push(ref);
  useMaterial(MATERIAL.concrete, ref);
  propertySet(key, 'Pset_SlabCommon', [ref], [
    single('IsExternal', bool(type === 'ROOF')),
    single('LoadBearing', bool(true)),
    single('FireRating', label('REI 60')),
  ]);
  const grossArea = ((x1 - x0) * (y1 - y0)) / 1e6;
  quantitySet(key, 'Qto_SlabBaseQuantities', ref, [length('Width', thickness), area('GrossArea', grossArea), volume('GrossVolume', (grossArea * thickness) / 1000)]);
  return ref;
}

function space(key, storey, storeyPlacement, name, longName) {
  const spacePlacement = placement(storeyPlacement, 0, 0, 0);
  const inner = [WIDTH - 2 * WALL, DEPTH - 2 * WALL];
  const body = extrusion(rectangle(WIDTH / 2, DEPTH / 2, ...inner), WALL_HEIGHT, STYLE.space);
  const ref = add(`IFCSPACE(${guid(key)},${owner},${str(name)},$,$,${spacePlacement},${shape(body)},${str(longName)},.ELEMENT.,.INTERNAL.,$)`);
  add(`IFCRELAGGREGATES(${guid(`rel/${key}`)},${owner},$,$,${storey},(${ref}))`);
  const floorArea = (inner[0] * inner[1]) / 1e6;
  propertySet(key, 'Pset_SpaceCommon', [ref], [single('Reference', label(name)), single('IsExternal', bool(false)), single('PubliclyAccessible', bool(false))]);
  quantitySet(key, 'Qto_SpaceBaseQuantities', ref, [area('NetFloorArea', floorArea), length('Height', WALL_HEIGHT), volume('NetVolume', (floorArea * WALL_HEIGHT) / 1000)]);
  return ref;
}

const storeys = [];
for (const [index, storeyName] of ['Ground floor', 'Upper floor'].entries()) {
  const storeyKey = `storey-${index}`;
  const elevation = index * STOREY;
  const storeyPlacement = placement(buildingPlacement, 0, 0, elevation);
  const storey = add(`IFCBUILDINGSTOREY(${guid(storeyKey)},${owner},${str(storeyName)},$,$,${storeyPlacement},$,$,.ELEMENT.,${real(elevation)})`);
  storeys.push(storey);
  const contained = [];

  slab(`${storeyKey}/floor`, storeyPlacement, index ? 'Floor slab, upper floor' : 'Floor slab, ground floor', -SLAB, 0, 0, WIDTH, DEPTH, SLAB, index ? 'FLOOR' : 'BASESLAB', STYLE.slab, contained);
  // Counterclockwise around the building, seen from above; each wall's interior lies to its left.
  const south = wall(storeyKey, storeyPlacement, 'Wall south', [0, 0], [WIDTH, 0], contained);
  const east = wall(storeyKey, storeyPlacement, 'Wall east', [WIDTH, 0], [WIDTH, DEPTH], contained);
  const north = wall(storeyKey, storeyPlacement, 'Wall north', [WIDTH, DEPTH], [0, DEPTH], contained);
  wall(storeyKey, storeyPlacement, 'Wall west', [0, DEPTH], [0, 0], contained);
  opening(south, contained, 'window', 2000, 900, 1500, 1200);
  opening(south, contained, 'window', 6500, 900, 1500, 1200);
  opening(north, contained, 'window', 4250, 900, 1500, 1200);
  if (index === 0) {
    opening(east, contained, 'door', 3500, 0, 1000, 2100);
    const columnPlacement = placement(storeyPlacement, WIDTH / 2, DEPTH / 2, 0);
    const column = add(`IFCCOLUMN(${guid('column')},${owner},${str('Column')},$,${str('Round column 300')},${columnPlacement},${shape(extrusion(circle(150), WALL_HEIGHT, STYLE.column))},${str('C01')},.COLUMN.)`);
    contained.push(column);
    useMaterial(MATERIAL.concrete, column);
    propertySet('column', 'Pset_ColumnCommon', [column], [single('IsExternal', bool(false)), single('LoadBearing', bool(true)), single('FireRating', label('R 90'))]);
    quantitySet('column', 'Qto_ColumnBaseQuantities', column, [length('Length', WALL_HEIGHT), area('CrossSectionArea', (Math.PI * 0.15 ** 2)), volume('NetVolume', Math.PI * 0.15 ** 2 * (WALL_HEIGHT / 1000))]);
  } else {
    // Beam under the roof across the building, 200 × 400 mm, running along X.
    const beamPlacement = placement(storeyPlacement, WALL, DEPTH / 2, 0);
    const span = WIDTH - 2 * WALL;
    const alongX = add(`IFCAXIS2PLACEMENT3D(${origin},${xAxis},${yAxis})`);
    const body = extrusion(rectangle(0, WALL_HEIGHT - 200, 200, 400), span, STYLE.beam, alongX);
    const beam = add(`IFCBEAM(${guid('beam')},${owner},${str('Ridge beam')},$,${str('HEA 400')},${beamPlacement},${shape(body)},${str('B01')},.BEAM.)`);
    contained.push(beam);
    useMaterial(MATERIAL.steel, beam);
    propertySet('beam', 'Pset_BeamCommon', [beam], [single('LoadBearing', bool(true)), single('IsExternal', bool(false)), single('Span', `IFCPOSITIVELENGTHMEASURE(${real(span)})`)]);
    quantitySet('beam', 'Qto_BeamBaseQuantities', beam, [length('Length', span), volume('NetVolume', 0.2 * 0.4 * (span / 1000)), weight('NetWeight', 0.2 * 0.4 * (span / 1000) * 7850)]);
    slab(`${storeyKey}/roof`, storeyPlacement, 'Roof slab', WALL_HEIGHT, -300, -300, WIDTH + 300, DEPTH + 300, SLAB, 'ROOF', STYLE.roof, contained);
  }
  space(`${storeyKey}/space`, storey, storeyPlacement, index ? '1.01' : '0.01', index ? 'Studio' : 'Living room');
  add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${guid(`contains/${storeyKey}`)},${owner},$,$,${list(contained)},${storey})`);
  if (index === 0) {
    // A property set of our own: several value types, and text beyond ASCII.
    propertySet('custom', 'Peekbean_SampleInfo', contained.slice(0, 1), [
      single('Purpose', text('Test file for the IFC viewer')),
      single('Revision', 'IFCINTEGER(3)'),
      single('Note', text('Floor area 79.92 m² · ±0.00 = 34.5 m above sea level')),
    ]);
    quantitySet('custom', 'Peekbean_Counts', contained[0], [count('Windows', 3), count('Doors', 1)]);
  }
}
add(`IFCRELAGGREGATES(${guid('rel/building-storeys')},${owner},$,$,${building},${list(storeys)})`);
for (const [materialRef, objects] of materialUses) {
  add(`IFCRELASSOCIATESMATERIAL(${guid(`material/${materialRef}`)},${owner},$,$,${list(objects)},${materialRef})`);
}

// ---- File ------------------------------------------------------------------------------------------------

const header = [
  'ISO-10303-21;',
  'HEADER;',
  "FILE_DESCRIPTION(('ViewDefinition [ReferenceView_V1.2]'),'2;1');",
  `FILE_NAME('small-building.ifc','2024-01-01T00:00:00',('Example'),('Example'),'Peekbean sample generator','Peekbean sample generator','');`,
  "FILE_SCHEMA(('IFC4'));",
  'ENDSEC;',
  'DATA;',
];
const output = `${[...header, ...lines.map((line, i) => `#${i + 1}=${line};`), 'ENDSEC;', 'END-ISO-10303-21;'].join('\n')}\n`;
mkdirSync(path.join(ROOT, 'cad'), { recursive: true });
writeFileSync(path.join(ROOT, FILE), output);
console.log(`${FILE}: ${Buffer.byteLength(output).toLocaleString('en-US')} bytes, ${lines.length} entities`);
