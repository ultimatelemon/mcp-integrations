import { describe, expect, it } from 'vitest';
import { fixture } from '../../test/helpers.ts';
import {
  createVehicleProvider,
  toSnapshot,
  type VehiclesResponse
} from '../deelmobiliteit/client.ts';
import {
  direction,
  distanceMeters,
  findNearby,
  knownOperators,
  operatorKey
} from './vehicles.ts';

const feed = fixture<VehiclesResponse>('vehicles');
const vehicles = toSnapshot(feed);
const UTRECHT = { lat: 52.08889, lon: 5.11028 };

describe('distanceMeters and direction', () => {
  it('measures great-circle distance', () => {
    // Utrecht Centraal to Amsterdam Centraal is about 34 km as the crow flies.
    const d = distanceMeters(UTRECHT, { lat: 52.3789, lon: 4.9004 });
    expect(d).toBeGreaterThan(34_000);
    expect(d).toBeLessThan(36_000);
  });

  it('gives an eight-point compass direction', () => {
    expect(direction(UTRECHT, { lat: 52.1, lon: 5.11028 })).toBe('N');
    expect(direction(UTRECHT, { lat: 52.08889, lon: 5.0 })).toBe('W');
    expect(direction(UTRECHT, { lat: 52.08, lon: 5.12 })).toBe('SE');
  });
});

describe('findNearby', () => {
  const base = { radiusM: 500, limit: 10, includeUnavailable: false };

  it('lists available vehicles in range, nearest first', () => {
    const result = findNearby(vehicles, UTRECHT, base);
    expect(result.total).toBe(5);
    expect(result.byOperator).toEqual({
      check: 2,
      felyx: 1,
      gosharing: 1,
      cykl: 1
    });
    const distances = result.vehicles.map((v) => v.distance_m ?? 0);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(result.closestOutsideRadius).toBeUndefined();
  });

  it('filters by operator regardless of case and spacing', () => {
    const result = findNearby(vehicles, UTRECHT, {
      ...base,
      operators: ['CHECK']
    });
    expect(result.vehicles.map((v) => v.operator)).toEqual(['check', 'check']);
    expect(operatorKey('GO Sharing')).toBe(operatorKey('gosharing'));
  });

  it('keeps reserved and disabled vehicles out unless asked', () => {
    const result = findNearby(vehicles, UTRECHT, {
      ...base,
      operators: ['check'],
      includeUnavailable: true
    });
    expect(result.total).toBe(4);
    expect(result.vehicles.some((v) => v.reserved)).toBe(true);
    expect(result.vehicles.some((v) => v.disabled)).toBe(true);
  });

  it('filters by type', () => {
    const result = findNearby(vehicles, UTRECHT, {
      ...base,
      formFactors: ['bicycle']
    });
    expect(result.vehicles).toEqual([
      expect.objectContaining({ operator: 'cykl', form_factor: 'bicycle' })
    ]);
  });

  it('reports the closest match when nothing is in range', () => {
    const result = findNearby(vehicles, UTRECHT, {
      ...base,
      radiusM: 50,
      operators: ['check']
    });
    expect(result.total).toBe(0);
    expect(result.closestOutsideRadius).toMatchObject({ operator: 'check' });
  });

  it('knows which operators are in the feed', () => {
    expect(knownOperators(vehicles)).toEqual([
      'baqme',
      'check',
      'cykl',
      'felyx',
      'gosharing'
    ]);
  });
});

describe('toSnapshot', () => {
  it('stores each operator and type once and skips unusable rows', () => {
    const snapshot = toSnapshot({
      data: {
        vehicles: [
          ...(feed.data?.vehicles ?? []),
          { system_id: 'check', lat: Number.NaN, lon: 5 }
        ]
      }
    });
    expect(snapshot.count).toBe(10);
    expect(snapshot.operators.filter((o) => o === 'check')).toHaveLength(1);
    expect(snapshot.types).toEqual(['moped', 'bicycle', 'cargo_bicycle']);
  });
});

describe('createVehicleProvider', () => {
  it('reuses the snapshot within its ttl and falls back to it on failure', async () => {
    let clock = 0;
    let calls = 0;
    let broken = false;
    const provider = createVehicleProvider(
      () => {
        calls++;
        return broken
          ? Promise.reject(new Error('down'))
          : Promise.resolve(feed);
      },
      { minTtlMs: 30_000, now: () => clock }
    );

    const [a, b] = await Promise.all([provider(), provider()]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a.count).toBe(vehicles.count);

    clock = 10_000;
    await provider();
    expect(calls).toBe(1);

    clock = 31_000;
    broken = true;
    expect(await provider()).toBe(a);
    expect(calls).toBe(2);
  });
});
