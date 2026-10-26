// SPDX-License-Identifier: GPL-3.0-or-later
// CAD file headers: STEP (ISO 10303-21 HEADER section), DXF header variables, DWG version.
import { formatDate, row, section, xmlDate, type MetaSection } from './model';

const DWG_VERSIONS: Record<string, string> = {
  AC1009: 'AutoCAD R11/R12',
  AC1012: 'AutoCAD R13',
  AC1014: 'AutoCAD R14',
  AC1015: 'AutoCAD 2000–2002',
  AC1018: 'AutoCAD 2004–2006',
  AC1021: 'AutoCAD 2007–2009',
  AC1024: 'AutoCAD 2010–2012',
  AC1027: 'AutoCAD 2013–2017',
  AC1032: 'AutoCAD 2018 and later',
};

const INSUNITS: Record<number, string> = { 1: 'Inches', 2: 'Feet', 4: 'Millimeters', 5: 'Centimeters', 6: 'Meters', 7: 'Kilometers', 14: 'Decimeters' };

const STEP_SCHEMAS: [RegExp, string][] = [
  [/^AP242/i, 'AP242 (managed model-based 3D engineering)'],
  [/^AP203/i, 'AP203 Edition 2'],
  [/^AUTOMOTIVE_DESIGN/i, 'AP214 (automotive design)'],
  [/^CONFIG_CONTROL_DESIGN/i, 'AP203 (configuration-controlled design)'],
  [/^STRUCTURAL_FRAME_SCHEMA/i, 'CIS/2 (structural steel)'],
  [/^IFC/i, 'IFC (BIM)'],
];

export function dwgMetadata(head: Uint8Array): MetaSection[] {
  const code = String.fromCharCode(...head.subarray(0, 6));
  const version = DWG_VERSIONS[code];
  return version ? [{ title: 'Drawing', rows: [{ label: 'DWG version', value: `${version} (${code})` }] }] : [];
}

/** Julian day number as stored in $TDCREATE/$TDUPDATE: the author's local time. */
function julian(value: string): Date | null {
  const days = Number(value);
  return days > 2_000_000 ? new Date((days - 2440587.5) * 86_400_000) : null;
}

export async function dxfMetadata(file: File): Promise<MetaSection[]> {
  // The header section comes first and is small.
  const text = new TextDecoder('latin1').decode(await file.slice(0, 512 * 1024).arrayBuffer());
  const lines = text.split(/\r?\n/);
  const vars = new Map<string, string>();
  let name = '';
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const code = lines[i].trim();
    const value = lines[i + 1].trim();
    if (code === '0' && value === 'ENDSEC') break;
    if (code === '9') name = value;
    else if (name && !vars.has(name)) vars.set(name, value);
  }
  const v = (key: string) => vars.get(key) ?? '';
  const created = julian(v('$TDCREATE'));
  const updated = julian(v('$TDUPDATE'));
  const editing = Number(v('$TDINDWG'));
  return [
    section('Drawing', [
      row('DXF version', DWG_VERSIONS[v('$ACADVER')] ? `${DWG_VERSIONS[v('$ACADVER')]} (${v('$ACADVER')})` : v('$ACADVER')),
      row('Unit', INSUNITS[Number(v('$INSUNITS'))] ?? ''),
      row('Created', created ? formatDate(created, { utc: true }) : ''),
      row('Modified', updated ? formatDate(updated, { utc: true }) : ''),
      row('Editing time', editing > 0 ? `${Math.round(editing * 24 * 60)} min` : ''),
      row('Code page', v('$DWGCODEPAGE')),
    ]),
  ].filter((s): s is MetaSection => s !== null);
}

/** Decodes the escapes of STEP strings: '' for ', \X2\…\X0\ for UTF-16, \X\HH for Latin-1. */
function stepString(raw: string): string {
  return raw
    .replace(/''/g, "'")
    .replace(/\\X2\\([0-9A-F]+)\\X0\\/gi, (_, hex: string) => String.fromCharCode(...(hex.match(/.{4}/g) ?? []).map((h) => parseInt(h, 16))))
    .replace(/\\X\\([0-9A-F]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\S\\(.)/g, (_, c: string) => String.fromCharCode(c.charCodeAt(0) + 128));
}

type StepValue = string | null | StepValue[];

/** Parameter list of a header entity: strings, $ and nested lists. */
function stepParameters(source: string): StepValue[] {
  let pos = 0;
  const parseList = (): StepValue[] => {
    const items: StepValue[] = [];
    pos++; // (
    while (pos < source.length) {
      const c = source[pos];
      if (c === ')') {
        pos++;
        return items;
      }
      if (c === '(') items.push(parseList());
      else if (c === "'") {
        let end = pos + 1;
        while (end < source.length && !(source[end] === "'" && source[end + 1] !== "'")) end += source[end] === "'" ? 2 : 1;
        items.push(stepString(source.slice(pos + 1, end)));
        pos = end + 1;
        continue;
      } else if (c === '$') items.push(null);
      else if (/[^\s,]/.test(c)) {
        const end = source.slice(pos).search(/[,)]/);
        items.push(source.slice(pos, end < 0 ? undefined : pos + end).trim());
        pos += end < 0 ? source.length : end;
        continue;
      }
      pos++;
    }
    return items;
  };
  return source.startsWith('(') ? parseList() : [];
}

export async function stepMetadata(file: File): Promise<MetaSection[]> {
  const text = new TextDecoder().decode(await file.slice(0, 256 * 1024).arrayBuffer());
  const header = /HEADER;([\s\S]*?)ENDSEC;/i.exec(text)?.[1];
  if (!header) return [];
  const entity = (name: string) => {
    const match = new RegExp(`${name}\\s*(\\([\\s\\S]*?\\))\\s*;`, 'i').exec(header);
    return match ? stepParameters(match[1]) : [];
  };
  const flat = (value: StepValue | undefined): string =>
    Array.isArray(value) ? value.map(flat).filter(Boolean).join(', ') : (value ?? '').trim();
  const [description] = entity('FILE_DESCRIPTION');
  const [name, timestamp, authors, organizations, preprocessor, system, authorization] = entity('FILE_NAME');
  const schema = flat(entity('FILE_SCHEMA')[0]);
  const ap = STEP_SCHEMAS.find(([pattern]) => pattern.test(schema))?.[1];
  return [
    section('Model', [
      row('Name', flat(name)),
      row('Description', flat(description)),
      row('Created', xmlDate(flat(timestamp)) ?? flat(timestamp)),
      row('Author', flat(authors)),
      row('Organization', flat(organizations)),
      row('Authorization', flat(authorization)),
    ]),
    section('Origin', [
      row('CAD system', flat(system)),
      row('STEP exporter', flat(preprocessor)),
      row('Schema', ap ? `${ap} · ${schema}` : schema),
    ]),
  ].filter((s): s is MetaSection => s !== null);
}
