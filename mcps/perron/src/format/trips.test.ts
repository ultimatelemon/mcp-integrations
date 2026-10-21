import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW, fixture } from '../../test/helpers.ts';
import type { NsTrip, NsTripsResponse } from '../ns/types.ts';
import {
  formatTrip,
  formatTrips,
  summarizeTrips,
  tripStatus
} from './trips.ts';

const response = fixture<NsTripsResponse>('trips');

function clone(): NsTrip {
  return structuredClone(response.trips![0]!);
}

describe('formatTrips', () => {
  it('maps a direct trip to a compact option', () => {
    const [option] = formatTrips(response, FIXTURE_NOW, 4);
    expect(option).toMatchObject({
      departure: '09:28',
      arrival: '10:05',
      durationMin: 37,
      transfers: 0,
      status: 'normal',
      crowd: 'medium',
      priceEur: 14.7
    });
    expect(option?.legs?.[0]).toMatchObject({
      operator: 'NS',
      type: 'Intercity',
      train: '1726',
      direction: 'Den Haag Centraal',
      from: {
        station: 'Utrecht Centraal',
        code: 'UT',
        time: '09:28',
        track: '8'
      },
      to: { station: 'Den Haag Centraal', code: 'GVC', time: '10:05' }
    });
    expect(option).not.toHaveProperty('ctxRecon');
  });

  it('leaves out styling, icons and geometry', () => {
    const json = JSON.stringify(formatTrips(response, FIXTURE_NOW, 4));
    for (const key of [
      'nesProperties',
      'iconNesProperties',
      'lat',
      'lng',
      'shareUrl',
      'stops',
      'ctxRecon'
    ]) {
      expect(json).not.toContain(`"${key}"`);
    }
  });

  it('keeps four options compact', () => {
    // Each option also gets a 10-character tripId plus its key in the tool.
    const options = formatTrips(response, FIXTURE_NOW, 4);
    expect(JSON.stringify(options).length).toBeLessThan(2000);
  });

  it('formats multi-leg international trips with transfer notes', () => {
    const [option] = formatTrips(
      fixture('trips-international'),
      FIXTURE_NOW,
      1
    );
    expect(option?.transfers).toBe(2);
    expect(option?.legs).toHaveLength(3);
    expect(option?.legs?.[1]?.messages).toContain('Toeslag');
  });
});

describe('track changes, delays and cancellations', () => {
  it('marks a track change explicitly', () => {
    const trip = clone();
    trip.legs[0]!.origin.actualTrack = '5';
    const leg = formatTrip(trip, FIXTURE_NOW).legs?.[0];
    expect(leg?.from).toMatchObject({
      track: '5',
      plannedTrack: '8',
      trackChanged: true
    });
  });

  it('reports delay as minutes and status delayed', () => {
    const trip = clone();
    trip.legs[0]!.origin.actualDateTime = '2026-10-06T09:33:00+0200';
    trip.legs[0]!.destination.actualDateTime = '2026-10-06T10:11:00+0200';
    const option = formatTrip(trip, FIXTURE_NOW);
    expect(option.status).toBe('delayed');
    expect(option.delayMin).toBe(6);
    expect(option.actualArrival).toBe('10:11');
    expect(option.legs?.[0]?.from).toMatchObject({
      delayMin: 5,
      actualTime: '09:33'
    });
  });

  it('reports cancellation over everything else', () => {
    const trip = clone();
    trip.legs[0]!.cancelled = true;
    expect(tripStatus(trip)).toBe('cancelled');
    expect(formatTrip(trip, FIXTURE_NOW).legs?.[0]?.cancelled).toBe(true);
  });

  it('maps alternative transport', () => {
    const trip = clone();
    trip.status = 'ALTERNATIVE_TRANSPORT';
    expect(tripStatus(trip)).toBe('alternative-transport');
  });
});

describe('summarizeTrips', () => {
  it('writes one line per option', () => {
    const text = summarizeTrips(
      'Utrecht Centraal',
      'Den Haag Centraal',
      formatTrips(response, FIXTURE_NOW, 2)
    );
    expect(text.split('\n')).toHaveLength(3);
    expect(text).toContain('09:28 → 10:05');
  });
});

describe('formatTrip with stops', () => {
  it('lists calling points between origin and destination, without passing stations', () => {
    const trip = fixture<NsTrip>('trip-single');
    const leg = formatTrip(trip, FIXTURE_NOW, true).legs?.[0];
    const names = leg?.stops?.map((s) => s.station) ?? [];
    expect(names.length).toBeGreaterThan(0);
    expect(names).not.toContain('Utrecht Leidsche Rijn');
    expect(names).not.toContain(leg?.from?.station);
    expect(names).not.toContain(leg?.to?.station);
    expect(leg?.stops?.[0]?.time).toMatch(/^\d{2}:\d{2}$/);
  });
});
