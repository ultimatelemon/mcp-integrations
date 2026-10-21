import turfBearing from '@turf/bearing';
import booleanPointInPolygon from '@turf/boolean-point-in-polygon';
import turfDestination from '@turf/destination';
import turfDistance from '@turf/distance';
import { point } from '@turf/helpers';
import nearestPointOnLine from '@turf/nearest-point-on-line';
import polygonToLine from '@turf/polygon-to-line';
import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiLineString,
  MultiPolygon,
  Polygon,
  Position
} from 'geojson';
import type { Point } from './vehicles.ts';

type Zone = Feature<Polygon | MultiPolygon>;

export interface ZoneAnswer {
  inZone: boolean;
  /** Closest point on a zone boundary, when outside. */
  edge?: Point;
  /** A few metres past the edge, inside the zone: where to actually park. */
  inside?: Point;
  distanceM?: number;
}

/** Steps past the edge to try, in metres: far enough to clear the line, near enough to stay on the street. */
const STEPS = [8, 15, 25, 40, 4];

const toPoint = (p: Position): Point => ({ lat: p[1]!, lon: p[0]! });
const round = (p: Point): Point => ({
  lat: Math.round(p.lat * 1e6) / 1e6,
  lon: Math.round(p.lon * 1e6) / 1e6
});

function zonesOf(
  collection: FeatureCollection<Polygon | MultiPolygon>
): Zone[] {
  return collection.features.filter(
    (f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon'
  );
}

function boundaries(zone: Zone): Feature<LineString | MultiLineString>[] {
  const lines = polygonToLine(zone);
  return lines.type === 'FeatureCollection' ? lines.features : [lines];
}

export function insideAnyZone(zones: Zone[], at: Point): boolean {
  const p = point([at.lon, at.lat]);
  return zones.some((z) => booleanPointInPolygon(p, z));
}

/** Whether a point lies in a service area, and if not, the nearest place that does. */
export function nearestZone(
  collections: FeatureCollection<Polygon | MultiPolygon>[],
  at: Point
): ZoneAnswer {
  const zones = collections.flatMap(zonesOf);
  if (insideAnyZone(zones, at)) return { inZone: true };

  const origin = point([at.lon, at.lat]);
  let best: { coords: Position; km: number } | undefined;
  for (const zone of zones) {
    for (const line of boundaries(zone)) {
      const nearest = nearestPointOnLine(line, origin);
      const km = turfDistance(origin, nearest);
      if (!best || km < best.km)
        best = { coords: nearest.geometry.coordinates, km };
    }
  }
  if (!best) return { inZone: false };

  const edge = point(best.coords);
  const heading = turfBearing(origin, edge);
  let inside: Point | undefined;
  for (const metres of STEPS) {
    const candidate = turfDestination(edge, metres / 1000, heading);
    const p = toPoint(candidate.geometry.coordinates);
    if (insideAnyZone(zones, p)) {
      inside = p;
      break;
    }
  }
  return {
    inZone: false,
    edge: round(toPoint(best.coords)),
    ...(inside ? { inside: round(inside) } : {}),
    distanceM: Math.round(best.km * 1000)
  };
}
