// SPDX-License-Identifier: GPL-3.0-or-later
// Lengths and areas on the WGS84 ellipsoid, and the numbers of a GPS track.
import type { Position } from 'geojson';

const A = 6378137;
const F = 1 / 298.257223563;
const B = A * (1 - F);
const E2 = F * (2 - F);
const DEG = Math.PI / 180;

/** Distance in meters between two points (degrees), by Vincenty's inverse formula; accurate to well below 1 mm. */
export function distance(lon1: number, lat1: number, lon2: number, lat2: number): number {
  if (lon1 === lon2 && lat1 === lat2) return 0;
  const L = (lon2 - lon1) * DEG;
  const U1 = Math.atan((1 - F) * Math.tan(lat1 * DEG));
  const U2 = Math.atan((1 - F) * Math.tan(lat2 * DEG));
  const sinU1 = Math.sin(U1);
  const cosU1 = Math.cos(U1);
  const sinU2 = Math.sin(U2);
  const cosU2 = Math.cos(U2);
  let lambda = L;
  for (let i = 0; i < 200; i++) {
    const sinLambda = Math.sin(lambda);
    const cosLambda = Math.cos(lambda);
    const sinSigma = Math.hypot(cosU2 * sinLambda, cosU1 * sinU2 - sinU1 * cosU2 * cosLambda);
    if (sinSigma === 0) return 0;
    const cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    const sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    const cos2Alpha = 1 - sinAlpha * sinAlpha;
    const cos2SigmaM = cos2Alpha ? cosSigma - (2 * sinU1 * sinU2) / cos2Alpha : 0;
    const C = (F / 16) * cos2Alpha * (4 + F * (4 - 3 * cos2Alpha));
    const previous = lambda;
    lambda = L + (1 - C) * F * sinAlpha * (sigma + C * sinSigma * (cos2SigmaM + C * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - previous) < 1e-12) {
      const u2 = (cos2Alpha * (A * A - B * B)) / (B * B);
      const a = 1 + (u2 / 16384) * (4096 + u2 * (-768 + u2 * (320 - 175 * u2)));
      const b = (u2 / 1024) * (256 + u2 * (-128 + u2 * (74 - 47 * u2)));
      const deltaSigma = b * sinSigma * (cos2SigmaM + (b / 4) * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM) - (b / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
      return B * a * (sigma - deltaSigma);
    }
  }
  // Nearly antipodal points, where the iteration does not settle: the great circle on the mean sphere.
  const h = Math.sin(((lat2 - lat1) * DEG) / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(L / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

const E = Math.sqrt(E2);
const q = (sinPhi: number) => (1 - E2) * (sinPhi / (1 - E2 * sinPhi * sinPhi) - (1 / (2 * E)) * Math.log((1 - E * sinPhi) / (1 + E * sinPhi)));
const QP = q(1);
/** Radius of the sphere with the ellipsoid's surface area. */
const AUTHALIC_RADIUS = A * Math.sqrt(QP / 2);

/**
 * Area in square meters of a ring of [lon, lat] points (degrees), either orientation. Latitudes become authalic
 * latitudes, so the sphere has the ellipsoid's area; good to a small fraction of a percent.
 */
export function ringArea(ring: ArrayLike<number>): number {
  const n = ring.length / 2;
  if (n < 3) return 0;
  let sum = 0;
  const beta = (lat: number) => Math.asin(Math.max(-1, Math.min(1, q(Math.sin(lat * DEG)) / QP)));
  for (let i = 0; i < n; i++) {
    const prev = (i + n - 1) % n;
    const next = (i + 1) % n;
    let dLon = ring[2 * next] - ring[2 * prev];
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;
    sum += dLon * DEG * Math.sin(beta(ring[2 * i + 1]));
  }
  return Math.abs((sum * AUTHALIC_RADIUS * AUTHALIC_RADIUS) / 2);
}

/** Length in meters of a line of [lon, lat] points (degrees). */
export function lineLength(line: ArrayLike<number>): number {
  let total = 0;
  for (let i = 2; i < line.length; i += 2) total += distance(line[i - 2], line[i - 1], line[i], line[i + 1]);
  return total;
}

export interface TrackStats {
  length: number;
  /** Seconds from the first to the last time stamp. */
  duration?: number;
  ascent?: number;
  descent?: number;
  minElevation?: number;
  maxElevation?: number;
  start?: string;
}

/**
 * Numbers of a track from its segments ([lon, lat, elevation] points) and their time stamps. Ascent and descent add
 * up every rise and fall of the recorded elevation, as most GPS software does without smoothing.
 */
export function trackStats(segments: Position[][], times: unknown): TrackStats {
  const stats: TrackStats = { length: 0 };
  let min = Infinity;
  let max = -Infinity;
  let ascent = 0;
  let descent = 0;
  let elevations = 0;
  for (const segment of segments) {
    let previous: Position | null = null;
    for (const p of segment) {
      if (previous) {
        stats.length += distance(previous[0], previous[1], p[0], p[1]);
        if (typeof p[2] === 'number' && typeof previous[2] === 'number') {
          const rise = p[2] - previous[2];
          if (rise > 0) ascent += rise;
          else descent -= rise;
        }
      }
      if (typeof p[2] === 'number' && Number.isFinite(p[2])) {
        elevations++;
        min = Math.min(min, p[2]);
        max = Math.max(max, p[2]);
      }
      previous = p;
    }
  }
  if (elevations) Object.assign(stats, { ascent, descent, minElevation: min, maxElevation: max });
  const stamps = (Array.isArray(times) ? times.flat(2) : [])
    .map((t) => (typeof t === 'string' ? Date.parse(t) : NaN))
    .filter((t) => Number.isFinite(t));
  if (stamps.length >= 2) {
    const first = Math.min(...stamps.slice(0, 50));
    const last = Math.max(...stamps.slice(-50));
    stats.duration = (last - first) / 1000;
    stats.start = new Date(first).toISOString();
  }
  return stats;
}

const fixed = (v: number, digits: number) => v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function formatLength(meters: number): string {
  if (meters < 1000) return `${fixed(meters, meters < 10 ? 2 : 1)} m`;
  return `${fixed(meters / 1000, meters < 100000 ? 2 : 1)} km`;
}

export function formatArea(squareMeters: number): string {
  if (squareMeters < 10000) return `${fixed(squareMeters, 1)} m²`;
  if (squareMeters < 1e6) return `${fixed(squareMeters / 10000, 2)} ha`;
  return `${fixed(squareMeters / 1e6, 2)} km²`;
}

export function formatDuration(seconds: number): string {
  const s = Math.round(seconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')} h` : `${minutes}:${String(s % 60).padStart(2, '0')} min`;
}

export function formatDegrees(lon: number, lat: number): string {
  const deg = (v: number) => fixed(Math.abs(v), 5);
  return `${deg(lat)}° ${lat < 0 ? 'S' : 'N'}, ${deg(lon)}° ${lon < 0 ? 'W' : 'E'}`;
}
