// SPDX-License-Identifier: GPL-3.0-or-later
// Writes samples for the formats added after the first viewers: 3D exchange formats (FBX, COLLADA, 3DS, AMF, VRML,
// VTK, USD, PCD, XYZ, OFF, dotbim, MagicaVoxel, Rhino), textures (TGA, DDS, EXR, HDR, KTX2), Windows metafiles,
// CNC and 3D printer programs, a Jupyter notebook, comics, a calendar, contacts and shortcuts. Everything is drawn
// from scratch here, so the output can be published as CC0-1.0 like the other samples.
// Usage: node scripts/generate-format-samples.mjs [file ...] (after npm install: needs three and rhino3dm). With file
// names (relative to samples/), only those are written.
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { crc32, deflateSync, gzipSync } from 'node:zlib';
import * as THREE from 'three';
import { EXRExporter, ZIP_COMPRESSION } from 'three/examples/jsm/exporters/EXRExporter.js';
import { VK_FORMAT_R8G8B8A8_SRGB, createDefaultContainer, write as writeKtx2 } from 'three/examples/jsm/libs/ktx-parse.module.js';

const ROOT = path.resolve(import.meta.dirname, '..', 'samples');
const written = [];
const only = process.argv.slice(2).map((rel) => rel.replace(/\\/g, '/').replace(/^samples\//, ''));

function write(rel, data) {
  if (only.length && !only.includes(rel)) return;
  const file = path.join(ROOT, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, data);
  written.push([rel, Buffer.byteLength(data)]);
}

const n = (v) => Number(v.toFixed(4)).toString();
const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; };
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- Meshes -------------------------------------------------------------------------------------------------

/** Box from corner to corner, faces wound counterclockwise seen from outside. */
function box(x0, y0, z0, x1, y1, z1) {
  const vertices = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]];
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [3, 0, 4, 7], [1, 2, 6, 5]];
  return { vertices, triangles: quads.flatMap(([a, b, c, d]) => [[a, b, c], [a, c, d]]) };
}

/** Triangular rib between the base plate and the upright. */
function wedge(x0, y0, z0, x1, y1, z1) {
  return {
    vertices: [[x0, y0, z0], [x1, y0, z0], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x0, y1, z1]],
    triangles: [[0, 1, 2], [3, 5, 4], [0, 3, 4], [0, 4, 1], [0, 2, 5], [0, 5, 3], [1, 4, 5], [1, 5, 2]],
  };
}

/** Angle bracket in millimeters, Z up: three parts with their own colors (linear RGB 0–1). */
const BRACKET = [
  { name: 'Base plate', color: [0.6, 0.64, 0.7], mesh: box(0, 0, 0, 80, 50, 8) },
  { name: 'Upright', color: [0.18, 0.5, 0.84], mesh: box(0, 0, 8, 10, 50, 60) },
  { name: 'Rib', color: [0.95, 0.6, 0.22], mesh: wedge(10, 20, 8, 45, 30, 43) },
];

