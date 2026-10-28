// SPDX-License-Identifier: GPL-3.0-or-later
// Writes the map data samples to samples/gis/: GeoJSON, TopoJSON, GPX, KML, KMZ and a zipped shapefile set in
// ETRS89 / UTM zone 32N (EPSG:25832). All features are made up and placed in a public park (around the lake of the
// Englischer Garten in Munich); the output can be published as CC0-1.0 like the other samples.
// Usage: node scripts/generate-gis-samples.mjs [file ...] (after npm install: needs proj4). With file names (relative to
// samples/), only those are written.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import proj4 from 'proj4';

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

const u16 = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v); return b; };
const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const escapeXml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- The park ---------------------------------------------------------------------------------------------------

const LON0 = 11.5935;
const LAT0 = 48.1585;
// Meters per degree at this latitude (WGS84).
const M_PER_LAT = 111195;
const M_PER_LON = 74386;

/** Offset in meters east/north of the park center → [lon, lat]. */
const ll = (dx, dy) => [Number((LON0 + dx / M_PER_LON).toFixed(7)), Number((LAT0 + dy / M_PER_LAT).toFixed(7))];
const ring = (points) => [...points.map(([x, y]) => ll(x, y)), ll(...points[0])];
const oval = (cx, cy, rx, ry, n, start = 0) => Array.from({ length: n }, (_, i) => {
  const a = start + (i / n) * 2 * Math.PI;
  return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
});

const MEADOW = [[-260, -40], [-60, -120], [140, -80], [180, 60], [20, 170], [-200, 130]];
const POND = oval(-20, 30, 45, 30, 10);
const PLAYGROUND = [[200, -60], [262, -52], [256, -4], [194, -12]];
const LAKESIDE_PATH = [[-300, -150], [-150, -182], [0, -176], [150, -142], [260, -100], [320, -20]];
const BIKE_ROUTE = [[-320, 200], [-100, 232], [100, 250], [300, 222], [420, 120], [452, -50]];
const BIKE_SPUR = [[100, 250], [130, 330], [180, 400]];
const POIS = [
  { name: 'Viewpoint', category: 'viewpoint', at: [150, 120], capacity: 20, rating: 4.6, opened: '2021-06-12', accessible: true },
  { name: 'Kiosk', category: 'food', at: [240, 40], capacity: 35, rating: 4.1, opened: '2019-04-01', accessible: true },
  { name: 'Boat rental', category: 'sport', at: [-120, -150], capacity: 12, rating: 4.4, opened: '2018-05-01', accessible: false },
  { name: 'Information board', category: 'info', at: [-280, 20], capacity: null, rating: null, opened: '2020-03-15', accessible: true },
];
const BENCHES = [[-40, -140], [60, -150], [180, -110]];
const TREES = [
  { species: 'Linde (Tilia cordata)', at: [-150, 60], height: 18.5, planted: '1962-11-03', protected: true },
  { species: 'Rotbuche (Fagus sylvatica)', at: [-90, 120], height: 24.0, planted: '1948-04-20', protected: true },
  { species: 'Stieleiche (Quercus robur)', at: [60, 110], height: 21.2, planted: '1955-10-11', protected: true },
  { species: 'Spitzahorn (Acer platanoides)', at: [110, -40], height: 15.7, planted: '1987-03-28', protected: false },
  { species: 'Hängebirke (Betula pendula)', at: [-200, -10], height: 12.3, planted: '2001-04-05', protected: false },
  { species: 'Rosskastanie (Aesculus)', at: [230, 90], height: 17.9, planted: '1973-09-30', protected: false },
];

// ---- GeoJSON ----------------------------------------------------------------------------------------------------

