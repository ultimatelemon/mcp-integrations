import {
  DISABLED,
  RESERVED,
  type VehicleSnapshot
} from '../deelmobiliteit/client.ts';
import { normalize } from '../resolve.ts';
import { compact } from './util.ts';

export interface Point {
  lat: number;
  lon: number;
}

const EARTH_RADIUS_M = 6_371_000;
const rad = (deg: number) => (deg * Math.PI) / 180;

export function distanceMeters(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const;

/** Eight-point compass direction from `a` towards `b`. */
export function direction(a: Point, b: Point): string {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  const bearing = ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
  return COMPASS[Math.round(bearing / 45) % 8]!;
}

/** "GO Sharing", "go-sharing" and "gosharing" are the same operator. */
export function operatorKey(name: string): string {
  return normalize(name).replace(/ /g, '');
}

export interface NearbyOptions {
  operators?: string[] | undefined;
  formFactors?: string[] | undefined;
  radiusM: number;
  limit: number;
  includeUnavailable: boolean;
}

function toItem(
  snapshot: VehicleSnapshot,
  i: number,
  origin: Point,
  distance: number
) {
  const at = { lat: snapshot.lat[i]!, lon: snapshot.lon[i]! };
  const flags = snapshot.flags[i]!;
  return compact({
    operator: snapshot.operators[snapshot.operator[i]!],
    form_factor: snapshot.types[snapshot.type[i]!],
    propulsion: snapshot.propulsions[snapshot.propulsion[i]!],
    distance_m: Math.round(distance),
    direction: direction(origin, at),
    lat: Math.round(at.lat * 1e6) / 1e6,
    lon: Math.round(at.lon * 1e6) / 1e6,
    reserved: (flags & RESERVED) !== 0,
    disabled: (flags & DISABLED) !== 0
  });
}

export type NearbyVehicle = ReturnType<typeof toItem>;

/** Indexes into a lookup table whose entries pass `keep`; undefined keeps them all. */
function allowed(
  table: string[],
  wanted: string[] | undefined,
  key = (s: string) => s
) {
  if (!wanted?.length) return undefined;
  const keys = new Set(wanted.map(key));
  return new Set(
    table.flatMap((value, i) => (keys.has(key(value)) ? [i] : []))
  );
}

export function findNearby(
  snapshot: VehicleSnapshot,
  origin: Point,
  options: NearbyOptions
) {
  const operators = allowed(snapshot.operators, options.operators, operatorKey);
  const types = allowed(snapshot.types, options.formFactors);
  const unavailable = options.includeUnavailable ? 0 : RESERVED | DISABLED;
  // A degree of latitude is ~111 km everywhere; this box skips the trigonometry for
  // the tens of thousands of vehicles that are obviously too far away.
  const dLat = options.radiusM / 111_000;

  const matching: { i: number; d: number }[] = [];
  let closest: { i: number; d: number } | undefined;
  for (let i = 0; i < snapshot.count; i++) {
    if (operators && !operators.has(snapshot.operator[i]!)) continue;
    if (types && !types.has(snapshot.type[i]!)) continue;
    if (snapshot.flags[i]! & unavailable) continue;
    const lat = snapshot.lat[i]!;
    const near = Math.abs(lat - origin.lat) <= dLat;
    // Out-of-range vehicles still count for the closest one, but only when nothing is in range.
    if (!near && matching.length > 0) continue;
    const d = distanceMeters(origin, { lat, lon: snapshot.lon[i]! });
    if (d <= options.radiusM) matching.push({ i, d });
    else if (!closest || d < closest.d) closest = { i, d };
  }
  matching.sort((a, b) => a.d - b.d);

  const byOperator: Record<string, number> = {};
  for (const { i } of matching) {
    const name = snapshot.operators[snapshot.operator[i]!]!;
    byOperator[name] = (byOperator[name] ?? 0) + 1;
  }
  return {
    total: matching.length,
    byOperator,
    vehicles: matching
      .slice(0, options.limit)
      .map((m) => toItem(snapshot, m.i, origin, m.d)),
    // When nothing is in range, the closest one still tells how far to walk.
    closestOutsideRadius:
      matching.length === 0 && closest
        ? toItem(snapshot, closest.i, origin, closest.d)
        : undefined
  };
}

/** The operators in the feed, so an unknown name can be answered with the real ones. */
export function knownOperators(snapshot: VehicleSnapshot): string[] {
  return [...snapshot.operators].sort();
}