function torus(R = 30, r = 10, segments = 48, sides = 24) {
  const vertices = [];
  const colors = [];
  const quads = [];
  for (let i = 0; i < segments; i++) {
    const u = (i / segments) * Math.PI * 2;
    for (let j = 0; j < sides; j++) {
      const v = (j / sides) * Math.PI * 2;
      vertices.push([(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r * Math.sin(v)]);
      colors.push([Math.round(127 + 127 * Math.cos(u)), Math.round(127 + 127 * Math.sin(u)), 200]);
      const a = i * sides + j;
      const b = ((i + 1) % segments) * sides + j;
      const c = ((i + 1) % segments) * sides + ((j + 1) % sides);
      const d = i * sides + ((j + 1) % sides);
      quads.push([a, b, c, d]);
    }
  }
  return { vertices, colors, quads };
}

// ---- 3D formats ---------------------------------------------------------------------------------------------

function fbx() {
  // ASCII FBX 7.3. Y up (the FBX default), so the Z-up bracket is turned: (x, y, z) → (x, z, −y).
  const objects = [];
  const connections = [];
  BRACKET.forEach((part, i) => {
    const [geo, model, mat] = [1000 + i, 2000 + i, 3000 + i];
    const vertices = part.mesh.vertices.flatMap(([x, y, z]) => [x, z, -y]);
    const indices = part.mesh.triangles.flatMap(([a, b, c]) => [a, b, -c - 1]);
    objects.push(
      `\tGeometry: ${geo}, "Geometry::${part.name}", "Mesh" {`,
      `\t\tVertices: *${vertices.length} {\n\t\t\ta: ${vertices.map(n).join(',')}\n\t\t}`,
      `\t\tPolygonVertexIndex: *${indices.length} {\n\t\t\ta: ${indices.join(',')}\n\t\t}`,
      '\t\tGeometryVersion: 124',
      '\t\tLayerElementMaterial: 0 {\n\t\t\tVersion: 101\n\t\t\tName: ""\n\t\t\tMappingInformationType: "AllSame"\n\t\t\tReferenceInformationType: "IndexToDirect"\n\t\t\tMaterials: *1 {\n\t\t\t\ta: 0\n\t\t\t}\n\t\t}',
      '\t\tLayer: 0 {\n\t\t\tVersion: 100\n\t\t\tLayerElement:  {\n\t\t\t\tType: "LayerElementMaterial"\n\t\t\t\tTypedIndex: 0\n\t\t\t}\n\t\t}',
      '\t}',
      `\tModel: ${model}, "Model::${part.name}", "Mesh" {\n\t\tVersion: 232\n\t\tProperties70:  {\n\t\t}\n\t\tShading: T\n\t\tCulling: "CullingOff"\n\t}`,
      `\tMaterial: ${mat}, "Material::${part.name}", "" {\n\t\tVersion: 102\n\t\tShadingModel: "phong"\n\t\tMultiLayer: 0\n\t\tProperties70:  {\n\t\t\tP: "DiffuseColor", "Color", "", "A",${part.color.join(',')}\n\t\t}\n\t}`,
    );
    connections.push(`\tC: "OO",${model},0`, `\tC: "OO",${geo},${model}`, `\tC: "OO",${mat},${model}`);
  });
  return [
    '; FBX 7.3.0 project file',
    '; Angle bracket (sample file)',
    'FBXHeaderExtension:  {\n\tFBXHeaderVersion: 1003\n\tFBXVersion: 7300\n\tCreator: "OPSIS sample generator"\n}',
    'Objects:  {',
    ...objects,
    '}',
    'Connections:  {',
    ...connections,
    '}',
    '',
  ].join('\n');
}

function collada() {
  const effects = [];
  const materials = [];
  const geometries = [];
  const nodes = [];
  BRACKET.forEach((part, i) => {
    const positions = part.mesh.vertices.flat();
    effects.push(`<effect id="effect${i}"><profile_COMMON><technique sid="common"><phong><diffuse><color>${part.color.join(' ')} 1</color></diffuse></phong></technique></profile_COMMON></effect>`);
    materials.push(`<material id="material${i}" name="${part.name}"><instance_effect url="#effect${i}"/></material>`);
    geometries.push(
      `<geometry id="geometry${i}" name="${part.name}"><mesh>`,
      `<source id="geometry${i}-positions"><float_array id="geometry${i}-array" count="${positions.length}">${positions.map(n).join(' ')}</float_array>`,
      `<technique_common><accessor source="#geometry${i}-array" count="${positions.length / 3}" stride="3"><param name="X" type="float"/><param name="Y" type="float"/><param name="Z" type="float"/></accessor></technique_common></source>`,
      `<vertices id="geometry${i}-vertices"><input semantic="POSITION" source="#geometry${i}-positions"/></vertices>`,
      `<triangles material="material" count="${part.mesh.triangles.length}"><input semantic="VERTEX" source="#geometry${i}-vertices" offset="0"/><p>${part.mesh.triangles.flat().join(' ')}</p></triangles>`,
      '</mesh></geometry>',
    );
    nodes.push(`<node id="node${i}" name="${part.name}"><instance_geometry url="#geometry${i}"><bind_material><technique_common><instance_material symbol="material" target="#material${i}"/></technique_common></bind_material></instance_geometry></node>`);
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">',
    '<asset><contributor><authoring_tool>OPSIS sample generator</authoring_tool></contributor><unit name="millimeter" meter="0.001"/><up_axis>Z_UP</up_axis></asset>',
    `<library_effects>${effects.join('')}</library_effects>`,
    `<library_materials>${materials.join('')}</library_materials>`,
    `<library_geometries>${geometries.join('\n')}</library_geometries>`,
    `<library_visual_scenes><visual_scene id="scene" name="Bracket">${nodes.join('')}</visual_scene></library_visual_scenes>`,
    '<scene><instance_visual_scene url="#scene"/></scene>',
    '</COLLADA>',
    '',
  ].join('\n');
}

/** 3D Studio: nested chunks (id, length including the 6-byte header). */
function chunk(id, ...parts) {
  const body = Buffer.concat(parts);
  return Buffer.concat([u16(id), u32(6 + body.length), body]);
}
const cstring = (s) => Buffer.from(`${s}\0`, 'latin1');

function threeDs() {
  const materials = BRACKET.map((part) =>
    chunk(0xafff, chunk(0xa000, cstring(part.name)), chunk(0xa020, chunk(0x0011, Buffer.from(part.color.map((c) => Math.round(c * 255)))))),
  );
  const objects = BRACKET.map((part) => {
    const points = Buffer.concat([u16(part.mesh.vertices.length), ...part.mesh.vertices.flat().map(f32)]);
    const faces = part.mesh.triangles;
    const group = chunk(0x4130, cstring(part.name), u16(faces.length), ...faces.map((_, i) => u16(i)));
    const faceArray = chunk(0x4120, u16(faces.length), ...faces.map(([a, b, c]) => Buffer.concat([u16(a), u16(b), u16(c), u16(7)])), group);
    return chunk(0x4000, cstring(part.name), chunk(0x4100, chunk(0x4110, points), faceArray));
  });
  return chunk(0x4d4d, chunk(0x0002, u32(3)), chunk(0x3d3d, chunk(0x3d3e, u32(3)), ...materials, ...objects));
}

function amf() {
  const lines = ['<?xml version="1.0" encoding="UTF-8"?>', '<amf unit="millimeter" version="1.1">', '<metadata type="name">Angle bracket</metadata>'];
  BRACKET.forEach((part, i) => {
    const [r, g, b] = part.color;
    lines.push(`<material id="${i + 1}"><metadata type="name">${part.name}</metadata><color><r>${r}</r><g>${g}</g><b>${b}</b></color></material>`);
  });
  BRACKET.forEach((part, i) => {
    lines.push(`<object id="${i}"><metadata type="name">${part.name}</metadata><mesh><vertices>`);
    for (const [x, y, z] of part.mesh.vertices) lines.push(`<vertex><coordinates><x>${n(x)}</x><y>${n(y)}</y><z>${n(z)}</z></coordinates></vertex>`);
    lines.push(`</vertices><volume materialid="${i + 1}">`);
    for (const [a, b, c] of part.mesh.triangles) lines.push(`<triangle><v1>${a}</v1><v2>${b}</v2><v3>${c}</v3></triangle>`);
    lines.push('</volume></mesh></object>');
  });
  lines.push('</amf>', '');
  return lines.join('\n');
}

function vrml() {
  const shapes = BRACKET.map((part) => [
    `    Shape {  # ${part.name}`,
    `      appearance Appearance { material Material { diffuseColor ${part.color.join(' ')} } }`,
    '      geometry IndexedFaceSet {',
    '        solid FALSE',
    `        coord Coordinate { point [ ${part.mesh.vertices.map((v) => v.map(n).join(' ')).join(', ')} ] }`,
    `        coordIndex [ ${part.mesh.triangles.map((t) => `${t.join(', ')}, -1`).join(', ')} ]`,
    '      }',
    '    }',
  ].join('\n'));
  // A pin through the base plate as a VRML primitive (cylinders stand along Y, so it is turned to Z).
  const pin = '    Transform { translation 60 25 4 rotation 1 0 0 1.5708 children Shape { appearance Appearance { material Material { diffuseColor 0.3 0.3 0.32 } } geometry Cylinder { radius 4 height 20 } } }';
  // VRML is Y up: the Z-up bracket is turned upright as a whole.
  return `#VRML V2.0 utf8\n# Angle bracket, generated by scripts/generate-format-samples.mjs\nTransform {\n  rotation 1 0 0 -1.5708\n  children [\n${[...shapes, pin].join('\n')}\n  ]\n}\n`;
}

function vtkLegacy() {
  const t = torus();
  return [
    '# vtk DataFile Version 3.0',
    'Torus, generated by scripts/generate-format-samples.mjs',
    'ASCII',
    'DATASET POLYDATA',
    `POINTS ${t.vertices.length} float`,
    ...t.vertices.map((v) => v.map(n).join(' ')),
    `POLYGONS ${t.quads.length} ${t.quads.length * 5}`,
    ...t.quads.map((q) => `4 ${q.join(' ')}`),
    '',
  ].join('\n');
}

function vtp() {
  const all = BRACKET.reduce(
    (acc, part) => {
      const base = acc.points.length;
      acc.points.push(...part.mesh.vertices);
      acc.polys.push(...part.mesh.triangles.map((t) => t.map((i) => i + base)));
      return acc;
    },
    { points: [], polys: [] },
  );
  return [
    '<?xml version="1.0"?>',
    '<VTKFile type="PolyData" version="0.1" byte_order="LittleEndian">',
    '<PolyData>',
    `<Piece NumberOfPoints="${all.points.length}" NumberOfVerts="0" NumberOfLines="0" NumberOfStrips="0" NumberOfPolys="${all.polys.length}">`,
    `<Points><DataArray type="Float32" NumberOfComponents="3" format="ascii">${all.points.flat().map(n).join(' ')}</DataArray></Points>`,
    '<Polys>',
    `<DataArray type="Int32" Name="connectivity" format="ascii">${all.polys.flat().join(' ')}</DataArray>`,
    `<DataArray type="Int32" Name="offsets" format="ascii">${all.polys.map((_, i) => (i + 1) * 3).join(' ')}</DataArray>`,
    '</Polys>',
    '</Piece>',
    '</PolyData>',
    '</VTKFile>',
    '',
  ].join('\n');
}

function usda() {
  const meshes = BRACKET.map((part) => [
    `    def Mesh "${part.name.replace(/\s/g, '')}"`,
    '    {',
    `        int[] faceVertexCounts = [${part.mesh.triangles.map(() => 3).join(', ')}]`,
    `        int[] faceVertexIndices = [${part.mesh.triangles.flat().join(', ')}]`,
    `        point3f[] points = [${part.mesh.vertices.map((v) => `(${v.map(n).join(', ')})`).join(', ')}]`,
    `        color3f[] primvars:displayColor = [(${part.color.join(', ')})]`,
    '        uniform token subdivisionScheme = "none"',
    '    }',
  ].join('\n'));
  return `#usda 1.0\n(\n    defaultPrim = "Bracket"\n    upAxis = "Z"\n    doc = "Angle bracket, generated by scripts/generate-format-samples.mjs"\n)\n\ndef Xform "Bracket"\n{\n${meshes.join('\n\n')}\n}\n`;
}

function pcd() {
  // A scanned dome: points on a half sphere with a little noise.
  const points = [];
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 6000; i++) {
    const a = random() * Math.PI * 2;
    const e = Math.asin(random());
    const r = 40 + (random() - 0.5) * 0.6;
    points.push([r * Math.cos(e) * Math.cos(a), r * Math.cos(e) * Math.sin(a), r * Math.sin(e)]);
  }
  return [
    '# .PCD v0.7 - Point Cloud Data file format',
    'VERSION 0.7',
    'FIELDS x y z',
    'SIZE 4 4 4',
    'TYPE F F F',
    'COUNT 1 1 1',
    `WIDTH ${points.length}`,
    'HEIGHT 1',
    'VIEWPOINT 0 0 0 1 0 0 0',
    `POINTS ${points.length}`,
    'DATA ascii',
    ...points.map((p) => p.map(n).join(' ')),
    '',
  ].join('\n');
}

function xyz() {
  // Terrain: a grid of heights with colors from green valleys to white peaks.
  const lines = ['# Terrain point cloud: x y z r g b, generated by scripts/generate-format-samples.mjs'];
  for (let i = 0; i <= 80; i++) {
    for (let j = 0; j <= 80; j++) {
      const x = i * 2;
      const y = j * 2;
      const z = 12 * Math.sin(x / 25) * Math.cos(y / 30) + 6 * Math.sin((x + y) / 14);
      const t = (z + 18) / 36;
      const color = t > 0.8 ? [240, 240, 240] : [Math.round(60 + 120 * t), Math.round(140 - 40 * t), Math.round(50 + 30 * t)];
      lines.push(`${x} ${y} ${n(z)} ${color.join(' ')}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function off() {
  const t = torus(30, 10, 36, 18);
  return [
    'COFF',
    '# Torus with vertex colors, generated by scripts/generate-format-samples.mjs',
    `${t.vertices.length} ${t.quads.length} 0`,
    ...t.vertices.map((v, i) => `${v.map(n).join(' ')} ${t.colors[i].join(' ')} 255`),
    ...t.quads.map((q) => `4 ${q.join(' ')}`),
    '',
  ].join('\n');
}

function dotbim() {
  // A small pavilion in meters: slab, four columns sharing one mesh, a roof and a glass wall.
  const meshOf = (id, b) => ({ mesh_id: id, coordinates: b.vertices.flat(), indices: b.triangles.flat() });
  const meshes = [meshOf(0, box(0, 0, 0, 8, 6, 0.3)), meshOf(1, box(-0.15, -0.15, 0, 0.15, 0.15, 3)), meshOf(2, box(0, 0, 0, 8.4, 6.4, 0.25)), meshOf(3, box(0, 0, 0, 7.4, 0.02, 2.6))];
  const element = (mesh_id, type, name, [x, y, z], color, info = {}) => ({
    info: { Name: name, ...info },
    mesh_id,
    vector: { x, y, z },
    rotation: { qx: 0, qy: 0, qz: 0, qw: 1 },
    guid: `00000000-0000-4000-8000-${String(mesh_id * 100 + name.length).padStart(12, '0')}`,
    type,
    color,
  });
  const concrete = { r: 180, g: 180, b: 175, a: 255 };
  const elements = [
    element(0, 'Slab', 'Floor slab', [0, 0, 0], concrete, { Material: 'Concrete C30/37' }),
    ...[[0.5, 0.5], [7.5, 0.5], [7.5, 5.5], [0.5, 5.5]].map(([x, y], i) => element(1, 'Column', `Column ${i + 1}`, [x, y, 0.3], { r: 120, g: 125, b: 135, a: 255 }, { Material: 'Steel S355' })),
    element(2, 'Roof', 'Roof plate', [-0.2, -0.2, 3.3], { r: 200, g: 110, b: 60, a: 255 }),
    element(3, 'Wall', 'Glass wall', [0.3, 5.7, 0.4], { r: 120, g: 190, b: 230, a: 110 }, { Material: 'Laminated glass' }),
  ];
  return `${JSON.stringify({ schema_version: '1.1.0', meshes, elements, info: { Name: 'Pavilion', Author: 'OPSIS sample generator' } }, null, 1)}\n`;
}

function vox() {
  // MagicaVoxel: a small house, 16 × 16 × 13 voxels, with its own palette.
  const voxels = [];
  for (let x = 0; x < 16; x++) {
    for (let y = 0; y < 16; y++) {
      voxels.push([x, y, 0, 1]); // ground
      for (let z = 1; z <= 6; z++) {
        const wall = (x === 3 || x === 12 || y === 3 || y === 12) && x >= 3 && x <= 12 && y >= 3 && y <= 12;
        const door = y === 3 && x >= 7 && x <= 8 && z <= 3;
        const window = (x === 3 || x === 12) && y >= 6 && y <= 9 && z >= 3 && z <= 4;
        if (wall && !door) voxels.push([x, y, z, window ? 4 : 2]);
      }
      // Roof: a pyramid of layers above the walls.
      for (let k = 0; k < 6; k++) if (x >= 2 + k && x <= 13 - k && y >= 2 + k && y <= 13 - k && (x === 2 + k || x === 13 - k || y === 2 + k || y === 13 - k)) voxels.push([x, y, 7 + k, 3]);
    }
  }
  const voxChunk = (id, content, children = Buffer.alloc(0)) => Buffer.concat([Buffer.from(id, 'latin1'), u32(content.length), u32(children.length), content, children]);
  const palette = Buffer.alloc(1024);
  const colors = [[96, 160, 80], [230, 220, 200], [180, 70, 50], [120, 190, 230]];
  colors.forEach((c, i) => palette.set([...c, 255], i * 4)); // palette entry i + 1 lives at index i
  const size = voxChunk('SIZE', Buffer.concat([u32(16), u32(16), u32(13)]));
  const xyzi = voxChunk('XYZI', Buffer.concat([u32(voxels.length), Buffer.from(voxels.flat())]));
  return Buffer.concat([Buffer.from('VOX ', 'latin1'), u32(150), voxChunk('MAIN', Buffer.alloc(0), Buffer.concat([size, xyzi, voxChunk('RGBA', palette)]))]);
}

async function rhino3dm() {
  const require = createRequire(import.meta.url);
  const rhino = await require('rhino3dm')();
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Millimeters;
  for (const part of BRACKET) {
    const layer = new rhino.Layer();
    layer.name = part.name;
    layer.color = { r: Math.round(part.color[0] * 255), g: Math.round(part.color[1] * 255), b: Math.round(part.color[2] * 255), a: 255 };
    const layerIndex = doc.layers().add(layer);
    const mesh = new rhino.Mesh();
    for (const [x, y, z] of part.mesh.vertices) mesh.vertices().add(x, y, z);
    for (const [a, b, c] of part.mesh.triangles) mesh.faces().addTriFace(a, b, c);
    mesh.normals().computeNormals();
    mesh.compact();
    const attributes = new rhino.ObjectAttributes();
    attributes.layerIndex = layerIndex;
    attributes.name = part.name;
    doc.objects().addMesh(mesh, attributes);
  }
  const holes = new rhino.Layer();
  holes.name = 'Holes';
  holes.color = { r: 30, g: 30, b: 35, a: 255 };
  const holeLayer = doc.layers().add(holes);
  for (const [x, y] of [[30, 15], [60, 15], [60, 35], [30, 35]]) {
    const attributes = new rhino.ObjectAttributes();
    attributes.layerIndex = holeLayer;
    attributes.name = `Hole ${x}/${y}`;
    doc.objects().addCircle(new rhino.Circle([x, y, 8.01], 3.25), attributes);
  }
  return Buffer.from(doc.toByteArray());
}

// ---- Images -------------------------------------------------------------------------------------------------

/** The motif of the other image samples: warm gradient, a white disk with a dark ring, a translucent stripe left. */
function motif(x, y, w, h) {
  const dx = x - w * 0.62;
  const dy = y - h * 0.5;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (Math.abs(d - h * 0.3) < h * 0.02) return [27, 30, 35, 255];
  if (d < h * 0.3) return [255, 255, 255, 255];
  // A dark square in the top left corner tells whether a decoder flipped the image.
  if (x > w * 0.12 && x < w * 0.22 && y > h * 0.1 && y < h * 0.26) return [27, 30, 35, 255];
  return [242, Math.round(90 + 110 * (x / w)), Math.round(40 + 160 * (y / h)), x < w * 0.08 ? 90 : 255];
}

function pixels(w, h, fn = motif) {
  const rgba = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) rgba.set(fn(x, y, w, h), (y * w + x) * 4);
  return rgba;
}

function png(w, h, rgba) {
  const pngChunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(w, 0);
  header.writeUInt32BE(h, 4);
  header[8] = 8;
  header[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Run-length encoded 32-bit TGA, stored bottom row first (the TGA default) to check the decoder turns it. */
function tga(w, h, rgba) {
  const header = Buffer.alloc(18);
  header[2] = 10;
  header.writeUInt16LE(w, 12);
  header.writeUInt16LE(h, 14);
  header[16] = 32;
  header[17] = 8;
  const packets = [];
  const bgra = (x, y) => {
    const o = (y * w + x) * 4;
    return [rgba[o + 2], rgba[o + 1], rgba[o], rgba[o + 3]];
  };
  for (let y = h - 1; y >= 0; y--) {
    let x = 0;
    while (x < w) {
      let run = 1;
      const p = bgra(x, y).join();
      while (x + run < w && run < 128 && bgra(x + run, y).join() === p) run++;
      if (run > 1) {
        packets.push(Buffer.from([0x80 | (run - 1), ...bgra(x, y)]));
        x += run;
        continue;
      }
      let raw = 1;
      while (x + raw < w && raw < 128 && bgra(x + raw, y).join() !== bgra(x + raw - 1, y).join()) raw++;
      packets.push(Buffer.from([raw - 1, ...Array.from({ length: raw }, (_, k) => bgra(x + k, y)).flat()]));
      x += raw;
    }
  }
  return Buffer.concat([header, ...packets, Buffer.from('\0\0\0\0\0\0\0\0TRUEVISION-XFILE.\0', 'latin1')]);
}

/** DXT1 (BC1) compressed DDS: per 4×4 block two 5:6:5 end colors and 2-bit indices. */
function dds(w, h, rgba) {
  const to565 = ([r, g, b]) => ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
  const from565 = (c) => [((c >> 11) & 31) * 255 / 31, ((c >> 5) & 63) * 255 / 63, (c & 31) * 255 / 31];
  const blocks = [];
  for (let by = 0; by < h; by += 4) {
    for (let bx = 0; bx < w; bx += 4) {
      const block = [];
      for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) {
        const o = (Math.min(by + y, h - 1) * w + Math.min(bx + x, w - 1)) * 4;
        block.push([rgba[o], rgba[o + 1], rgba[o + 2]]);
      }
      const luma = (c) => c[0] * 0.3 + c[1] * 0.59 + c[2] * 0.11;
      const sorted = [...block].sort((a, b) => luma(a) - luma(b));
      let c0 = to565(sorted[15]);
      let c1 = to565(sorted[0]);
      if (c0 < c1) [c0, c1] = [c1, c0];
      const p0 = from565(c0);
      const p1 = from565(c1);
      const palette = c0 === c1 ? [p0, p0, p0, p0] : [p0, p1, p0.map((v, i) => (2 * v + p1[i]) / 3), p0.map((v, i) => (v + 2 * p1[i]) / 3)];
      let indices = 0;
      block.forEach((c, i) => {
        let best = 0;
        let bestD = Infinity;
        palette.forEach((p, k) => {
          const d = (p[0] - c[0]) ** 2 + (p[1] - c[1]) ** 2 + (p[2] - c[2]) ** 2;
          if (d < bestD) [best, bestD] = [k, d];
        });
        indices |= best << (i * 2);
      });
      blocks.push(Buffer.concat([u16(c0), u16(c1), u32(indices)]));
    }
  }
  const header = Buffer.concat([
    Buffer.from('DDS ', 'latin1'), u32(124), u32(0x1 | 0x2 | 0x4 | 0x1000 | 0x80000), u32(h), u32(w), u32(blocks.length * 8), u32(0), u32(0),
    Buffer.alloc(44), u32(32), u32(0x4), Buffer.from('DXT1', 'latin1'), Buffer.alloc(20), u32(0x1000), Buffer.alloc(16),
  ]);
  return Buffer.concat([header, ...blocks]);
}

/** Linear-light sky for the HDR samples: blue gradient, a sun far brighter than white, dark ground. */
function sky(x, y, w, h) {
  const horizon = h * 0.62;
  if (y > horizon) {
    const t = (y - horizon) / (h - horizon);
    return [0.09 - 0.05 * t, 0.07 - 0.04 * t, 0.05 - 0.03 * t];
  }
  const t = y / horizon;
  const base = [0.15 + 0.6 * t, 0.3 + 0.5 * t, 0.85 + 0.1 * t];
  const d = Math.hypot(x - w * 0.7, y - h * 0.3);
  const sun = d < h * 0.06 ? 40 : 2.5 * Math.exp(-d / (h * 0.08));
  return base.map((v) => v + sun);
}

function rgbe(w, h) {
  const out = [Buffer.from(`#?RADIANCE\n# Sky, generated by scripts/generate-format-samples.mjs\nFORMAT=32-bit_rle_rgbe\n\n-Y ${h} +X ${w}\n`, 'latin1')];
  const data = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = sky(x, y, w, h);
      const v = Math.max(...c);
      const o = (y * w + x) * 4;
      if (v < 1e-32) continue;
      const e = Math.floor(Math.log2(v)) + 1;
      const scale = 256 / 2 ** e;
      data.set([...c.map((ch) => Math.min(255, Math.floor(ch * scale))), e + 128], o);
    }
  }
  out.push(data);
  return Buffer.concat(out);
}

async function exr(w, h) {
  // Bottom row first, as WebGL textures (and so the exporter) expect.
  const data = new Float32Array(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...sky(x, h - 1 - y, w, h), 1], (y * w + x) * 4);
  const texture = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType);
  return Buffer.from(await new EXRExporter().parse(texture, { type: THREE.HalfFloatType, compression: ZIP_COMPRESSION }));
}

