# Beispieldaten

Testdateien für alle Viewer. Alle Dateien sind selbst erzeugt und stehen unter **CC0-1.0** (gemeinfrei). Sie dürfen ohne Einschränkung weitergegeben werden.

Die meisten erzeugt `scripts/generate-samples.mjs` (`npm run samples`) ohne fremde Bibliotheken. `images/motif.jpg`, `motif.tif` und `motif.webp` sind einmalig aus dem ebenfalls generierten `motif.bmp`/`motif.png` konvertiert worden (JPEG und TIFF mit Windows GDI+, WebP mit dem Canvas des Browsers), weil das Skript dafür keinen eigenen Encoder mitbringt.

**Regel für dieses Verzeichnis:** Hier landen nur Dateien, die wir selbst erzeugt haben oder die nachweislich frei lizenziert sind (dann mit Quelle und Lizenz in dieser Tabelle). Echte Dateien aus Projekten oder von Kunden gehören nach `private/`. Dieser Ordner wird nie committet.

| Datei | Prüft |
|---|---|
| `pdf/document.pdf` | 3 Seiten, Umlaute, Vektorgrafik, Link, Querformat, Suche nach „Werft“ (3 Treffer) |
| `images/motif.png` | PNG mit Transparenz |
| `images/motif.jpg`, `motif.webp`, `motif.bmp`, `icon.ico` | weitere Rasterformate |
| `images/motif.tif` | TIFF, noch nicht unterstützt (erwartet: Hex-Ansicht) |
| `images/animation.gif` | animiertes GIF |
| `images/vector.svg` | SVG mit Verlauf und Text |
| `images/svg-with-script.svg` | Skript im SVG darf nicht ausgeführt werden (Fläche bleibt grün) |
| `3d/gear.stl` | binäres STL, Zahnrad mit Bohrung, Z-oben, mm |
| `3d/gear.3mf` | dasselbe Zahnrad als 3MF |
| `3d/pyramid-ascii.stl` | ASCII-STL |
| `3d/torus.obj` | OBJ mit Normalen und Vierecken |
| `3d/sphere-points.ply` | binäres PLY, Punktwolke mit Farben |
| `3d/colored-cube.glb`, `colored-cube.gltf` | glTF binär und mit eingebetteten Daten, Vertex-Farben |
| `cad/flange.dxf` | DXF R12: Layer, Linientyp, Linien, Bögen, Kreise, Text (Viewer noch geplant) |
| `text/*` | TypeScript, Python, CSV, JSON, XML, Markdown, G-Code, Log, Datei ohne Endung |
| `text/windows-1252.txt`, `text/utf-16le.txt` | Zeichensatzerkennung |
| `binary/random.bin` | Hex-Ansicht, Markierung `EVERYTHING-VIEWER-SAMPLE` bei Offset 0x400 |
| `edge-cases/broken.pdf` | beschädigte Datei, erwartet: Fehlermeldung mit Ausweg |
| `edge-cases/truncated.png` | abgeschnittenes PNG, der Browser zeigt den lesbaren Teil |
| `edge-cases/empty.txt` | leere Datei |
| `edge-cases/png-named-as.txt`, `pdf-without-extension` | Erkennung am Inhalt statt an der Endung |
| `edge-cases/unknown-extension.xyz` | unbekannte Endung mit Textinhalt |
