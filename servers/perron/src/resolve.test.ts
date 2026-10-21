import { describe, expect, it } from 'vitest';
import { fixture } from '../test/helpers.ts';
import { AmbiguousStation, StationNotFound } from './errors.ts';
import type { NsStationV3 } from './ns/types.ts';
import { editDistance, normalize, StationIndex } from './resolve.ts';

const index = new StationIndex(
  fixture<{ payload: NsStationV3[] }>('stations').payload
);

describe('normalize', () => {
  it('drops case, accents and punctuation', () => {
    expect(normalize("'s-Hertogenbosch")).toBe('s hertogenbosch');
    expect(normalize('Köln Hbf')).toBe('koln hbf');
  });
});

describe('editDistance', () => {
  it('counts a transposition as one edit', () => {
    expect(editDistance('utrecht', 'urtecht')).toBe(1);
    expect(editDistance('abc', 'abc')).toBe(0);
    expect(editDistance('kitten', 'sitting')).toBe(3);
  });
});

describe('StationIndex.resolve', () => {
  it.each([
    ['UT', 'UT'],
    ['ut', 'UT'],
    ['8400621', 'UT'],
    ['Utrecht', 'UT'],
    ['utrect', 'UT'],
    ['Utrecht Centrall', 'UT'],
    ['Amsterdam', 'ASD'],
    ['amsterdam zuid', 'ASDZ'],
    ['Den Haag', 'GVC'],
    ['Hollands Spoor', 'GV'],
    ['den bosch', 'HT'],
    ["'s-Hertogenbosch", 'HT'],
    ['Schiphol', 'SHL'],
    ['Koln', 'KOLN'],
    ['Köln', 'KOLN'],
    ['Ede-Wageningen', 'ED']
  ])('%s → %s', (query, code) => {
    expect(index.resolve(query).code).toBe(code);
  });

  it('lists the close candidates when a name is ambiguous', () => {
    try {
      index.resolve('Ede');
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(AmbiguousStation);
      const codes = (error as AmbiguousStation).candidates.map((c) => c.code);
      expect(codes).toEqual(expect.arrayContaining(['ED', 'EDC']));
      expect(codes).not.toContain('ES');
    }
  });

  it('throws StationNotFound for nonsense', () => {
    expect(() => index.resolve('xyzzy')).toThrow(StationNotFound);
  });
});

describe('StationIndex.search', () => {
  it('ranks by match quality and returns several', () => {
    const results = index.search('brussel', 5).map((m) => m.station.code);
    expect(results.slice(0, 3)).toEqual(
      expect.arrayContaining(['BRUSZ', 'BRUSN', 'BRUSC'])
    );
  });
});