function ktx2(w, h, rgba) {
  const container = createDefaultContainer();
  container.vkFormat = VK_FORMAT_R8G8B8A8_SRGB;
  container.typeSize = 1;
  container.pixelWidth = w;
  container.pixelHeight = h;
  container.levels = [{ levelData: new Uint8Array(rgba), uncompressedByteLength: rgba.length }];
  const dfd = container.dataFormatDescriptor[0];
  Object.assign(dfd, { colorModel: 1, colorPrimaries: 1, transferFunction: 2, texelBlockDimension: [0, 0, 0, 0], bytesPlane: [4, 0, 0, 0, 0, 0, 0, 0] });
  dfd.samples = [0, 1, 2, 15].map((channel, i) => ({ bitOffset: i * 8, bitLength: 7, channelType: channel | (channel === 15 ? 0x40 : 0), samplePosition: [0, 0, 0, 0], sampleLower: 0, sampleUpper: 255 }));
  return Buffer.from(writeKtx2(container));
}

// ---- Windows metafiles: the same flange drawing as WMF and EMF ------------------------------------------------

const FLANGE_HOLES = Array.from({ length: 6 }, (_, i) => [Math.cos((i * Math.PI) / 3), Math.sin((i * Math.PI) / 3)]);

function wmf() {
  const records = [];
  const rec = (fn, ...params) => {
    const body = Buffer.concat(params);
    records.push(Buffer.concat([u32(3 + body.length / 2), u16(fn), body]));
  };
  const rgb = (r, g, b) => u32(r | (g << 8) | (b << 16));
  rec(0x020b, i16(0), i16(0)); // SetWindowOrg
  rec(0x020c, i16(800), i16(1000)); // SetWindowExt (y, x)
  rec(0x02fa, u16(0), i16(3), i16(0), rgb(27, 30, 35)); // CreatePenIndirect → object 0
  rec(0x02fc, u16(0), rgb(242, 154, 56), u16(0)); // CreateBrushIndirect → object 1
  rec(0x012d, u16(0));
  rec(0x012d, u16(1));
  rec(0x0418, i16(700), i16(800), i16(100), i16(200)); // Ellipse (bottom, right, top, left): flange
  rec(0x01f0, u16(1)); // DeleteObject brush
  rec(0x02fc, u16(0), rgb(255, 255, 255), u16(0)); // white brush → object 1 again
  rec(0x012d, u16(1));
  rec(0x0418, i16(480), i16(580), i16(320), i16(420)); // bore
  for (const [c, s] of FLANGE_HOLES) {
    const x = Math.round(500 + 220 * c);
    const y = Math.round(400 + 220 * s);
    rec(0x0418, i16(y + 30), i16(x + 30), i16(y - 30), i16(x - 30));
  }
  rec(0x0325, u16(2), i16(150), i16(400), i16(850), i16(400)); // Polyline: center line
  rec(0x0325, u16(2), i16(500), i16(50), i16(500), i16(750));
  const face = Buffer.alloc(32);
  face.write('Arial', 'latin1');
  rec(0x02fb, i16(-48), i16(0), i16(0), i16(0), i16(700), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), face); // CreateFontIndirect → 2
  rec(0x012d, u16(2));
  rec(0x0102, u16(1)); // SetBkMode transparent
  rec(0x0209, rgb(27, 30, 35)); // SetTextColor
  const text = Buffer.from('Flange DN 100 (WMF)', 'latin1');
  rec(0x0521, u16(text.length), Buffer.concat([text, Buffer.alloc(text.length % 2)]), i16(745), i16(260)); // TextOut
  rec(0x0000);
  const body = Buffer.concat(records);
  const maxRecord = Math.max(...records.map((r) => r.readUInt32LE(0)));
  const meta = Buffer.concat([u16(1), u16(9), u16(0x0300), u32(9 + body.length / 2), u16(3), u32(maxRecord), u16(0)]);
  const placeable = Buffer.concat([u32(0x9ac6cdd7), u16(0), i16(0), i16(0), i16(1000), i16(800), u16(400), u32(0)]);
  let checksum = 0;
  for (let i = 0; i < 20; i += 2) checksum ^= placeable.readUInt16LE(i);
  return Buffer.concat([placeable, u16(checksum), meta, body]);
}

