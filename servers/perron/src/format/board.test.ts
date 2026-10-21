import { describe, expect, it } from 'vitest';
import { FIXTURE_NOW, fixture } from '../../test/helpers.ts';
import type { NsBoardEntry } from '../ns/types.ts';
import { formatBoardEntry, summarizeBoard } from './board.ts';

const departures = fixture<{ payload: { departures: NsBoardEntry[] } }>(
  'departures'
).payload.departures;
const arrivals = fixture<{ payload: { arrivals: NsBoardEntry[] } }>('arrivals')
  .payload.arrivals;

describe('formatBoardEntry', () => {
  it('maps a delayed international departure', () => {
    const entry = formatBoardEntry(departures[0]!, 'departures', FIXTURE_NOW);
    expect(entry).toMatchObject({
      time: '09:02',
      actualTime: '09:29',
      delayMin: 27,
      direction: 'Amsterdam Centraal',
      type: 'ICE',
      train: '222',
      operator: 'NS Int',
      track: '14'
    });
    expect(entry).not.toHaveProperty('trackChanged');
  });

  it('marks track changes and keeps notices', () => {
    const entry = formatBoardEntry(departures[1]!, 'departures', FIXTURE_NOW);
    expect(entry.trackChanged).toBe(true);
    expect(entry.plannedTrack).toBeDefined();
    expect(entry.messages?.length).toBeGreaterThan(0);
  });

  it('uses origin for arrivals', () => {
    const entry = formatBoardEntry(arrivals[0]!, 'arrivals', FIXTURE_NOW);
    expect(entry).toMatchObject({ origin: 'Frankfurt (M) Hbf' });
    expect(entry).not.toHaveProperty('direction');
  });

  it('flags cancellations', () => {
    const entry = formatBoardEntry(
      { ...departures[2]!, cancelled: true },
      'departures',
      FIXTURE_NOW
    );
    expect(entry.cancelled).toBe(true);
    expect(summarizeBoard('departures', 'Utrecht', [entry])).toContain(
      'CANCELLED'
    );
  });
});
