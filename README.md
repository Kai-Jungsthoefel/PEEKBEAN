# Everything Viewer

Dateien aller Art im Browser ansehen, ohne sie hochzuladen. Die Seite ist rein statisch: Dateien werden ausschließlich im Browser gelesen und verarbeitet, es gibt keinen Server, der sie empfangen könnte.

## Unterstützte Formate

| Viewer | Formate | Bibliothek |
|---|---|---|
| PDF | `.pdf` (inkl. Suche, passwortgeschützte PDFs) | pdf.js |
| Bild | `.png .jpg .gif .webp .avif .bmp .ico .svg` | Browser |
| 3D-Modell | `.stl .obj .ply .glb .gltf .3mf` | three.js |
| Text / Quellcode | alle Textdateien, Syntaxhervorhebung für gängige Sprachen | CodeMirror 6 |
| Hex | alles andere | eigener Viewer |

Die Formaterkennung prüft zuerst die Signatur der Datei, dann die Endung und zuletzt, ob der Inhalt nach Text aussieht. Über „Anzeigen als“ lässt sich jeder Viewer auch von Hand wählen.

## Entwicklung

```sh
npm install
npm run dev       # Entwicklungsserver
npm run build     # Typprüfung, Produktions-Build nach dist/, Lizenzprüfung
npm run preview   # dist/ lokal ausliefern (mit Content Security Policy)
```

## Aufbau

- `src/core/registry.ts`: Liste aller Viewer und Formaterkennung
- `src/viewers/*.ts`: ein Modul pro Viewer, wird erst beim Öffnen einer passenden Datei geladen
- `src/app.ts`: Oberfläche (Reiter, Drag & Drop, Startseite)

Ein neuer Viewer ist ein Modul mit `mount({ file, container, toolbar })`, das `{ destroy() }` zurückgibt, plus ein Eintrag in `registry.ts`. Rechenintensive Formate (STEP, DWG) sollen später in einem Web Worker laufen.

## Datenschutz

Der Produktions-Build setzt eine Content Security Policy, die Verbindungen nur zum eigenen Ursprung erlaubt. Alle Daten, die pdf.js nachlädt (CMaps, Standardschriften, WASM-Decoder), werden mit ausgeliefert, damit kein CDN angefragt wird.

## Lizenz

GPL-3.0-or-later, siehe [LICENSE](LICENSE).

Beim Build prüft `rollup-plugin-license` jede ausgelieferte Abhängigkeit gegen eine Allowlist GPL-kompatibler Lizenzen (`vite.config.ts`) und schreibt alle Lizenztexte nach `dist/third-party-licenses.txt`. Vor der Veröffentlichung muss `repository` in `package.json` gesetzt sein, damit die Seite auf den Quellcode des ausgelieferten Stands verlinkt (GPL).

Die Gestaltung lehnt sich an [SOMA](https://github.com/Kai-Jungsthoefel/SOMA) an, in hellem Farbschema. Schrift: IBM Plex (OFL-1.1).

## Geplant

- Office: DOCX, XLSX, PPTX
- CAD: STEP/IGES (OpenCascade als WASM), DXF (dxf-viewer), DWG (acadrust als WASM, nach DXF)
- Archive (ZIP, 7z), E-Mails (EML, MSG), weitere Bildformate (HEIC, TIFF, PSD)
- Offline-Nutzung als PWA