function emf() {
  const records = [];
  const rec = (type, ...params) => {
    const body = Buffer.concat(params);
    records.push(Buffer.concat([u32(type), u32(8 + body.length), body]));
  };
  const rect = (l, t, r, b) => Buffer.concat([i32(l), i32(t), i32(r), i32(b)]);
  const rgb = (r, g, b) => u32(r | (g << 8) | (b << 16));
  rec(17, u32(1)); // SetMapMode MM_TEXT
  rec(38, u32(1), u32(0), i32(3), i32(0), rgb(27, 30, 35)); // CreatePen 1
  rec(39, u32(2), u32(0), rgb(47, 127, 214), u32(0)); // CreateBrushIndirect 2 (blue)
  rec(39, u32(3), u32(0), rgb(255, 255, 255), u32(0)); // CreateBrushIndirect 3 (white)
  rec(37, u32(1));
  rec(37, u32(3));
  rec(43, rect(120, 40, 880, 760)); // Rectangle: white frame first
  rec(37, u32(2));
  rec(42, rect(200, 100, 800, 700)); // Ellipse: the flange in blue
  rec(37, u32(3));
  rec(42, rect(420, 320, 580, 480));
  for (const [c, s] of FLANGE_HOLES) {
    const x = Math.round(500 + 220 * c);
    const y = Math.round(400 + 220 * s);
    rec(42, rect(x - 30, y - 30, x + 30, y + 30));
  }
  rec(87, rect(150, 50, 850, 750), u32(2), i16(150), i16(400), i16(850), i16(400)); // Polyline16
  rec(87, rect(150, 50, 850, 750), u32(2), i16(500), i16(50), i16(500), i16(750));
  const face = Buffer.alloc(64);
  face.write('Arial', 'utf16le');
  rec(82, u32(4), i32(-48), i32(0), i32(0), i32(0), i32(700), Buffer.from([0, 0, 0, 0, 0, 0, 0, 0]), face); // ExtCreateFontIndirectW 4
  rec(37, u32(4));
  rec(18, u32(1)); // SetBkMode transparent
  rec(24, rgb(27, 30, 35)); // SetTextColor
  const text = Buffer.from('Flange DN 100 (EMF)', 'utf16le');
  const chars = text.length / 2;
  const offString = 8 + 16 + 12 + 40; // record header, bounds, mode and scales, EMRTEXT
  const dx = Buffer.concat(Array.from({ length: chars }, () => u32(26)));
  const padded = Buffer.concat([text, Buffer.alloc((4 - (text.length % 4)) % 4)]);
  rec(84, rect(0, 0, -1, -1), u32(1), f32(0), f32(0), i32(260), i32(706), u32(chars), u32(offString), u32(0), rect(0, 0, -1, -1), u32(offString + padded.length), padded, dx);
  rec(14, u32(0), u32(16), u32(20)); // EOF
  const body = Buffer.concat(records);
  const description = Buffer.from('OPSIS\0Flange sample\0\0', 'utf16le');
  const headerSize = 88 + description.length;
  const header = Buffer.concat([
    u32(1), u32(headerSize), rect(120, 40, 880, 760), rect(3168, 1056, 23232, 20064), u32(0x464d4520), u32(0x10000),
    u32(headerSize + body.length), u32(records.length + 1), u16(5), u16(0), u32(description.length / 2), u32(88), u32(0),
    i32(1000), i32(1000), i32(264), i32(264), description,
  ]);
  return Buffer.concat([header, body]);
}

