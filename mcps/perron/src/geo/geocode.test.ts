import { describe, expect, it } from 'vitest';
import { fixture } from '../../test/helpers.ts';
import { silentLogger } from '../lib/logger.ts';
import { memoryDurableStore } from '../lib/store.ts';
import type { NsStationV3 } from '../ns/types.ts';
import { StationIndex } from '../resolve.ts';
import { Geocoder, namesMatch } from './geocode.ts';
import type { Nominatim } from './nominatim.ts';
import {
  municipalityCode,
  parsePoint,
  type Pdok,
  type PdokDoc
} from './pdok.ts';

const index = new StationIndex(
  fixture<{ payload: NsStationV3[] }>('stations').payload
);

const SEARCH: Record<string, PdokDoc> = {
  'damrak 1 amsterdam': {
    type: 'adres',
    weergavenaam: 'Damrak 1, 1012LG Amsterdam',
    centroide_ll: 'POINT(4.89508 52.37601)',
    gemeentecode: '0363'
  },
  // What PDOK did for a station name: a street that happens to share a word.
  'muziekwijk ijsbaan almere': {
    type: 'weg',
    weergavenaam: 'Ijsbaanpad, Almere',
    centroide_ll: 'POINT(5.2 52.37)',
    gemeentecode: '0034'
  }
};

function setup() {
  const calls = { search: 0, reverse: 0, nominatim: 0 };
  const pdok: Pdok = {
    search(q) {
      calls.search++;
      return Promise.resolve(SEARCH[q.toLowerCase()]);
    },
    reverse(lat, lon) {
      calls.reverse++;
      return Promise.resolve({
        weergavenaam: `Teststraat 1, ${lat > 52.36 && lon > 5 ? 'Almere' : 'Amsterdam'}`,
        straatnaam: 'Teststraat',
        gemeentecode: lon > 5 ? '0034' : '0363',
        afstand: 12
      });
    }
  };
  const nominatim: Nominatim = {
    search(q) {
      calls.nominatim++;
      return Promise.resolve(
        q.includes('Muziekwijk')
          ? {
              lat: '52.36756',
              lon: '5.19034',
              display_name: 'Muziekwijk IJsbaan, Almere'
            }
          : undefined
      );
    }
  };
  const geocoder = new Geocoder({
    pdok,
    nominatim,
    stations: () => Promise.resolve(index),
    store: memoryDurableStore(),
    logger: silentLogger
  });
  return { geocoder, calls };
}

describe('pdok helpers', () => {
  it('reads WKT points, longitude first', () => {
    expect(parsePoint('POINT(4.90058 52.3789)')).toEqual({
      lat: 52.3789,
      lon: 4.90058
    });
    expect(parsePoint(undefined)).toBeUndefined();
  });

  it('builds MDS municipality codes', () => {
    expect(municipalityCode('0363')).toBe('GM0363');
    expect(municipalityCode('34')).toBe('GM0034');
    expect(municipalityCode('GM0034')).toBe('GM0034');
    expect(municipalityCode(undefined)).toBeUndefined();
  });

  it('notices when a hit is about something else', () => {
    expect(namesMatch('Damrak 1 Amsterdam', 'Damrak 1, 1012LG Amsterdam')).toBe(
      true
    );
    expect(namesMatch('station Almere Muziekwijk', 'Muziekwijk, Almere')).toBe(
      true
    );
    expect(namesMatch('Muziekwijk IJsbaan Almere', 'Ijsbaanpad, Almere')).toBe(
      false
    );
  });
});

describe('Geocoder', () => {
  it('places stations at NS coordinates', async () => {
    const { geocoder, calls } = setup();
    const place = await geocoder.locate({
      locatie: 'station Amsterdam Centraal'
    });
    expect(place).toMatchObject({
      source: 'ns',
      name: 'Amsterdam Centraal (station)',
      lat: 52.378887,
      municipality: 'GM0363'
    });
    expect(calls.search).toBe(0);
  });

  it('uses PDOK for addresses and keeps the answer', async () => {
    const { geocoder, calls } = setup();
    const first = await geocoder.locate({ locatie: 'Damrak 1 Amsterdam' });
    expect(first).toMatchObject({
      query: 'Damrak 1 Amsterdam',
      source: 'pdok',
      lat: 52.37601,
      lon: 4.89508,
      name: 'Damrak 1, 1012LG Amsterdam',
      address: 'Teststraat 1, Amsterdam',
      municipality: 'GM0363'
    });
    await geocoder.locate({ locatie: 'damrak 1  amsterdam' });
    expect(calls.search).toBe(1);
  });

  it('falls back to Nominatim when PDOK finds something else', async () => {
    const { geocoder, calls } = setup();
    const place = await geocoder.locate({
      locatie: 'Muziekwijk IJsbaan Almere'
    });
    expect(place).toMatchObject({
      source: 'nominatim',
      lat: 52.36756,
      municipality: 'GM0034'
    });
    expect(calls.nominatim).toBe(1);
  });

  it('reverse-geocodes plain coordinates', async () => {
    const { geocoder } = setup();
    expect(
      await geocoder.locate({ lat: 52.38272, lon: 4.90324 })
    ).toMatchObject({
      source: 'coordinates',
      street: 'Teststraat',
      municipality: 'GM0363'
    });
  });

  it('says what is missing without a place', async () => {
    const { geocoder } = setup();
    await expect(geocoder.locate({})).rejects.toThrow(/locatie/);
    await expect(geocoder.locate({ locatie: 'nergens 999' })).rejects.toThrow(
      /No location/
    );
  });
});
