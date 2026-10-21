import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW, fixture } from '../../test/helpers.ts';
import type {
  NsDisruption,
  NsJourney,
  NsLift,
  NsPlaceGroup,
  NsPrognose,
  NsPriceV2,
  NsStationV3,
  NsTrainInfo
} from '../ns/types.ts';
import { StationIndex } from '../resolve.ts';
import { formatComposition } from './composition.ts';
import { formatDisruption } from './disruptions.ts';
import { formatFacilities, formatLifts, formatOvFiets } from './facilities.ts';
import { formatJourney } from './journey.ts';
import { formatPrice } from './price.ts';

const stations = new StationIndex(
  fixture<{ payload: NsStationV3[] }>('stations').payload
);

describe('formatPrice', () => {
  it('converts cents to euros and derives the other class', () => {
    expect(
      formatPrice(fixture<{ payload: NsPriceV2 }>('price').payload)
    ).toEqual({
      priceEur: 14.7,
      travelClass: 2,
      otherClassPriceEur: 26.46,
      products: ['ETICKET_ENKELE_REIS'],
      operator: 'NS'
    });
    const first = formatPrice(
      fixture<{ payload: NsPriceV2 }>('price-return-first').payload
    );
    expect(first).toMatchObject({
      priceEur: 108.34,
      travelClass: 1,
      otherClassPriceEur: 84.82
    });
  });
});

describe('formatJourney', () => {
  const journey = fixture<{ payload: NsJourney }>('journey').payload;

  it('lists calling points with times and tracks, skipping passing stations', () => {
    const result = formatJourney(journey, FIXTURE_NOW, false);
    expect(result).toMatchObject({
      train: '3529',
      type: 'Intercity',
      rollingStock: 'VIRM'
    });
    expect(result.stops?.[0]).toMatchObject({
      station: 'Dordrecht',
      departure: '07:34',
      track: '2',
      crowd: 'low'
    });
    expect(result.stops?.some((s) => s.passing)).toBe(false);
    const all = formatJourney(journey, FIXTURE_NOW, true);
    expect(all.stops!.length).toBeGreaterThanOrEqual(result.stops!.length);
  });
});

describe('formatDisruption', () => {
  const items = fixture<NsDisruption[]>('disruptions');

  it('summarises a maintenance item', () => {
    const maintenance = items.find((d) => d.type === 'MAINTENANCE')!;
    const result = formatDisruption(maintenance, FIXTURE_NOW, false);
    expect(result).toMatchObject({
      type: 'maintenance',
      cause: 'engineering works'
    });
    expect(result).toHaveProperty('routes');
    expect(result).not.toHaveProperty('stations');
  });

  it('adds stations, advice and alternative transport in detail mode', () => {
    const maintenance = items.find(
      (d) => (d.alternativeTransportTimespans ?? []).length > 0
    )!;
    const result = formatDisruption(maintenance, FIXTURE_NOW, true);
    expect(result).toHaveProperty('stations');
    expect(result).toHaveProperty('alternativeTransportStops');
  });

  it('formats calamities', () => {
    const result = formatDisruption(
      {
        id: 'c1',
        type: 'CALAMITY',
        title: 'Storm',
        description: 'No trains',
        lastUpdated: '2026-10-06T08:00:00+0200'
      },
      FIXTURE_NOW,
      false
    );
    expect(result).toEqual({
      id: 'c1',
      type: 'calamity',
      title: 'Storm',
      description: 'No trains',
      updated: '08:00'
    });
  });
});

describe('formatComposition', () => {
  it('describes units, facilities, seats and crowding per station', () => {
    const result = formatComposition(
      fixture<NsTrainInfo>('virtual-train'),
      fixture<NsPrognose>('virtual-train-prognose'),
      stations
    );
    expect(result).toMatchObject({
      train: 3529,
      station: 'Utrecht Centraal',
      rollingStock: 'VIRM',
      parts: 2,
      coaches: 10,
      lengthM: 269
    });
    expect(result.shortened).toBeUndefined();
    expect(result.units?.[0]).toMatchObject({
      type: 'VIRMm1 VI',
      destination: 'Venlo',
      firstClassSeats: 120
    });
    expect(result.units?.[0]?.facilities).toEqual(
      expect.arrayContaining(['quiet-zone', 'toilet', 'wifi'])
    );
    expect(result.units?.[1]?.destination).toBe('Eindhoven Centraal');
    expect(result.crowdByStation?.length).toBeGreaterThan(0);
    expect(JSON.stringify(result)).not.toContain('png');
  });
});

describe('station facilities', () => {
  it('reads OV-fiets availability as numbers', () => {
    const result = formatOvFiets(
      fixture<{ payload: NsPlaceGroup[] }>('ovfiets').payload
    );
    expect(result[0]?.available).toBeTypeOf('number');
    expect(result[0]?.staffed).toBe(true);
  });

  it('puts out-of-order lifts first', () => {
    const lifts = formatLifts(fixture<NsLift[]>('lifts'));
    expect(lifts.total).toBe(18);
    expect(lifts.outOfOrder).toHaveLength(2);
    expect(lifts.available).toBe(16);
  });

  it("splits facilities and shops and keeps today's hours", () => {
    const { facilities, shops } = formatFacilities(
      fixture<{ payload: NsPlaceGroup[] }>('places').payload,
      2
    );
    expect(facilities.find((f) => f.name === 'Bagagekluizen')).toMatchObject({
      hoursToday: '05:00-01:00'
    });
    expect(facilities.some((f) => f.name === 'Lift')).toBe(false);
    expect(shops.some((s) => s.startsWith('AH to go'))).toBe(true);
  });
});