const feature = (geometry, properties) => ({ type: 'Feature', properties, geometry });
function geojson() {
  const features = [
    feature({ type: 'Polygon', coordinates: [ring(MEADOW), ring([...POND].reverse())] }, { name: 'Sample meadow', category: 'meadow', area_ha: 8.6, opened: '2019-05-04', accessible: true, capacity: null, note: 'The pond in the middle is a hole in the polygon.' }),
    feature({ type: 'Polygon', coordinates: [ring(PLAYGROUND)] }, { name: 'Playground', category: 'playground', area_ha: 0.29, opened: '2022-07-01', accessible: true, capacity: 60, note: null, fill: '#e8a33d', 'fill-opacity': 0.5, stroke: '#b06d10', 'stroke-width': 2 }),
    feature({ type: 'LineString', coordinates: LAKESIDE_PATH.map(([x, y]) => ll(x, y)) }, { name: 'Lakeside path', category: 'path', surface: 'gravel', width_m: 3.5, lit: false }),
    feature({ type: 'MultiLineString', coordinates: [BIKE_ROUTE.map(([x, y]) => ll(x, y)), BIKE_SPUR.map(([x, y]) => ll(x, y))] }, { name: 'Bike route', category: 'path', surface: 'asphalt', width_m: 4, lit: true, stroke: '#2f7fd6', 'stroke-width': 3 }),
    ...POIS.map((p) => feature({ type: 'Point', coordinates: ll(...p.at) }, { name: p.name, category: p.category, capacity: p.capacity, rating: p.rating, opened: p.opened, accessible: p.accessible, 'marker-color': '#d9443c' })),
    feature({ type: 'MultiPoint', coordinates: BENCHES.map(([x, y]) => ll(x, y)) }, { name: 'Benches', category: 'bench', capacity: 9 }),
    feature(null, { name: 'Park office', category: 'office', note: 'A feature without geometry: listed in the table, not on the map.' }),
  ];
  return `${JSON.stringify({ type: 'FeatureCollection', name: 'park', features }, null, 1)}\n`;
}

// ---- TopoJSON ---------------------------------------------------------------------------------------------------

/** Two meadows sharing one border arc, the path along it and a gate, quantized to 0–1000 over 400 × 300 m. */
function topojson() {
  const scale = [Number((400 / M_PER_LON / 1000).toPrecision(8)), Number((300 / M_PER_LAT / 1000).toPrecision(8))];
  const translate = ll(-200, 260);
  return `${JSON.stringify({
    type: 'Topology',
    transform: { scale, translate },
    objects: {
      meadows: {
        type: 'GeometryCollection',
        geometries: [
          { type: 'Polygon', arcs: [[0, 1]], properties: { name: 'North meadow', mowed: '2026-06-10' } },
          { type: 'Polygon', arcs: [[-1, 2]], properties: { name: 'South meadow', mowed: '2026-06-24' } },
        ],
      },
      paths: { type: 'GeometryCollection', geometries: [{ type: 'LineString', arcs: [0], properties: { name: 'Dividing path' } }] },
      gates: { type: 'GeometryCollection', geometries: [{ type: 'Point', coordinates: [500, 0], properties: { name: 'South gate' } }] },
    },
    arcs: [
      [[0, 500], [500, 20], [500, -20]],
      [[1000, 500], [0, 500], [-1000, 0], [0, -500]],
      [[0, 500], [0, -500], [1000, 0], [0, 500]],
    ],
  })}\n`;
}

// ---- GPX --------------------------------------------------------------------------------------------------------

