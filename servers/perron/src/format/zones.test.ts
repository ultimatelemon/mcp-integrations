import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { distanceMeters } from './vehicles.ts';
import { insideAnyZone, nearestZone } from './zones.ts';

const square = (w: number, s: number, e: number, n: number) => [
  [
    [w, s],
    [e, s],
    [e, n],
    [w, n],
    [w, s]
  ]
];

// One zone east of the origin, and one with a hole (a no-parking area) further away.
const zones: FeatureCollection<Polygon | MultiPolygon> = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'MultiPolygon',
        coordinates: [square(5.195, 52.365, 5.205, 52.375)]
      }
    },
    {
      type: 'Feature',
      properties: {},
      geometry: {
        type: 'Polygon',
        coordinates: [
          ...square(5.1, 52.3, 5.15, 52.33),
          ...square(5.12, 52.31, 5.13, 52.32)
        ]
      }
    }
  ]
};

describe('nearestZone', () => {
  it('says so when the point is inside', () => {
    expect(nearestZone([zones], { lat: 52.37, lon: 5.2 })).toEqual({
      inZone: true
    });
  });

  it('finds the nearest edge and a parking spot just inside it', () => {
    const origin = { lat: 52.36756, lon: 5.19034 };
    const answer = nearestZone([zones], origin);
    expect(answer.inZone).toBe(false);
    expect(answer.edge?.lon).toBeCloseTo(5.195, 5);
    expect(answer.edge?.lat).toBeCloseTo(52.36756, 4);
    expect(answer.distanceM).toBeGreaterThan(310);
    expect(answer.distanceM).toBeLessThan(325);
    expect(answer.inside).toBeDefined();
    expect(insideAnyZone(zones.features, answer.inside!)).toBe(true);
    const past = distanceMeters(answer.edge!, answer.inside!);
    expect(past).toBeGreaterThan(5);
    expect(past).toBeLessThan(12);
  });

  it('treats a hole as outside and measures to its rim', () => {
    const answer = nearestZone([zones], { lat: 52.315, lon: 5.1215 });
    expect(answer.inZone).toBe(false);
    expect(answer.edge?.lon).toBeCloseTo(5.12, 5);
    expect(answer.distanceM).toBeLessThan(110);
  });

  it('answers without an edge when there are no zones', () => {
    expect(nearestZone([], { lat: 52, lon: 5 })).toEqual({ inZone: false });
  });
});
