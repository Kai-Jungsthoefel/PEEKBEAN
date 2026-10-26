// SPDX-License-Identifier: GPL-3.0-or-later
// What the info panel shows: sections of label/value rows, plus helpers to build them from raw values.

export interface MetaRow {
  label: string;
  value: string;
  /** External link, opened only when the user clicks it. */
  href?: string;
}

export interface MetaSection {
  title: string;
  rows: MetaRow[];
}

export function formatDate(date: Date, options: { utc?: boolean } = {}): string {
  return date.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium', ...(options.utc ? { timeZone: 'UTC' } : {}) });
}

export function formatNumber(value: number, digits = 2): string {
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

/** Plain text from strings, numbers, dates, lists and XMP language alternatives ({ value, lang }). */
export function text(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : formatDate(value);
  if (typeof value === 'number') return Number.isFinite(value) ? formatNumber(value) : '';
  if (typeof value === 'string') return value.replace(/\0+$/, '').trim();
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('value' in record) return text(record.value);
    const first = Object.values(record)[0];
    return typeof first === 'string' ? first.trim() : '';
  }
  return String(value);
}

/** A row, or null when there is nothing to show. */
export function row(label: string, value: unknown): MetaRow | null {
  const shown = text(value);
  return shown ? { label, value: shown } : null;
}

/** A section without empty rows; null when no row is left. */
export function section(title: string, rows: (MetaRow | null | undefined | false)[]): MetaSection | null {
  const kept = rows.filter((r): r is MetaRow => !!r);
  return kept.length ? { title, rows: kept } : null;
}

/** Location rows: coordinates, altitude and a link to OpenStreetMap that leaves the page only on click. */
export function locationRows(latitude: number, longitude: number, altitude?: number): MetaRow[] {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || (latitude === 0 && longitude === 0)) return [];
  const coordinate = (v: number, positive: string, negative: string) => `${formatNumber(Math.abs(v), 6)}° ${v < 0 ? negative : positive}`;
  const lat = latitude.toFixed(6);
  const lon = longitude.toFixed(6);
  return [
    { label: 'Coordinates', value: `${coordinate(latitude, 'N', 'S')}, ${coordinate(longitude, 'E', 'W')}` },
    ...(altitude !== undefined && Number.isFinite(altitude) ? [{ label: 'Altitude', value: `${formatNumber(altitude, 1)} m` }] : []),
    { label: 'Map', value: 'Show on OpenStreetMap', href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=16/${lat}/${lon}` },
  ];
}

/** ISO 6709 location as written by cameras and phones into videos, e.g. "+53.5511+009.9937+012.000/". */
export function parseIso6709(value: string): { latitude: number; longitude: number; altitude?: number } | null {
  const match = /^([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)([+-]\d+(?:\.\d+)?)?/.exec(value.trim());
  if (!match) return null;
  return { latitude: Number(match[1]), longitude: Number(match[2]), ...(match[3] ? { altitude: Number(match[3]) } : {}) };
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)} h` : `${m}:${pad(s)} min`;
}

/** Child elements of an XML document by local name, ignoring namespaces. */
export function xmlText(doc: Document, localName: string): string {
  return doc.getElementsByTagNameNS('*', localName)[0]?.textContent?.trim() ?? '';
}

export function xmlDate(value: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