// ---- CNC and 3D printing --------------------------------------------------------------------------------------

const POCKET_NC = `%
O1001 (POCKET AND CONTOUR - SAMPLE, NOT FOR REAL MACHINES)
(generated by scripts/generate-format-samples.mjs)
N10 G21 G17 G90 G40 G49 G80
N20 T1 M6 (D10 END MILL)
N30 S8000 M3
N40 G0 X0 Y0 Z10
(round pocket, helical ramp, then full circles)
N50 G0 X5 Y0 Z2
N60 G1 Z0 F300
N70 G3 X5 Y0 I-5 J0 Z-1
N80 G3 X5 Y0 I-5 J0 Z-2
N90 G3 X5 Y0 I-5 J0
N100 G1 X12 F600
N110 G3 X12 Y0 I-12 J0
N120 G1 X18
N130 G3 X18 Y0 I-18 J0
N140 G0 Z10
(outer contour with radius corners, R words)
N150 T2 M6 (D6 END MILL)
N160 S10000 M3
N170 G0 X-40 Y-30 Z5
N180 G1 Z-3 F200
N190 G1 X30 F800
N200 G2 X40 Y-20 R10
N210 G1 Y20
N220 G2 X30 Y30 R10
N230 G1 X-30
N240 G2 X-40 Y20 R10
N250 G1 Y-30
N260 G0 Z10
(peck drilling, return to the R plane between holes)
N270 T3 M6 (D5 DRILL)
N280 S3000 M3
N290 G0 X-30 Y-20 Z10
N300 G99 G83 X-30 Y-20 Z-12 R2 Q3 F150
N310 X30 Y-20
N320 X30 Y20
N330 G98 X-30 Y20
N340 G80
N350 G0 Z50
N360 M5
N370 M30
%
`;

