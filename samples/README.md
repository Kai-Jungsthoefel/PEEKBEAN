# Sample files

Test files for all viewers. Except for the exceptions below, all files are self-made and released under **CC0-1.0** (public domain).

- Most are written by `scripts/generate-samples.mjs` (`npm run samples`) without third-party libraries; only the SQLite file is created with sql.js. `scripts/generate-pptx-samples.mjs` writes the two PowerPoint test decks `office/shapes.pptx` and `office/text-tables-charts.pptx`, and `scripts/generate-docx-samples.mjs` the five Word test documents listed below (`text-layout.docx` to `vml-legacy.docx`). `scripts/generate-format-samples.mjs` writes the samples of the later formats (3D exchange formats, Rhino, textures, metafiles, CNC, notebook, comics, calendar, contacts, shortcuts); it uses three.js for the EXR and KTX2 files and rhino3dm for the Rhino file.
- `images/motif.jpg`, `motif.tif` and `motif.webp` were converted once from the generated `motif.bmp`/`motif.png` (JPEG and TIFF with Windows GDI+, WebP with the browser's canvas). `images/photo-exif.jpg` is `motif.jpg` with an EXIF block written by the generator. `media/clip.webm` is a self-drawn canvas animation, recorded with the browser's MediaRecorder.
- `cad/flange-*.dwg` were written by acadrust's DWG writer from `cad/flange.dxf` (`crates/dwg2dxf/examples/dxf_to_dwg.rs`); `cad/arch-walls-r2018.dwg` and `cad/flange-layout-r2018.dwg` by the examples `arch_sample.rs` and `layout_sample.rs`.
- `archives/example.tar.bz2` and `example.tar.xz` are written by `node scripts/test-libarchive-wasm.mjs --update-samples` (self-written texts).
- `scripts/generate-ifc-samples.mjs` writes `cad/small-building.ifc` from scratch (fixed time stamps, GlobalIds derived from names, author and organization "Example").
- `scripts/generate-cad3d-samples.mjs` writes `cad/bracket.FCStd` (its OpenCascade BREP shapes are written by the script and checked with occt-import-js) and the laser scan `3d/survey-scan.las` / `survey-scan.laz`. No npm package writes LAZ: with `LAZ_PYTHON` set to a Python that has laspy and lazrs (`pip install "laspy[lazrs]"`) the script compresses the .laz too, otherwise it leaves the file as it is.
- `scripts/generate-plot-samples.mjs` writes `cad/flange.plt` and `cad/flange-hpgl1.hpgl` (the flange plate of `cad/flange.dxf`, centered at 210/160 mm on an A3 sheet) and the 50 × 30 mm two-layer board in `pcb/`.
- `scripts/generate-gis-samples.mjs` writes the map samples in `gis/`: made-up features around the lake of the Englischer Garten in Munich (needs proj4).
- `scripts/generate-photo-samples.mjs` writes `images/camera.dng` (a Bayer mosaic of the motif with `motif.jpg` as full-size preview, camera "Example Sample Camera") and `images/motif.jxl` (lossless with transparency, encoded with libjxl from `@jsquash/jxl`).
- `scripts/generate-data-samples.mjs` writes `database/parts.parquet` (hyparquet-writer) and `database/parts.arrow` (apache-arrow), a fictional certificate chain in `certs/` (PKI.js; fresh random keys, so it differs on every run) and `database/parts.mdb`, which the Jet 4.0 engine writes through ADOX/ADO in the 32-bit Windows PowerShell (Windows only, skipped elsewhere). The only private key is the one inside `certs/identity.p12`, encrypted with the password `sample`.
- `scripts/generate-book-samples.mjs` writes `office/formatting.rtf`, `books/sample-book.epub` and `books/sample-book.fb2` from our own text and pictures.
- `scripts/generate-design-samples.mjs` writes `images/layers.ora` (OpenRaster with two layers), `images/layers.psd` (the same layers in Photoshop format, written with ag-psd), `images/layers.kra` (a minimal Krita document: flattened picture and preview, its one layer without pixel data) and `images/drawing.eps` (PostScript with a DOS binary header and a TIFF preview). Closed formats (SolidWorks, Inventor, NX, Creo, CATIA, Blender, Affinity, InDesign, Figma, Paint.NET) have no samples here: we cannot write them, and freely licensed files are rare.
- `scripts/generate-mindmap-samples.mjs` writes the mind maps in `mindmaps/` (a made-up product launch): XMind 2020+ and XMind 8, FreeMind and Freeplane, and a MindManager file written after the structure of MindManager's `Document.xml` but not checked in MindManager itself.
- **Exception:** `fonts/` contains IBM Plex Sans under the SIL Open Font License 1.1 (`fonts/OFL-IBM-Plex.txt`), copied from `@fontsource/ibm-plex-sans`.
- **Exception:** `archives/libarchive-test.7z` and `libarchive-test.rar` come from the test suite of libarchive v3.8.10 (commit `0c48412be2d94afe1859a807ea7896a18d8900bd`, files `test/test_read_format_7zip_lzma1_2.7z.uu` and `test/test_read_format_rar5_unicode.rar.uu`, uudecoded), BSD-2-Clause, copyright Tim Kientzle and the libarchive authors.

**Rule for this folder:** only files we made ourselves or that are provably freely licensed (then with source and license in this file). Real files from projects or customers belong in `private/`, which is never committed.

| File | Tests |
|---|---|
| `pdf/document.pdf` | 3 pages, accented letters, vector graphics, link, landscape page, search for "shipyard" (3 matches) |
| `pdf/layers.pdf` | layers (optional content): 5 layers, a group "Annotations", "Revision B" off by default |
| `office/document.docx` | headings, character formatting, table, picture, page break, document properties |
| `office/text-layout.docx` | line spacing modes, fonts, indents, alignment, tab stops with leaders, lists, borders and shading, footnotes, endnote, fields, table of contents, equations, two columns |
| `office/sections-tables.docx` | table styles, merged cells, cell borders and shading, vertical text, nested and floating tables, repeated header rows, sections with first/odd/even headers, landscape page with border, three columns |
| `office/floating-pictures.docx` | floating pictures with every wrap type and anchor, wrap distances, z-order, rotation, flips, cropping, pictures in header, footer and table cells |
| `office/forms-shapes-charts.docx` | legacy form fields and check boxes, check box content controls, symbol fonts, shapes, text boxes (also linked), group, drawing canvas, charts |
| `office/vml-legacy.docx` | VML pictures and shapes, VML text box, watermark, drop cap, text frame |
| `office/parts.xlsx` | two sheets, number and date formats, formulas, merged cells, wrapped text, document properties |
| `office/presentation.pptx` | three slides, background, shapes, picture, placeholders from layout and master, group |
| `office/shapes.pptx` | 40 preset shapes, lines, arrowheads, connectors, gradient/pattern/picture fills, rotation, flips, nested groups, custom geometry, a hidden slide |
| `office/text-tables-charts.pptx` | bullets and numbering, character formatting, link, tabs, anchors, vertical text, autofit, columns, tables with styles and merges, column/pie/line charts |
| `office/formatting.rtf` | RTF: headings, character formatting, colors and highlight, Windows-1252 and Shift-JIS bytes, Greek and CJK via `\u`, tab stops with leaders, bullet and numbered lists, table with shading and merged cells, web and bookmark links, footnote, PNG and WMF pictures, header and footer with page number, page break, document properties |
| `text/parts.csv` | CSV with a quoted field |
| `cad/flange.dxf` | DXF R12: layers, line type, lines, arcs, circles, text |
| `cad/flange-r12.dwg` … `flange-r2018.dwg` | the same drawing as DWG in the file formats R12, 2000, 2004, 2007 and 2018 |
| `cad/flange-layout-r2018.dwg` | layout with frame, title text and three viewports (1:1, 1:2, detail 2:1 twisted by 30°, one layer frozen in it) |
| `cad/arch-walls-r2018.dwg` | AutoCAD Architecture objects (walls, doors, windows, styles) that must appear as simple geometry |
| `cad/bracket.step` | STEP AP214: three solids with colors, unit mm |
| `cad/small-building.ifc` | IFC4 building, units mm/m²/m³/kg: site, building, two storeys, slabs and a roof, walls with layered materials, openings with windows (transparent glass) and a door, a round column, a steel beam, two rooms (hidden at first), surface-style colors, property sets (an enumerated value, text beyond ASCII) and quantity sets |
| `cad/bracket.FCStd` | FreeCAD document: primitives consumed by booleans (hidden), a plate with two holes in its own face colors, bolts in a group, a transparent cover in an App::Part turned by 180°, a PartDesign body (hidden sketch, pad), a visible sketch with lines and arcs |
| `cad/flange.plt` | HP-GL/2 in a PJL wrapper: encoded polylines (PE, 8- and 7-bit), arcs, circles, four pens with colors and widths, dash-dot line type, polygon mode with a hatched section, labels; bore Ø 60, holes Ø 13 on a 110 mm bolt circle |
| `cad/flange-hpgl1.hpgl` | the same plate in classic HP-GL: user units in mm via IP/SC, PA/PD coordinate lists, relative moves (PR), arcs, circles, labels |
| `pcb/board-*.gbr`, `board-PTH.drl`, `board-NPTH.drl` | two-layer board 50 × 30 mm: aperture macro, curved track, ground pour cut in clear polarity with thermal spokes, solder masks, silkscreen, outline with arcs, plated and non-plated drill files with a slot; X2 attributes in some files, KiCad file names for the others |
| `pcb/board-gerbers.zip` | the same eight files zipped: "Open as circuit board" in the archive view |
| `3d/gear.stl`, `gear.3mf` | binary STL and 3MF, gear with a bore, Z up, mm |
| `3d/pyramid-ascii.stl` | ASCII STL |
| `3d/torus.obj` | OBJ with normals and quads |
| `3d/sphere-points.ply` | binary PLY, point cloud with colors |
| `3d/colored-cube.glb`, `colored-cube.gltf` | glTF binary and with embedded data, vertex colors |
| `3d/bracket.fbx`, `.dae`, `.3ds`, `.amf`, `.usda`, `.usdz`, `.vtp` | the same angle bracket of three colored parts (base plate, upright, rib) in each exchange format: ASCII FBX, COLLADA (unit m, Z up), 3D Studio, AMF, USD as text and as package, VTK XML |
| `3d/bracket.wrl`, `bracket.wrz` | VRML97 with the bracket plus a cylinder primitive, plain and gzip-compressed |
| `3d/bracket-vrml1.wrl` | the same bracket in VRML 1.0 (Separators, Material, Coordinate3, IndexedFaceSet, a Cylinder), as SolidWorks exports it |
| `3d/bracket.3dm` | Rhino 7 file in mm: the bracket as meshes on three colored layers, four hole circles on a layer of their own |
| `3d/torus.vtk`, `torus.off` | legacy VTK polydata; OFF with vertex colors (COFF) |
| `3d/dome-scan.pcd`, `terrain.xyz` | point clouds: ASCII PCD without colors, XYZ with colors |
| `3d/pavilion.bim` | dotbim: slab, four columns sharing one mesh, roof, a transparent glass wall, element info |
| `3d/house.vox` | MagicaVoxel model with its own palette |
| `3d/survey-scan.las`, `survey-scan.laz` | aerial laser scan in ETRS89 / UTM 32N: terrain, road, pond, house, trees with multiple returns, power line, noise; ASPRS classes, RGB, intensity. LAS 1.2 point format 3 with GeoTIFF keys; LAZ 1.4 point format 7 with WKT |
| `cnc/flange-drilling.nc` | drilling cycle G81 on a bolt circle |
| `cnc/pocket-contour.nc` | three tools: helical ramp and full circles (I/J), contour with R arcs, peck drilling G83 with G99/G98 |
| `cnc/calibration-cube.gcode` | 3D printer program: layers, extrusion (E) and travel moves |
| `images/motif.png` | PNG with transparency |
| `images/motif.jpg`, `motif.webp`, `motif.bmp`, `icon.ico` | more raster formats |
| `images/motif.tif` | TIFF, decoded in the browser (UTIF2) |
| `images/photo-exif.jpg` | photo with EXIF for the info panel: camera, exposure, time taken with time zone, GPS position (Brandenburg Gate in Berlin, a public place) |
| `images/animation.gif` | animated GIF |
| `images/vector.svg` | SVG with gradient and text |
| `images/svg-with-script.svg` | the script inside the SVG must not run (the area stays green) |
| `images/motif.tga`, `motif.dds`, `motif.ktx2` | RLE TGA stored bottom row first, DXT1 DDS, raw RGBA KTX2; the dark square must be top left |
| `images/sky.hdr`, `sky.exr` | high dynamic range sky with a sun far brighter than white (Radiance RGBE, OpenEXR half float), tone mapped |
| `images/flange.wmf`, `flange.emf` | Windows metafiles: filled circles, lines and text |
| `images/camera.dng` | camera raw: the embedded JPEG preview is shown, sensor size in the toolbar, EXIF in the info panel (camera, lens, exposure, time with time zone) |
| `images/motif.jxl` | JPEG XL, lossless with transparency (decoded by jxl-oxide in browsers without native support) |
| `images/layers.ora` | OpenRaster: the flattened picture (`mergedimage.png`) in the image viewer |
| `images/layers.psd` | Photoshop with two layers: the composite image |
| `images/layers.kra` | Krita: the flattened picture in the image viewer |
| `images/drawing.eps` | EPS with a TIFF preview: preview picture, title, creator, size from the bounding box |
| `mindmaps/launch-plan.xmind` | XMind 2020+: two sheets (map and logic chart), markers, labels, notes, a link, a picture, a folded branch, a relationship, a floating topic, a summary |
| `mindmaps/launch-plan-xmind8.xmind` | XMind 8 (content.xml) with the same features |
| `mindmaps/launch-plan.mmap` | MindManager: icons, task progress and due date, notes, link, text labels, picture, collapsed topic, floating topic, relationship |
| `mindmaps/launch-plan.mm` | FreeMind 1.0.1: branch sides, folding, link, icons, a note, an arrow link |
| `mindmaps/launch-plan-freeplane.mm` | Freeplane: HTML node text, details, attributes |
| `media/tone.wav`, `media/clip.webm` | audio and video |
| `archives/example.zip`, `example.tar`, `example.tar.gz` | folder structure, non-ASCII file name, files open in a new tab |
| `archives/encrypted.zip` | encrypted ZIP, password `everything` |
| `archives/notes.md.gz` | single gzip file |
| `archives/example.tar.bz2`, `example.tar.xz` | tar with bzip2 and xz (libarchive) |
| `archives/libarchive-test.7z`, `libarchive-test.rar` | 7z (LZMA) and RAR5 with Unicode names (libarchive) |
| `mail/newsletter.eml` | HTML e-mail with an embedded picture, attachments (CSV, PDF), and a tracking pixel and script that must be blocked |
| `database/parts.sqlite` | two tables, a view, a BLOB |
| `database/parts.mdb` | Access 2000 database (Jet 4): three tables with AutoNumber, text, memo with line breaks and non-ASCII text, currency, decimal, single/double, byte/integer, Yes/No, date/time, GUID, NULLs, a PNG in an OLE field (opens in a new tab) |
| `database/parts.parquet` | Parquet, Snappy, 2,500 rows in 3 row groups (rows load as you scroll): int, string, nullable string, DECIMAL(10, 2), double, boolean, DATE, TIMESTAMP(MICROS, UTC), list of strings, struct, key/value metadata with JSON |
| `database/parts.arrow` | Arrow IPC file (Feather v2), 500 rows: dictionary-encoded strings, Int64, Decimal128, Date32, timestamp, list, struct, schema metadata |
| `fonts/ibm-plex-sans-latin-400-normal.woff`, `.woff2` | font view |
| `web/page.html` | HTML with a script, external image, stylesheet and form, all of which must be blocked |
| `text/*` | TypeScript, Python, JSON, XML, Markdown (formatted), log, file without extension |
| `text/flange-weights.ipynb` | Jupyter notebook: Markdown, code, a table and a chart as outputs, an error with terminal colors |
| `books/comic.cbz`, `comic.cbt` | comic of five pages (ZIP and TAR) |
| `books/sample-book.epub` | EPUB 3 with nav.xhtml and toc.ncx, SVG cover page, three chapters with headings, emphasis, a figure, a footnote with backlink, links between chapters, a table, a web link; style sheet; metadata |
| `books/sample-book.fb2` | the same story as FictionBook 2: cover, sections, epigraph, poem, a note, a picture, a table |
| `mail/workshop.ics` | calendar with time zone: an event with attendees, a weekly series, a multi-day all-day event, a task |
| `mail/contacts.vcf` | two contacts, vCard 3.0 with an embedded photo and vCard 4.0 |
| `shortcuts/viewer.lnk`, `website.url`, `viewer.desktop`, `page.webloc` | Windows shortcut to a program with arguments and start folder, Internet shortcut, Linux desktop entry, macOS web location |
| `gis/park.geojson` | points, MultiPoint, lines, MultiLineString, a polygon with a hole, simplestyle colors, attributes of several types incl. null, a feature without geometry |
| `gis/meadows.topojson` | TopoJSON with quantized, shared arcs: two meadows, a path along their border, a gate (three layers) |
| `gis/lake-loop.gpx` | track with elevation and time stamps (2.28 km, 32:30 min), a route, three waypoints |
| `gis/park.kml` | styles and a StyleMap, folders as layers (one nested and hidden), ExtendedData, CDATA description, polygon with hole, ground overlay and icons that are not inside the file, a network link that must not be followed |
| `gis/park.kmz` | the same as KMZ with an embedded, tinted marker icon and the ground overlay image |
| `gis/park-shapefile.zip` | three shapefile sets (polygons with a hole, multipart lines, points) in ETRS89 / UTM 32N (EPSG:25832) with .shx, .prj, .cpg (UTF-8 umlauts) and dBASE fields of types C, N, D and L; "Open as map" in the archive view |
| `certs/chain.pem`, `certs/chain.p7b` | PEM bundle and PKCS#7 bundle of a leaf, intermediate and root CA ("Example Root CA", "Example Org"), shown in chain order with signature checks |
| `certs/www.example.com.crt` | DER leaf certificate: alternative names, key usage, extended key usage, policy, CRL and OCSP addresses (shown as text, never fetched), an unknown extension |
| `certs/www.example.com.csr` | certificate request with requested alternative names |
| `certs/expired.cer` | PEM certificate in a `.cer` file, expired in 2021 |
| `certs/identity.p12` | PKCS#12 with the chain and an encrypted RSA key (AES-256), password `sample`; the key is described, never shown |
| `text/windows-1252.txt`, `text/utf-16le.txt` | character set detection |
| `binary/random.bin` | hex view, marker `EVERYTHING-VIEWER-SAMPLE` at offset 0x400 |
| `edge-cases/broken.pdf` | damaged file, expected: an error message with a way out |
| `edge-cases/truncated.png` | truncated PNG, the browser shows the readable part |
| `edge-cases/empty.txt` | empty file |
| `edge-cases/png-named-as.txt`, `pdf-without-extension` | detection by content instead of extension |
| `edge-cases/unknown-extension.qqq` | unknown extension with text content |
