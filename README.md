# Everything Viewer

View files of all kinds in the browser without uploading them. The site is purely static: files are read and processed only in the browser, and there is no server that could receive them.

## Supported formats

| Viewer | Formats | Library |
|---|---|---|
| PDF | `.pdf` (search, show and hide layers, password-protected PDFs) | pdf.js |
| Word | `.docx .docm .dotx` (pages laid out like Word: floating pictures, shapes, text boxes, form fields and check boxes, tables, headers and footers, footnotes, charts) | [ooxml-pages](https://github.com/Kai-Jungsthoefel/ooxml-pages) |
| Spreadsheet | `.xlsx .xlsm .xlsb .xls .ods .numbers .csv .tsv`, xlsx with formatting | SheetJS, own style reader |
| Presentation | `.pptx .pptm .ppsx .potx` (shapes, text, pictures, tables, charts, layouts and masters) | [ooxml-pages](https://github.com/Kai-Jungsthoefel/ooxml-pages) |
| DXF / DWG | `.dxf` (text DXF), `.dwg` R12 to 2018+, model space and layouts, AutoCAD Architecture objects as geometry | dxf-viewer, acadrust (Rust → WebAssembly) |
| CAD model | `.step .stp .iges .igs .brep` | OpenCascade (occt-import-js) |
| 3D model | `.stl .obj .ply .glb .gltf .3mf` | three.js |
| Image | `.png .jpg .gif .webp .avif .bmp .ico .svg .tif .psd .heic` | browser, UTIF2, ag-psd, libheif |
| Audio / video | `.mp4 .webm .mov .mkv .mp3 .wav .ogg .flac .m4a` (whatever the browser can play) | browser |
| Archive | `.zip` (including AES), `.7z .rar .tar .gz .bz2 .xz .zst .cab .iso .lha .cpio .rpm .deb` | zip.js, own TAR reader, libarchive (WebAssembly, without OpenSSL) |
| E-mail | `.eml .msg` (with attachments) | postal-mime, msgreader |
| Font | `.ttf .otf .woff .woff2` | browser, opentype.js |
| SQLite | `.sqlite .db .gpkg` (tables, SQL queries) | sql.js |
| Markdown | `.md` (formatted) | marked, DOMPurify |
| Web page | `.html .htm` (without scripts, without network access) | browser (sandboxed iframe) |
| Text / source code | all text files, with syntax highlighting | CodeMirror 6 |
| Hex | everything else | own viewer |

Format detection checks the file signature first, then the extension, and finally whether the content looks like text. Container signatures (ZIP, e-mail headers) give way to a matching extension, so that a DOCX does not open as a ZIP, for example. **View as** picks any viewer by hand. Files inside archives and e-mail attachments open in a new tab.

**Info** in the file bar shows the metadata: for photos the camera, exposure, time taken and GPS location (EXIF, XMP, IPTC via exifr); for MP4/MOV videos the recording time, device and location; MP3/FLAC tags; document properties of PDF, Word, Excel, PowerPoint and OpenDocument files; author, organization and CAD system from the header of STEP files; version and dates of DXF/DWG drawings; plus font names, SQLite header data and the head of HTML pages.

**Measure** works in 3D, DXF/DWG, PDF and images. In 3D and DXF/DWG it snaps to corners, end points and midpoints, edges or lines, and circles: two edges show their angle, parallel ones their distance, a single circle its diameter.

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
- `src/viewers/*.ts`: one module per viewer, loaded only when a matching file is opened
- `src/viewers/pptx/`: the PowerPoint renderer (package, inheritance from layout and master, colors, text, geometry, tables, charts)
- `src/viewers/docx/`: the Word renderer (styles, numbering, line breaking, pagination, tables, floating objects, VML, equations); DrawingML shapes and charts go through the PowerPoint renderer
- `src/workers/*.ts`: heavy work (CAD kernel, spreadsheets, DXF, image decoders) runs in web workers
- `src/app.ts`: user interface (tabs, drag and drop, start page, loading screen)
- `src/metadata/`, `src/info-panel.ts`: metadata for the info panel, one reader per format family, loaded only when the panel opens
- `src/wasm/`: our own WebAssembly builds: the DWG converter from `crates/dwg2dxf` (`npm run build:dwg-wasm`, Rust) and libarchive from `wasm/libarchive` (`npm run build:libarchive-wasm`, Emscripten)
- `src/viewers/three/`: 3D view with view cube, parts tree, section view and measuring (after SOMA)

A new viewer is a module with `mount({ file, container, toolbar, openFile, progress })` that returns `{ destroy() }`, plus an entry in `registry.ts`. With `progress(text, fraction?)` it reports what is happening while it loads.

## Privacy

- The production build sets a Content Security Policy that only allows connections to the site's own origin. It is in the page as a meta tag and in `dist/_headers` as an HTTP header (Netlify, Cloudflare Pages). **Only the HTTP header also applies to the web workers**, so make sure to send it when hosting.
- `unsafe-eval` is not allowed. The CAD kernel (OpenCascade) normally creates its JS bindings with `new Function`; `vite.config.ts` replaces that at build time with Emscripten's eval-free variant.
- HTML files and HTML e-mails run in a sandboxed iframe without scripts, with their own CSP and no network access. External images (such as tracking pixels in newsletters) are blocked.
- Everything pdf.js loads on demand (CMaps, standard fonts, WASM decoders) ships with the site, so no CDN is contacted.
- The one exception to "nothing leaves your computer": for photos and videos with GPS data, the info panel ("Properties") has a link to OpenStreetMap. It opens only when clicked, in a new tab, and then sends the coordinates to openstreetmap.org; the site itself loads no map tiles.

## License

GPL-3.0-or-later, see [LICENSE](LICENSE).

During the build, `rollup-plugin-license` checks every shipped dependency, including those in web workers, against an allowlist of GPL-compatible licenses (`vite.config.ts`) and writes all license texts to `dist/third-party-licenses.txt`, together with the licenses of the native code inside the WebAssembly modules. Before publishing, set `repository` in `package.json`, so that the site links to the source code of the deployed version (GPL).

Deliberately not used: the prebuilt `libarchive.js`, because its WebAssembly contains OpenSSL 1.0.2 (license not GPL-compatible), and `pptx-preview`, which is only distributed minified without source code.

The design follows [SOMA](https://github.com/Kai-Jungsthoefel/SOMA), in a light color scheme. Typeface: IBM Plex (OFL-1.1).

## Planned

- Older Office formats (DOC, PPT), IFC (BIM), EPUB, camera raw files
- Offline use as a PWA