function gpx() {
  const start = Date.UTC(2026, 4, 16, 7, 30, 0);
  const loop = oval(-30, 20, 330, 230, 260, -Math.PI / 2);
  loop.push(loop[0]);
  const points = loop.map(([x, y], i) => {
    const a = (i / 260) * 2 * Math.PI;
    const [lon, lat] = ll(x, y);
    const ele = (517 + 4 * Math.sin(a) + 1.5 * Math.sin(3 * a)).toFixed(1);
    const time = new Date(start + i * 7500).toISOString().replace('.000Z', 'Z');
    return `      <trkpt lat="${lat}" lon="${lon}"><ele>${ele}</ele><time>${time}</time></trkpt>`;
  });
  const wpt = (name, [x, y], sym, desc) => {
    const [lon, lat] = ll(x, y);
    return `  <wpt lat="${lat}" lon="${lon}"><ele>517.0</ele><name>${escapeXml(name)}</name><desc>${escapeXml(desc)}</desc><sym>${sym}</sym></wpt>`;
  };
  const route = [[-330, -60], [-300, -150], [-150, -182], [0, -176], [100, -150]].map(([x, y]) => {
    const [lon, lat] = ll(x, y);
    return `    <rtept lat="${lat}" lon="${lon}"/>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="peekbean sample generator" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Lake loop (sample)</name><time>2026-05-16T07:30:00Z</time></metadata>
${wpt('Start / finish', loop[0], 'Flag, Blue', 'Start and finish of the loop')}
${wpt('Footbridge', [-360, 20], 'Bridge', 'Narrow wooden bridge')}
${wpt('Water station', [280, 60], 'Drinking Water', 'Fountain next to the kiosk')}
  <rte>
    <name>Planned warm-up</name>
${route.join('\n')}
  </rte>
  <trk>
    <name>Morning run</name>
    <type>running</type>
    <trkseg>
${points.join('\n')}
    </trkseg>
  </trk>
</gpx>
`;
}

// ---- KML and KMZ ------------------------------------------------------------------------------------------------

const coords = (points) => points.map(([lon, lat]) => `${lon},${lat},0`).join(' ');
const placemark = (name, style, geometry, extra = '') => `      <Placemark>
        <name>${escapeXml(name)}</name>${extra}
        <styleUrl>#${style}</styleUrl>
        ${geometry}
      </Placemark>`;
const data = (pairs) => `
        <ExtendedData>${Object.entries(pairs).map(([k, v]) => `<Data name="${k}"><value>${escapeXml(String(v))}</value></Data>`).join('')}</ExtendedData>`;

function kml({ networkLink }) {
  const [w, s] = ll(196, -64);
  const [e, n] = ll(266, 0);
  return `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>Park features (sample)</name>
    <Style id="path"><LineStyle><color>ffd67f2f</color><width>4</width></LineStyle></Style>
    <Style id="meadow"><LineStyle><color>ff528a1f</color><width>2</width></LineStyle><PolyStyle><color>6652c25c</color></PolyStyle></Style>
    <Style id="playground"><PolyStyle><color>993da3e8</color><outline>0</outline></PolyStyle></Style>
    <Style id="poi-normal"><IconStyle><color>ff3c44d9</color><scale>1.1</scale><Icon><href>files/marker.png</href></Icon><hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle></Style>
    <Style id="poi-highlight"><IconStyle><color>ff3c44d9</color><scale>1.4</scale><Icon><href>files/marker.png</href></Icon><hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle></Style>
    <StyleMap id="poi"><Pair><key>normal</key><styleUrl>#poi-normal</styleUrl></Pair><Pair><key>highlight</key><styleUrl>#poi-highlight</styleUrl></Pair></StyleMap>
    <Style id="bench"><IconStyle><color>ff2fa8e8</color><scale>0.8</scale><Icon><href>files/marker.png</href></Icon><hotSpot x="0.5" y="0" xunits="fraction" yunits="fraction"/></IconStyle></Style>
    <Folder>
      <name>Paths</name>
${placemark('Lakeside path', 'path', `<LineString><coordinates>${coords(LAKESIDE_PATH.map(([x, y]) => ll(x, y)))}</coordinates></LineString>`, data({ surface: 'gravel', width_m: 3.5 }))}
${placemark('Bike route', 'path', `<MultiGeometry><LineString><coordinates>${coords(BIKE_ROUTE.map(([x, y]) => ll(x, y)))}</coordinates></LineString><LineString><coordinates>${coords(BIKE_SPUR.map(([x, y]) => ll(x, y)))}</coordinates></LineString></MultiGeometry>`, data({ surface: 'asphalt', width_m: 4 }))}
    </Folder>
    <Folder>
      <name>Areas</name>
${placemark('Sample meadow', 'meadow', `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords(ring(MEADOW))}</coordinates></LinearRing></outerBoundaryIs><innerBoundaryIs><LinearRing><coordinates>${coords(ring(POND))}</coordinates></LinearRing></innerBoundaryIs></Polygon>`, '\n        <description>The pond in the middle is a hole in the polygon.</description>')}
${placemark('Playground', 'playground', `<Polygon><outerBoundaryIs><LinearRing><coordinates>${coords(ring(PLAYGROUND))}</coordinates></LinearRing></outerBoundaryIs></Polygon>`)}
      <GroundOverlay>
        <name>Playground plan</name>
        <Icon><href>files/plan.png</href></Icon>
        <LatLonBox><north>${n}</north><south>${s}</south><east>${e}</east><west>${w}</west></LatLonBox>
      </GroundOverlay>
    </Folder>
    <Folder>
      <name>Points of interest</name>
${POIS.map((p) => placemark(p.name, 'poi', `<Point><coordinates>${coords([ll(...p.at)])}</coordinates></Point>`, p.name === 'Kiosk'
    ? `\n        <description><![CDATA[<b>Open</b> daily<br>9:00–18:00]]></description>${data({ category: p.category, capacity: p.capacity })}`
    : data({ category: p.category, capacity: p.capacity ?? '' }))).join('\n')}
      <Folder>
        <name>Benches</name>
        <visibility>0</visibility>
${BENCHES.map((b, i) => placemark(`Bench ${i + 1}`, 'bench', `<Point><coordinates>${coords([ll(...b)])}</coordinates></Point>`)).join('\n')}
      </Folder>
    </Folder>${networkLink ? `
    <NetworkLink>
      <name>Live updates (never loaded by the viewer)</name>
      <Link><href>https://example.com/live-updates.kml</href></Link>
    </NetworkLink>` : ''}
  </Document>
</kml>
`;
}

/** PNG from an RGBA function, 4 × 4 supersampled for smooth edges. */
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0, 0];
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const [r, g, b, a] = pixel(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
        sum[0] += r * a; sum[1] += g * a; sum[2] += b * a; sum[3] += a;
      }
      const o = y * (width * 4 + 1) + 1 + x * 4;
      const alpha = sum[3] / 16;
      raw[o] = alpha ? Math.round(sum[0] / sum[3]) : 0;
      raw[o + 1] = alpha ? Math.round(sum[1] / sum[3]) : 0;
      raw[o + 2] = alpha ? Math.round(sum[2] / sum[3]) : 0;
      raw[o + 3] = Math.round(alpha);
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'latin1'), body])));
    return Buffer.concat([len, Buffer.from(type, 'latin1'), body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/** White map pin with a dark rim; KML tints it with the icon color. Its tip is the bottom center. */
function markerPng() {
  const inPin = (x, y, grow) => Math.hypot(x - 16, y - 12) <= 9 + grow || (y >= 12 && y <= 31 + grow && Math.abs(x - 16) <= ((31 - y) / 19) * 7.5 + grow);
  return png(32, 32, (x, y) => {
    if (Math.hypot(x - 16, y - 12) <= 3.5) return [60, 60, 60, 255];
    if (inPin(x, y, 0)) return [255, 255, 255, 255];
    if (inPin(x, y, 1.6)) return [40, 40, 40, 255];
    return [0, 0, 0, 0];
  });
}

/** A sketched plan for the ground overlay: paper with a grid, a sandpit and a path. */
function planPng() {
  return png(160, 128, (x, y) => {
    if (x < 3 || y < 3 || x > 157 || y > 125) return [90, 70, 40, 230];
    if (Math.hypot(x - 52, y - 60) < 24) return [232, 190, 110, 230];
    if (Math.abs(y - 0.4 * x - 40) < 4) return [150, 150, 150, 230];
    if (x % 20 < 1 || y % 20 < 1) return [180, 170, 150, 200];
    return [250, 244, 228, 170];
  });
}

function storedZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    // Fixed time stamp 2026-10-27 12:00, so the output does not change between runs.
    const local = Buffer.concat([u32(0x04034b50), u16(10), u16(0x800), u16(0), u16(0x6000), u16(0x5d5b), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), nameBytes, data]);
    centrals.push(Buffer.concat([u32(0x02014b50), u16(20), u16(10), u16(0x800), u16(0), u16(0x6000), u16(0x5d5b), u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset), nameBytes]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  return Buffer.concat([...locals, central, u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length), u32(central.length), u32(offset), u16(0)]);
}