function printerCube() {
  // A 20 mm hollow cube, 0.4 mm layers, two perimeters, travel moves between them.
  const lines = [
    '; Calibration cube, 20 x 20 x 4 mm, generated by scripts/generate-format-samples.mjs',
    '; not meant for real printers',
    'M140 S60',
    'M104 S210',
    'G28 ; home',
    'G90',
    'M82 ; absolute extrusion',
    'G92 E0',
  ];
  let e = 0;
  const per = 0.033;
  for (let layer = 1; layer <= 10; layer++) {
    const z = (layer * 0.4).toFixed(2);
    lines.push(`;LAYER:${layer - 1}`, `G0 Z${z} F3000`);
    for (const inset of [0, 0.45]) {
      const a = 90 + inset;
      const b = 110 - inset;
      lines.push(`G0 X${a.toFixed(2)} Y${a.toFixed(2)} F6000`);
      for (const [x, y] of [[b, a], [b, b], [a, b], [a, a]]) {
        e += (b - a) * per;
        lines.push(`G1 X${x.toFixed(2)} Y${y.toFixed(2)} E${e.toFixed(4)} F1800`);
      }
    }
  }
  lines.push('G1 E' + (e - 2).toFixed(4) + ' F2400 ; retract', 'G0 Z20', 'M104 S0', 'M140 S0', 'M84', '');
  return lines.join('\n');
}

// ---- Notebook ---------------------------------------------------------------------------------------------------

