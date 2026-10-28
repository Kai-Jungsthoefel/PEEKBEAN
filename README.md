# OPSIS

View files of all kinds in the browser without uploading them. The site is purely static: files are read and processed only in the browser, and there is no server that could receive them.

## Supported formats

| Viewer | Formats | Library |
|---|---|---|
| PDF | `.pdf` (search, show and hide layers, password-protected PDFs) | pdf.js |
| Word | `.docx .docm .dotx` (pages laid out like Word: floating pictures, shapes, text boxes, form fields and check boxes, tables, headers and footers, footnotes, charts) | [ooxml-pages](https://github.com/Kai-Jungsthoefel/ooxml-pages) |
| Spreadsheet | `.xlsx .xlsm .xlsb .xls .ods .numbers .csv .tsv`, xlsx with formatting | SheetJS, own style reader |
| Presentation | `.pptx .pptm .ppsx .potx` (shapes, text, pictures, tables, charts, layouts and masters) | [ooxml-pages](https://github.com/Kai-Jungsthoefel/ooxml-pages) |
| Rich Text | `.rtf` (also `.doc` files that are really RTF): formatting, lists, tables, pictures including EMF/WMF, headers and footers | own reader, ooxml-pages |
| DXF / DWG | `.dxf` (text DXF), `.dwg` R12 to 2018+, model space and layouts, AutoCAD Architecture objects as geometry | dxf-viewer, acadrust (Rust → WebAssembly) |
| HPGL plot | `.plt .hpgl .hpg .hgl` (HP-GL and HP-GL/2, also in PCL/PJL wrappers): one layer per pen, measuring in mm; gnuplot `.plt` scripts open as text | own converter to DXF, dxf-viewer |
| Circuit board | Gerber RS-274X/X2 and Excellon drill files (`.gbr .ger .gtl .gbl .gts .gbs .gto .gbo .gtp .gbp .gko .gm1 .drl .xln` …), single layers or a ZIP of a board: finished board from top and bottom, layer view, measuring in mm | tracespace (parser, plotter, identify-layers) |
| CAD model | `.step .stp .iges .igs .brep` | OpenCascade (occt-import-js) |
| BIM model | `.ifc` (IFC2X3, IFC4, IFC4X3): spatial structure with visibility per storey, IFC class and element; attributes, property sets, quantities and materials of the clicked element; rooms and openings hidden at first | web-ifc (WebAssembly) |
| FreeCAD | `.FCStd` (the objects FreeCAD shows, in their colors and transparency, also per face; parts, bodies, groups and links as a tree; sketches and wires as lines) | OpenCascade (occt-import-js), own BREP edge reader |
| 3D model | `.stl .obj .ply .glb .gltf .3mf .fbx .dae .3ds .amf .wrl .wrz .vtk .vtp .usd .usda .usdc .usdz .off .vox`, dotbim `.bim`, point clouds `.pcd .xyz`, VRML 1.0 and 97 in `.wrl .wrz`, Rhino `.3dm` (meshes and curves in their layer colors) | three.js loaders, rhino3dm (WebAssembly), own VRML 1.0 reader |
| Point cloud | `.las .laz` (LAS 1.0–1.4): colored by RGB, elevation, intensity, classification or return; classes can be hidden; clouds above about 12 million points are thinned evenly | laz-perf (WebAssembly) |
| CAD preview | closed CAD formats: SolidWorks `.sldprt .sldasm .slddrw` (OLE up to 2014 and the container since 2015), Inventor `.ipt .iam .idw .ipn`, Solid Edge `.par .psm .asm .dft`, NX `.prt`, Creo `.prt .asm .frm` (also `part.prt.3`), CATIA V5 `.CATPart .CATProduct`; Blender `.blend` (2.x to 5.x): the preview picture the application saved, document properties (part number, material, configurations, cut lists, versions), the component tree and referenced files; for Blender the scenes, objects, materials and the images packed into the file. The 3D model itself is not shown | own readers (OLE, SolidWorks container, SPLMSSTR, V5_CFV2, Creo LZW), fzstd |
| CNC program | `.nc .gcode .gco .ngc .tap .cnc .mpf .eia`: G-code next to its tool paths in 3D, with playback; arcs, drilling cycles, several tools, 3D printer files | own interpreter, CodeMirror 6 |
| Image | `.png .jpg .gif .webp .avif .bmp .ico .svg .tif .psd .heic .tga .dds .exr .hdr .ktx2 .emf .wmf .jxl` (high dynamic range images tone mapped); Krita `.kra` and OpenRaster `.ora` (the flattened picture); camera raw `.dng .cr2 .cr3 .crw .nef .nrw .arw .srf .sr2 .orf .rw2 .rwl .raf .pef .srw .3fr .iiq .erf .kdc .dcr .mos .mrw .x3f` (the preview the camera embedded; DNGs without one are developed) | browser, UTIF2, ag-psd, libheif, three.js loaders, decode-dxt, Basis Universal, ooxml-pages, jxl-oxide (WebAssembly), own raw reader |
| Design preview | Paint.NET `.pdn`, Affinity `.afphoto .afdesign .afpub .af`, InDesign `.indd .indt`, Figma `.fig`, EPS `.eps` (TIFF or WMF preview), Illustrator `.ai` without a PDF part (PDF-compatible `.ai` files open in the PDF viewer): the embedded preview, for InDesign also page previews, fonts and linked files | own readers, UTIF2, zip.js |
| Audio / video | `.mp4 .webm .mov .mkv .mp3 .wav .ogg .flac .m4a` (whatever the browser can play) | browser |
| Archive | `.zip` (including AES), `.7z .rar .tar .gz .bz2 .xz .zst .cab .iso .lha .cpio .rpm .deb` | zip.js, own TAR reader, libarchive (WebAssembly, without OpenSSL) |
| E-mail | `.eml .msg` (with attachments) | postal-mime, msgreader |
| Font | `.ttf .otf .woff .woff2` | browser, opentype.js |
| SQLite | `.sqlite .db .gpkg` (tables, SQL queries) | sql.js |
| Access database | `.mdb .accdb .mde .accde` (Access 97 to 365, password-protected `.accdb`) | mdb-reader, @noble/hashes, @noble/ciphers |
| Parquet / Arrow | `.parquet .pq`, Arrow IPC and Feather v2 `.arrow .feather .ipc .arrows`: schema, metadata, rows loaded as you scroll | hyparquet, hyparquet-compressors, Apache Arrow JS |
| Map data (GIS) | Shapefile `.shp` (alone, or a `.zip` with `.dbf .prj .cpg`), `.kml .kmz .gpx .tcx .geojson .topojson`: own map without a basemap, layers, attribute table, measuring on the ellipsoid, GPS track statistics, reprojection from the `.prj` (UTM, Gauss-Krüger …); nothing a file links to is loaded | shpjs, togeojson, topojson-client, proj4, own dBASE reader |
| Markdown | `.md` (formatted) | marked, DOMPurify |
| Jupyter notebook | `.ipynb` (cells with their saved outputs, nothing is run) | marked, DOMPurify, Lezer |
| Mind map | XMind `.xmind` (XMind 8 and 2020+), MindManager `.mmap .mmat .xmmap`, FreeMind and Freeplane `.mm`: the map with its branches in color, folding, notes, links, labels, markers, pictures, relationships and floating topics; several sheets; an outline view | own readers and renderer, zip.js |
| Comic | `.cbz .cbr .cb7 .cbt` (pages in name order, unpacked as they come into view) | archive readers above |
| E-book | `.epub` (EPUB 2 and 3, also fixed layout), `.fb2`: table of contents, links and footnotes, text size | own reader, DOMPurify, zip.js |
| Calendar / contacts | `.ics .vcf` (events, tasks, contacts with photos) | ical.js |
| Shortcut | `.lnk .url .desktop .webloc` (target, arguments, start folder; nothing is run) | own readers |
| Certificate | `.pem .crt .cer .der .p7b .p7c .csr .p12 .pfx .key`: certificates, chains, requests, PKCS#7, PKCS#12, CRLs; keys only by their type, never their content | PKI.js, asn1js, WebCrypto |
| Web page | `.html .htm` (without scripts, without network access) | browser (sandboxed iframe) |
| Text / source code | all text files, with syntax highlighting | CodeMirror 6 |
| Hex | everything else | own viewer |

Format detection checks the file signature first, then the extension, and finally whether the content looks like text. Container signatures (ZIP, e-mail headers) give way to a matching extension, so that a DOCX does not open as a ZIP, for example. **View as** picks any viewer by hand. Files inside archives and e-mail attachments open in a new tab.

**Info** in the file bar shows the metadata: for photos the camera, exposure, time taken and GPS location (EXIF, XMP, IPTC via exifr); for MP4/MOV videos the recording time, device and location; MP3/FLAC tags; document properties of PDF, Word, Excel, PowerPoint and OpenDocument files; author, organization and CAD system from the header of STEP files; version and dates of DXF/DWG drawings; part numbers, materials, configurations and versions of SolidWorks, Inventor, Solid Edge, NX, Creo and CATIA files and the summary properties of other OLE documents; plus font names, SQLite header data and the head of HTML pages.

**Measure** works in 3D (also IFC, FreeCAD and point clouds), DXF/DWG, HPGL plots, circuit boards, maps, PDF and images. On maps it measures on the ellipsoid in meters. In 3D, DXF/DWG and HPGL it snaps to corners, end points and midpoints, edges or lines, and circles: two edges show their angle, parallel ones their distance, a single circle its diameter. In PDFs and images the scale is set by hand (1:N, length per pixel) or calibrated: measure a distance of known length, enter its real length, and every further measurement uses that scale.

## Development

```sh
npm install
npm run dev       # development server
npm run build     # type check, production build into dist/, license check
npm run preview   # serve dist/ locally, with the Content Security Policy as an HTTP header
npm run samples   # regenerate the sample files in samples/
```

The WebAssembly modules in `src/wasm/` are checked in prebuilt, so `npm run build` needs neither Rust nor Emscripten. Rebuild them only when changing them (see the scripts `scripts/build-*-wasm.mjs`).

## Structure

- `src/core/registry.ts`: list of all viewers and the format detection
- `src/viewers/*.ts`: one module per viewer, loaded only when a matching file is opened; larger viewers keep their parts in a folder of the same name (`ifc/`, `map/`, `rtf/` …)
- Word and PowerPoint (`docx.ts`, `pptx.ts`) render through [ooxml-pages](https://github.com/Kai-Jungsthoefel/ooxml-pages), a separate MIT library from npm that lays out pages like Word and PowerPoint do
- `src/workers/*.ts`: heavy work (CAD kernel, spreadsheets, DXF, image decoders) runs in web workers
- `src/app.ts`: user interface (tabs, drag and drop, start page, loading screen)
- `src/metadata/`, `src/info-panel.ts`: metadata for the info panel, one reader per format family, loaded only when the panel opens
- `src/wasm/`: our own WebAssembly builds: the DWG converter from `crates/dwg2dxf` (`npm run build:dwg-wasm`, Rust) and libarchive from `wasm/libarchive` (`npm run build:libarchive-wasm`, Emscripten)
- `src/viewers/three/`: 3D view with view cube, parts tree, section view and measuring (after SOMA)

A new viewer is a module with `mount({ file, container, toolbar, openFile, progress })` that returns `{ destroy() }`, plus an entry in `registry.ts`. With `progress(text, fraction?)` it reports what is happening while it loads.

## Privacy

- What the host can see: viewers, web workers, WebAssembly modules and helper files (pdf.js CMaps and fonts, syntax modes for source code) are downloaded only when a file needs them. The server's access log therefore shows which of them a browser loads, and with that the kind of file ("a DWG was opened", "a PDF with Japanese text"), but never the file, its name or its content. Browsers cache these files, so a format shows up about once per browser and release. The "How your files stay local" dialog says this in short.
- The production build sets a Content Security Policy that only allows connections to the site's own origin. It is in the page as a meta tag and in `dist/_headers` as an HTTP header (Netlify, Cloudflare Pages). **Only the HTTP header also applies to the web workers**, so make sure to send it when hosting.
- `unsafe-eval` is not allowed. The CAD kernel (OpenCascade) normally creates its JS bindings with `new Function`; `vite.config.ts` replaces that at build time with Emscripten's eval-free variant.
- HTML files and HTML e-mails run in a sandboxed iframe without scripts, with their own CSP and no network access. External images (such as tracking pixels in newsletters) are blocked.
- Everything pdf.js loads on demand (CMaps, standard fonts, WASM decoders) ships with the site, so no CDN is contacted.
- The one exception to "nothing leaves your computer": for photos and videos with GPS data, the info panel ("Properties") has a link to OpenStreetMap. It opens only when clicked, in a new tab, and then sends the coordinates to openstreetmap.org; the site itself loads no map tiles.
- The GitHub links (header, "Feedback" in the file bar, "Report this problem" on errors, "Suggest a format" on the start page) also open only when clicked. Issue links are filled in with the file's extension, the detected format, the viewer and the app version, never the file name or content. The star count in the header is read from the GitHub API while building (`vite.config.ts`, optionally with `GITHUB_TOKEN`), not by the page; without network access the header shows the link without a count. Behind a proxy, set `NODE_USE_ENV_PROXY=1` for the build.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).

During the build, `rollup-plugin-license` checks every shipped dependency, including those in web workers, against an allowlist of GPL-compatible licenses (`vite.config.ts`) and writes all license texts to `dist/third-party-licenses.txt`, together with the licenses of the native code inside the WebAssembly modules. The site links to the source code of the deployed version (GPL) in the repository named by `repository` in `package.json`; keep it pointing at the public repository.

Deliberately not used: the prebuilt `libarchive.js`, because its WebAssembly contains OpenSSL 1.0.2 (license not GPL-compatible), and `pptx-preview`, which is only distributed minified without source code.

The design follows [SOMA](https://github.com/Kai-Jungsthoefel/SOMA), with a light and a dark theme. Typeface: IBM Plex (OFL-1.1).

## Planned

- Older Office formats (DOC, PPT)
- Offline use as a PWA