// ---- Shapefile ----------------------------------------------------------------------------------------------------

const UTM32 = proj4('+proj=utm +zone=32 +ellps=GRS80 +units=m +no_defs');
const PRJ_25832 = 'PROJCS["ETRS_1989_UTM_Zone_32N",GEOGCS["GCS_ETRS_1989",DATUM["D_ETRS_1989",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",9.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
/** Park offset in meters → EPSG:25832 easting/northing, to the centimeter. */
const utm = ([dx, dy]) => UTM32.forward(ll(dx, dy)).map((v) => Math.round(v * 100) / 100);

const signedArea = (points) => points.reduce((sum, [x, y], i) => {
  const [nx, ny] = points[(i + 1) % points.length];
  return sum + (x * ny - nx * y);
}, 0) / 2;
/** Shapefile rings: outer rings clockwise, holes counterclockwise, each closed. */
const shpRing = (points, hole) => {
  const p = signedArea(points) > 0 !== hole ? [...points].reverse() : [...points];
  return [...p, p[0]];
};

/** .shp and .shx for one shape type (1 point, 3 polyline, 5 polygon); shapes are points or arrays of parts. */
function shapefile(type, shapes) {
  const contents = shapes.map((shape) => {
    if (type === 1) {
      const b = Buffer.alloc(20);
      b.writeInt32LE(1, 0);
      b.writeDoubleLE(shape[0], 4);
      b.writeDoubleLE(shape[1], 12);
      return b;
    }
    const points = shape.flat();
    const b = Buffer.alloc(44 + 4 * shape.length + 16 * points.length);
    b.writeInt32LE(type, 0);
    const xs = points.map((p) => p[0]);
    const ys = points.map((p) => p[1]);
    [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].forEach((v, i) => b.writeDoubleLE(v, 4 + 8 * i));
    b.writeInt32LE(shape.length, 36);
    b.writeInt32LE(points.length, 40);
    let index = 0;
    shape.forEach((part, i) => {
      b.writeInt32LE(index, 44 + 4 * i);
      index += part.length;
    });
    points.forEach(([x, y], i) => {
      b.writeDoubleLE(x, 44 + 4 * shape.length + 16 * i);
      b.writeDoubleLE(y, 52 + 4 * shape.length + 16 * i);
    });
    return b;
  });
  const all = shapes.flatMap((s) => (type === 1 ? [s] : s.flat()));
  const bounds = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
  const header = (words) => {
    const b = Buffer.alloc(100);
    b.writeInt32BE(9994, 0);
    b.writeInt32BE(words, 24);
    b.writeInt32LE(1000, 28);
    b.writeInt32LE(type, 32);
    bounds.forEach((v, i) => b.writeDoubleLE(v, 36 + 8 * i));
    return b;
  };
  const records = [];
  const index = [];
  let offset = 50;
  contents.forEach((content, i) => {
    const head = Buffer.alloc(8);
    head.writeInt32BE(i + 1, 0);
    head.writeInt32BE(content.length / 2, 4);
    records.push(head, content);
    const entry = Buffer.alloc(8);
    entry.writeInt32BE(offset, 0);
    entry.writeInt32BE(content.length / 2, 4);
    index.push(entry);
    offset += 4 + content.length / 2;
  });
  return { shp: Buffer.concat([header(offset), ...records]), shx: Buffer.concat([header(50 + 4 * shapes.length), ...index]) };
}