function notebook() {
  // Bar chart output as a PNG, drawn here.
  const chart = pixels(360, 200, (x, y) => {
    const bars = [120, 160, 90, 140];
    const i = Math.floor((x - 30) / 80);
    const inBar = i >= 0 && i < 4 && (x - 30) % 80 < 50 && y > 190 - bars[i] && y < 190;
    if (inBar) return [242, 154, 56, 255];
    if (y === 190 || x === 25) return [60, 60, 60, 255];
    return [255, 255, 255, 255];
  });
  const lines = (s) => s.split(/(?<=\n)/);
  const cells = [
    { cell_type: 'markdown', metadata: {}, source: lines('# Flange weights\n\nWeights of the **flange** sizes, from the parts list. *Sample notebook, generated by scripts/generate-format-samples.mjs.*') },
    { cell_type: 'code', execution_count: 1, metadata: {}, source: lines('import pandas as pd\n\nparts = pd.read_csv("parts.csv")\nparts.head(3)'), outputs: [
      { output_type: 'execute_result', execution_count: 1, metadata: {}, data: {
        'text/plain': lines('  size  weight_kg\n0  DN50       2.1\n1  DN80       3.4\n2  DN100      4.8'),
        'text/html': lines('<table class="dataframe"><thead><tr><th></th><th>size</th><th>weight_kg</th></tr></thead>\n<tbody><tr><th>0</th><td>DN50</td><td>2.1</td></tr><tr><th>1</th><td>DN80</td><td>3.4</td></tr><tr><th>2</th><td>DN100</td><td>4.8</td></tr></tbody></table>'),
      } },
    ] },
    { cell_type: 'code', execution_count: 2, metadata: {}, source: lines('print(f"Total: {parts.weight_kg.sum():.1f} kg")\nparts.plot.bar(x="size", y="weight_kg")'), outputs: [
      { output_type: 'stream', name: 'stdout', text: lines('Total: 10.3 kg\n') },
      { output_type: 'display_data', metadata: {}, data: { 'image/png': png(360, 200, chart).toString('base64'), 'text/plain': ['<Figure size 360x200>'] } },
    ] },
    { cell_type: 'markdown', metadata: {}, source: lines('## A cell that failed\n\nTracebacks keep their terminal colors in the file; the viewer removes them.') },
    { cell_type: 'code', execution_count: 3, metadata: {}, source: lines('parts.loc["DN125"]'), outputs: [
      { output_type: 'error', ename: 'KeyError', evalue: "'DN125'", traceback: ['\u001b[0;31m---------------------------------------------------------------------------\u001b[0m', '\u001b[0;31mKeyError\u001b[0m: \'DN125\''] },
    ] },
  ];
  return `${JSON.stringify({ cells, metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }, language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 }, null, 1)}\n`;
}

// ---- Comics -----------------------------------------------------------------------------------------------------

/** Digits as 3 × 5 blocks, for page numbers drawn without fonts. */
const DIGITS = ['111101101101111', '010110010010111', '111001111100111', '111001111001111', '101101111001001', '111100111001111'];

function comicPage(page) {
  const palette = [[255, 236, 200], [210, 235, 255], [225, 250, 215], [255, 220, 230], [235, 225, 255]];
  return pixels(600, 900, (x, y) => {
    const margin = 30;
    const gutter = 20;
    if (x < margin || x >= 600 - margin || y < margin || y >= 900 - margin) return [250, 250, 248, 255];
    // Three rows of panels: one wide, two side by side, one wide.
    const rowH = (900 - 2 * margin - 2 * gutter) / 3;
    const row = Math.floor((y - margin) / (rowH + gutter));
    const inRowY = (y - margin) % (rowH + gutter);
    if (inRowY > rowH) return [250, 250, 248, 255];
    const half = (600 - 2 * margin - gutter) / 2;
    if (row === 1 && x - margin > half && x - margin < half + gutter) return [250, 250, 248, 255];
    const border = inRowY < 4 || inRowY > rowH - 4 || x < margin + 4 || x > 600 - margin - 4 || (row === 1 && Math.abs(x - margin - half) < 4) || (row === 1 && Math.abs(x - margin - half - gutter) < 4);
    if (border) return [30, 30, 30, 255];
    // The page number, big, in the first panel.
    const cx = Math.floor((x - 250) / 22);
    const cy = Math.floor((y - margin - 40) / 22);
    if (row === 0 && cx >= 0 && cx < 3 && cy >= 0 && cy < 5 && DIGITS[page][cy * 3 + cx] === '1') return [30, 30, 30, 255];
    return [...palette[(page + row) % palette.length], 255];
  });
}

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.concat([u32(0x04034b50), u16(10), u16(0x800), u16(0), u16(0), u16(0x5b21), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data]);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(10), u16(0x800), u16(0), u16(0), u16(0x5b21), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
}

function tar(entries) {
  const blocks = [];
  for (const [name, data] of entries) {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, 'utf8');
    header.write('0000644\0', 100, 'latin1');
    header.write('0000000\0', 108, 'latin1');
    header.write('0000000\0', 116, 'latin1');
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'latin1');
    header.write(`${Math.floor(Date.UTC(2026, 9, 27) / 1000).toString(8).padStart(11, '0')}\0`, 136, 'latin1');
    header.write('        ', 148, 'latin1');
    header.write('0', 156, 'latin1');
    header.write('ustar\0', 257, 'latin1');
    header.write('00', 263, 'latin1');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}

// ---- Calendar, contacts, shortcuts -------------------------------------------------------------------------------

