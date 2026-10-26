; Beispiel-CNC-Programm: Flanschplatte, 6 Bohrungen auf Lochkreis 110
; erzeugt von scripts/generate-samples.mjs, nicht für echte Maschinen gedacht
G21 ; Millimeter
G90 ; absolut
G17 ; XY-Ebene
T1 M6 ; Bohrer 13 mm
S1200 M3
G0 Z5
G81 X55.000 Y0.000 Z-14 R2 F150
G81 X27.500 Y47.631 Z-14 R2 F150
G81 X-27.500 Y47.631 Z-14 R2 F150
G81 X-55.000 Y0.000 Z-14 R2 F150
G81 X-27.500 Y-47.631 Z-14 R2 F150
G81 X27.500 Y-47.631 Z-14 R2 F150
G80
G0 Z50
M5
M30