/** dBASE III table; text fields hold UTF-8 (the .cpg file says so). */
function dbf(fields, records) {
  const recordLength = 1 + fields.reduce((sum, f) => sum + f.length, 0);
  const headerLength = 32 + 32 * fields.length + 1;
  const header = Buffer.alloc(32);
  header[0] = 0x03;
  header.set([126, 10, 27], 1);
  header.writeUInt32LE(records.length, 4);
  header.writeUInt16LE(headerLength, 8);
  header.writeUInt16LE(recordLength, 10);
  const descriptors = fields.map((f) => {
    const b = Buffer.alloc(32);
    b.write(f.name, 0, 10, 'latin1');
    b.write(f.type, 11, 1, 'latin1');
    b[16] = f.length;
    b[17] = f.decimals ?? 0;
    return b;
  });
  const rows = records.map((record) => {
    const row = Buffer.alloc(recordLength, 0x20);
    let at = 1;
    for (const f of fields) {
      const v = record[f.name];
      let text = '';
      if (v === null || v === undefined) text = f.type === 'L' ? '?' : '';
      else if (f.type === 'N') text = Number(v).toFixed(f.decimals ?? 0).padStart(f.length);
      else if (f.type === 'D') text = v.replace(/-/g, '');
      else if (f.type === 'L') text = v ? 'T' : 'F';
      else text = String(v);
      let bytes = Buffer.from(text, 'utf8');
      // Cut at a character boundary.
      while (bytes.length > f.length) bytes = Buffer.from(text = text.slice(0, -1), 'utf8');
      bytes.copy(row, at);
      at += f.length;
    }
    return row;
  });
  return Buffer.concat([header, ...descriptors, Buffer.from([0x0d]), ...rows, Buffer.from([0x1a])]);
}

