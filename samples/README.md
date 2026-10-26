# Sample files

Test files for all viewers. Except for the exceptions below, all files are self-made and released under **CC0-1.0** (public domain).

- Most are written by `scripts/generate-samples.mjs` (`npm run samples`) without third-party libraries; only the SQLite file is created with sql.js. `scripts/generate-pptx-samples.mjs` writes the two PowerPoint test decks `office/shapes.pptx` and `office/text-tables-charts.pptx`.
- `images/motif.jpg`, `motif.tif` and `motif.webp` were converted once from the generated `motif.bmp`/`motif.png` (JPEG and TIFF with Windows GDI+, WebP with the browser's canvas). `images/photo-exif.jpg` is `motif.jpg` with an EXIF block written by the generator. `media/clip.webm` is a self-drawn canvas animation, recorded with the browser's MediaRecorder.
- `cad/flange-*.dwg` were written by acadrust's DWG writer from `cad/flange.dxf` (`crates/dwg2dxf/examples/dxf_to_dwg.rs`); `cad/arch-walls-r2018.dwg` and `cad/flange-layout-r2018.dwg` by the examples `arch_sample.rs` and `layout_sample.rs`.
- `archives/example.tar.bz2` and `example.tar.xz` are written by `node scripts/test-libarchive-wasm.mjs --update-samples` (self-written texts).
- **Exception:** `fonts/` contains IBM Plex Sans under the SIL Open Font License 1.1 (`fonts/OFL-IBM-Plex.txt`), copied from `@fontsource/ibm-plex-sans`.
- **Exception:** `archives/libarchive-test.7z` and `libarchive-test.rar` come from the test suite of libarchive v3.8.10 (commit `0c48412be2d94afe1859a807ea7896a18d8900bd`, files `test/test_read_format_7zip_lzma1_2.7z.uu` and `test/test_read_format_rar5_unicode.rar.uu`, uudecoded), BSD-2-Clause, copyright Tim Kientzle and the libarchive authors.

**Rule for this folder:** only files we made ourselves or that are provably freely licensed (then with source and license in this file). Real files from projects or customers belong in `private/`, which is never committed.

| File | Tests |
|---|---|
| `pdf/document.pdf` | 3 pages, accented letters, vector graphics, link, landscape page, search for "shipyard" (3 matches) |
| `pdf/layers.pdf` | layers (optional content): 5 layers, a group "Annotations", "Revision B" off by default |
| `office/document.docx` | headings, character formatting, table, picture, page break, document properties |
| `office/parts.xlsx` | two sheets, number and date formats, formulas, merged cells, wrapped text, document properties |
| `office/presentation.pptx` | three slides, background, shapes, picture, placeholders from layout and master, group |
| `office/shapes.pptx` | 40 preset shapes, lines, arrowheads, connectors, gradient/pattern/picture fills, rotation, flips, nested groups, custom geometry, a hidden slide |
| `office/text-tables-charts.pptx` | bullets and numbering, character formatting, link, tabs, anchors, vertical text, autofit, columns, tables with styles and merges, column/pie/line charts |
| `text/parts.csv` | CSV with a quoted field |
| `cad/flange.dxf` | DXF R12: layers, line type, lines, arcs, circles, text |
| `cad/flange-r12.dwg` … `flange-r2018.dwg` | the same drawing as DWG in the file formats R12, 2000, 2004, 2007 and 2018 |
| `cad/flange-layout-r2018.dwg` | layout with frame, title text and three viewports (1:1, 1:2, detail 2:1 twisted by 30°, one layer frozen in it) |
| `cad/arch-walls-r2018.dwg` | AutoCAD Architecture objects (walls, doors, windows, styles) that must appear as simple geometry |
| `cad/bracket.step` | STEP AP214: three solids with colors, unit mm |
| `3d/gear.stl`, `gear.3mf` | binary STL and 3MF, gear with a bore, Z up, mm |
| `3d/pyramid-ascii.stl` | ASCII STL |
| `3d/torus.obj` | OBJ with normals and quads |
| `3d/sphere-points.ply` | binary PLY, point cloud with colors |
| `3d/colored-cube.glb`, `colored-cube.gltf` | glTF binary and with embedded data, vertex colors |
| `images/motif.png` | PNG with transparency |
| `images/motif.jpg`, `motif.webp`, `motif.bmp`, `icon.ico` | more raster formats |
| `images/motif.tif` | TIFF, decoded in the browser (UTIF2) |
| `images/photo-exif.jpg` | photo with EXIF for the info panel: camera, exposure, time taken with time zone, GPS position (Brandenburg Gate in Berlin, a public place) |
| `images/animation.gif` | animated GIF |
| `images/vector.svg` | SVG with gradient and text |
| `images/svg-with-script.svg` | the script inside the SVG must not run (the area stays green) |
| `media/tone.wav`, `media/clip.webm` | audio and video |
| `archives/example.zip`, `example.tar`, `example.tar.gz` | folder structure, non-ASCII file name, files open in a new tab |
| `archives/encrypted.zip` | encrypted ZIP, password `everything` |
| `archives/notes.md.gz` | single gzip file |
| `archives/example.tar.bz2`, `example.tar.xz` | tar with bzip2 and xz (libarchive) |
| `archives/libarchive-test.7z`, `libarchive-test.rar` | 7z (LZMA) and RAR5 with Unicode names (libarchive) |
| `mail/newsletter.eml` | HTML e-mail with an embedded picture, attachments (CSV, PDF), and a tracking pixel and script that must be blocked |
| `database/parts.sqlite` | two tables, a view, a BLOB |
| `fonts/ibm-plex-sans-latin-400-normal.woff`, `.woff2` | font view |
| `web/page.html` | HTML with a script, external image, stylesheet and form, all of which must be blocked |
| `text/*` | TypeScript, Python, JSON, XML, Markdown (formatted), G-code, log, file without extension |
| `text/windows-1252.txt`, `text/utf-16le.txt` | character set detection |
| `binary/random.bin` | hex view, marker `EVERYTHING-VIEWER-SAMPLE` at offset 0x400 |
| `edge-cases/broken.pdf` | damaged file, expected: an error message with a way out |
| `edge-cases/truncated.png` | truncated PNG, the browser shows the readable part |
| `edge-cases/empty.txt` | empty file |
| `edge-cases/png-named-as.txt`, `pdf-without-extension` | detection by content instead of extension |
| `edge-cases/unknown-extension.xyz` | unknown extension with text content |