const CALENDAR = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//OPSIS//Sample generator//EN
X-WR-CALNAME:Workshop planning
BEGIN:VTIMEZONE
TZID:Europe/Berlin
BEGIN:DAYLIGHT
TZOFFSETFROM:+0100
TZOFFSETTO:+0200
TZNAME:CEST
DTSTART:19700329T020000
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU
END:DAYLIGHT
BEGIN:STANDARD
TZOFFSETFROM:+0200
TZOFFSETTO:+0100
TZNAME:CET
DTSTART:19701025T030000
RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
UID:design-review@samples.opsis
DTSTAMP:20261027T080000Z
DTSTART;TZID=Europe/Berlin:20261103T100000
DTEND;TZID=Europe/Berlin:20261103T113000
SUMMARY:Design review: flange DN 100
LOCATION:Meeting room 2
ORGANIZER;CN=Alex Example:mailto:alex@example.com
ATTENDEE;CN=Sam Sample;ROLE=REQ-PARTICIPANT:mailto:sam@example.com
ATTENDEE;CN=Robin Test;ROLE=OPT-PARTICIPANT:mailto:robin@example.com
DESCRIPTION:Check the drilling pattern and the material list.\\nBring the latest drawing.
URL:https://example.com/projects/flange
END:VEVENT
BEGIN:VEVENT
UID:standup@samples.opsis
DTSTAMP:20261027T080000Z
DTSTART;TZID=Europe/Berlin:20261102T090000
DTEND;TZID=Europe/Berlin:20261102T091500
RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=12
SUMMARY:Stand-up
LOCATION:Workshop
END:VEVENT
BEGIN:VEVENT
UID:trade-fair@samples.opsis
DTSTAMP:20261027T080000Z
DTSTART;VALUE=DATE:20261110
DTEND;VALUE=DATE:20261113
SUMMARY:Trade fair
LOCATION:Exhibition centre, hall 4
END:VEVENT
BEGIN:VTODO
UID:order-material@samples.opsis
DTSTAMP:20261027T080000Z
DUE;VALUE=DATE:20261105
SUMMARY:Order steel plates
STATUS:NEEDS-ACTION
END:VTODO
END:VCALENDAR
`.replace(/\n/g, '\r\n');

function contacts() {
  const avatar = png(64, 64, pixels(64, 64, (x, y) => (Math.hypot(x - 32, y - 24) < 12 || (y > 40 && Math.hypot(x - 32, y - 64) < 26) ? [255, 255, 255, 255] : [242, 154, 56, 255])));
  const fold = (line) => line.match(/.{1,74}/g).join('\r\n ');
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    'N:Example;Alex;;;',
    'FN:Alex Example',
    'ORG:Example Engineering Ltd.',
    'TITLE:Project lead',
    'EMAIL;TYPE=WORK:alex@example.com',
    'TEL;TYPE=WORK,VOICE:+49 421 0000000',
    'TEL;TYPE=CELL:+49 170 0000000',
    'ADR;TYPE=WORK:;;Sample Street 1;Sample Town;;12345;Germany',
    'URL:https://example.com',
    fold(`PHOTO;ENCODING=b;TYPE=PNG:${avatar.toString('base64')}`),
    'NOTE:Sample contact\\, generated by scripts/generate-format-samples.mjs.',
    'END:VCARD',
    'BEGIN:VCARD',
    'VERSION:4.0',
    'FN:Sam Sample',
    'N:Sample;Sam;;;',
    'ORG:Example Engineering Ltd.;Workshop',
    'EMAIL:sam@example.com',
    'TEL;TYPE=work:tel:+49-421-0000001',
    'BDAY:19900412',
    'END:VCARD',
    '',
  ].join('\r\n');
}

/** Windows shortcut ([MS-SHLLINK]) to a program, with arguments, working folder and description in Unicode. */
function lnk() {
  const target = 'C:\\Program Files\\Example\\viewer.exe';
  const header = Buffer.concat([
    u32(0x4c), Buffer.from('0114020000000000c000000000000046', 'hex'),
    u32(0x2 | 0x4 | 0x10 | 0x20 | 0x40 | 0x80), // HasLinkInfo, HasName, HasWorkingDir, HasArguments, HasIconLocation, IsUnicode
    u32(0x20), // archive
    ...[0, 0, 0].map(() => Buffer.concat([u32(0x2a278000), u32(0x01dd65e9)])), // 2026-10-27 08:00 UTC as FILETIME, all three times
    u32(1536000), u32(0), u32(1), u16(0), u16(0), u32(0), u32(0),
  ]);
  const label = Buffer.from('System\0', 'latin1');
  const volume = Buffer.concat([u32(16 + label.length), u32(3), u32(0x1a2b3c4d), u32(16), label]);
  const base = Buffer.from(`${target}\0`, 'latin1');
  const linkInfoHeader = 28;
  const volumeOffset = linkInfoHeader;
  const baseOffset = volumeOffset + volume.length;
  const suffixOffset = baseOffset + base.length;
  const linkInfoBody = Buffer.concat([volume, base, Buffer.from('\0', 'latin1')]);
  const linkInfo = Buffer.concat([u32(linkInfoHeader + linkInfoBody.length), u32(linkInfoHeader), u32(1), u32(volumeOffset), u32(baseOffset), u32(0), u32(suffixOffset), linkInfoBody]);
  const stringData = (s) => Buffer.concat([u16(s.length), Buffer.from(s, 'utf16le')]);
  return Buffer.concat([
    header, linkInfo,
    stringData('Opens the sample drawing in the viewer'),
    stringData('C:\\Projects\\Flange'),
    stringData('--readonly "flange.dxf"'),
    stringData('C:\\Program Files\\Example\\viewer.exe'),
    u32(0),
  ]);
}

const URL_SHORTCUT = '[InternetShortcut]\r\nURL=https://example.com/projects/flange\r\nIconIndex=0\r\n';
const DESKTOP_ENTRY = `[Desktop Entry]
Type=Application
Name=Drawing viewer
Comment=Opens drawings read-only (sample, generated by scripts/generate-format-samples.mjs)
Exec=viewer --readonly %f
Icon=viewer
Terminal=false
Categories=Graphics;Engineering;
`;
const WEBLOC = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>URL</key>
\t<string>https://example.com/projects/flange?view=drawing&amp;sheet=1</string>
</dict>
</plist>
`;

// ---- Generate -----------------------------------------------------------------------------------------------

write('3d/bracket.fbx', fbx());
write('3d/bracket.dae', collada());
write('3d/bracket.3ds', threeDs());
write('3d/bracket.amf', amf());
write('3d/bracket.wrl', vrml());
write('3d/bracket.wrz', gzipSync(Buffer.from(vrml())));
write('3d/bracket.vtp', vtp());
write('3d/torus.vtk', vtkLegacy());
write('3d/bracket.usda', usda());
write('3d/bracket.usdz', storedZip([['bracket.usda', Buffer.from(usda())]]));
write('3d/dome-scan.pcd', pcd());
write('3d/terrain.xyz', xyz());
write('3d/torus.off', off());
write('3d/pavilion.bim', dotbim());
write('3d/house.vox', vox());
write('3d/bracket.3dm', await rhino3dm());

const motifRgba = pixels(320, 200);
write('images/motif.tga', tga(320, 200, motifRgba));
write('images/motif.dds', dds(320, 200, motifRgba));
write('images/motif.ktx2', ktx2(320, 200, motifRgba));
write('images/sky.hdr', rgbe(256, 128));
write('images/sky.exr', await exr(512, 256));
write('images/flange.wmf', wmf());
write('images/flange.emf', emf());

write('cnc/pocket-contour.nc', POCKET_NC);
write('cnc/calibration-cube.gcode', printerCube());

write('text/flange-weights.ipynb', notebook());

const pages = Array.from({ length: 5 }, (_, i) => [`pages/page-${i + 1}.png`, png(600, 900, comicPage(i + 1))]);
write('books/comic.cbz', storedZip(pages));
write('books/comic.cbt', tar(pages));

write('mail/workshop.ics', CALENDAR);
write('mail/contacts.vcf', contacts());

write('shortcuts/viewer.lnk', lnk());
write('shortcuts/website.url', URL_SHORTCUT);
write('shortcuts/viewer.desktop', DESKTOP_ENTRY);
write('shortcuts/page.webloc', WEBLOC);

for (const [rel, size] of written) console.log(`${String(size).padStart(8)}  samples/${rel}`);