function shapefileZip() {
  const files = [];
  const add = (name, type, shapes, fields, records) => {
    const { shp, shx } = shapefile(type, shapes);
    files.push([`${name}.shp`, shp], [`${name}.shx`, shx], [`${name}.dbf`, dbf(fields, records)], [`${name}.prj`, Buffer.from(PRJ_25832)], [`${name}.cpg`, Buffer.from('UTF-8')]);
  };
  add(
    'park_areas', 5,
    [[shpRing(MEADOW.map(utm), false), shpRing(POND.map(utm), true)], [shpRing(PLAYGROUND.map(utm), false)]],
    [{ name: 'AREA_ID', type: 'N', length: 6 }, { name: 'NAME', type: 'C', length: 40 }, { name: 'CATEGORY', type: 'C', length: 20 }, { name: 'AREA_M2', type: 'N', length: 12, decimals: 1 }, { name: 'SURVEYED', type: 'D', length: 8 }, { name: 'PUBLIC', type: 'L', length: 1 }],
    [
      { AREA_ID: 101, NAME: 'Große Wiese (Beispiel)', CATEGORY: 'Wiese', AREA_M2: 80412.5, SURVEYED: '2025-09-18', PUBLIC: true },
      { AREA_ID: 102, NAME: 'Spielplatz Süd', CATEGORY: 'Spielplatz', AREA_M2: 2891.0, SURVEYED: '2026-03-02', PUBLIC: null },
    ],
  );
  add(
    'park_paths', 3,
    [[LAKESIDE_PATH.map(utm)], [BIKE_ROUTE.map(utm), BIKE_SPUR.map(utm)]],
    [{ name: 'NAME', type: 'C', length: 40 }, { name: 'SURFACE', type: 'C', length: 12 }, { name: 'WIDTH_M', type: 'N', length: 5, decimals: 1 }, { name: 'LIT', type: 'L', length: 1 }],
    [
      { NAME: 'Uferweg', SURFACE: 'Kies', WIDTH_M: 3.5, LIT: false },
      { NAME: 'Radroute mit Abzweig', SURFACE: 'Asphalt', WIDTH_M: 4, LIT: true },
    ],
  );
  add(
    'park_trees', 1,
    TREES.map((t) => utm(t.at)),
    [{ name: 'TREE_ID', type: 'N', length: 6 }, { name: 'SPECIES', type: 'C', length: 40 }, { name: 'HEIGHT_M', type: 'N', length: 5, decimals: 1 }, { name: 'PLANTED', type: 'D', length: 8 }, { name: 'PROTECTED', type: 'L', length: 1 }],
    TREES.map((t, i) => ({ TREE_ID: 2001 + i, SPECIES: t.species, HEIGHT_M: t.height, PLANTED: t.planted, PROTECTED: t.protected })),
  );
  return storedZip(files);
}

write('gis/park.geojson', geojson());
write('gis/meadows.topojson', topojson());
write('gis/lake-loop.gpx', gpx());
write('gis/park.kml', kml({ networkLink: true }));
write('gis/park.kmz', storedZip([['doc.kml', Buffer.from(kml({ networkLink: false }))], ['files/marker.png', markerPng()], ['files/plan.png', planPng()]]));
write('gis/park-shapefile.zip', shapefileZip());

for (const [rel, size] of written) console.log(`${String(size).padStart(8)}  samples/${rel}`);
