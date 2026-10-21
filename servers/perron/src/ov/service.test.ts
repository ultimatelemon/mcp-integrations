import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gvbFeed, gvbRealtime, zipOf } from '../../test/gtfs.ts';
import { FIXTURE_NOW } from '../../test/helpers.ts';
import { formatTime } from '../format/time.ts';
import { silentLogger } from '../lib/logger.ts';
import { columns, gtfsSeconds, parseCsvLine } from './csv.ts';
import { OvService, serviceDayStart } from './service.ts';
import { lineKey, stopName } from './timetable.ts';

describe('csv helpers', () => {
  it('splits quoted fields with commas and escaped quotes', () => {
    expect(parseCsvLine('a,"b, c","d ""e"""')).toEqual(['a', 'b, c', 'd "e"']);
    expect(columns('﻿trip_id,stop_id').get('trip_id')).toBe(0);
  });

  it('reads GTFS times past midnight', () => {
    expect(gtfsSeconds('25:05:00')).toBe(25 * 3600 + 300);
    expect(gtfsSeconds('')).toBeUndefined();
  });

  it('names lines and stops the way travellers do', () => {
    expect(lineKey('Metro 52')).toBe('52');
    expect(lineKey('pont F3')).toBe('f3');
    expect(stopName('Amsterdam, Centraal Station')).toBe('Centraal Station');
  });

  it('starts a service day at noon minus twelve hours', () => {
    expect(serviceDayStart('20261006').toISOString()).toBe(
      '2026-10-05T22:00:00.000Z'
    );
  });
});

describe('OvService', () => {
  const dir = mkdtempSync(join(tmpdir(), 'perron-ov-'));
  const requests: string[] = [];
  let feed: Buffer;
  let ov: OvService;

  const fakeFetch = ((input: URL | string, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith('.zip')) {
      if (new Headers(init?.headers).get('if-none-match') === '"v1"') {
        return Promise.resolve(new Response(null, { status: 304 }));
      }
      return Promise.resolve(
        new Response(new Uint8Array(feed), {
          status: 200,
          headers: { etag: '"v1"' }
        })
      );
    }
    return Promise.resolve(
      new Response(new Uint8Array(gvbRealtime()), { status: 200 })
    );
  }) as typeof fetch;

  let clock = FIXTURE_NOW.getTime();
  const at = (hhmm: string) => new Date(`2026-10-06T${hhmm}:00+02:00`);
  const time = (d: Date) => formatTime(d.toISOString(), FIXTURE_NOW);

  beforeAll(async () => {
    feed = await zipOf(gvbFeed());
    ov = new OvService({
      dataDir: dir,
      gtfsUrl: 'https://gtfs.test/gtfs-nl.zip',
      realtimeUrl: 'https://gtfs.test/tripUpdates.pb',
      agency: 'GVB',
      lines: [],
      logger: silentLogger,
      fetch: fakeFetch,
      now: () => new Date(clock)
    });
  });

  afterAll(() => {
    ov.timetable?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('asks to wait while the timetable is not loaded yet, and backs off after a failure', async () => {
    let attempts = 0;
    const fresh = new OvService({
      dataDir: join(dir, 'empty'),
      agency: 'GVB',
      lines: [],
      logger: silentLogger,
      fetch: () => {
        attempts++;
        return Promise.reject(new Error('offline'));
      }
    });
    await expect(
      fresh.departures({ halte: 'Noord', after: FIXTURE_NOW, count: 3 })
    ).rejects.toThrow(/still being loaded/);
    await fresh.ensureFresh();
    await fresh.ensureFresh();
    expect(attempts).toBe(1);
  });

  it('imports only the GVB metro and ferry lines', async () => {
    await ov.ensureFresh();
    expect(ov.timetable?.lines.map((l) => l.name).sort()).toEqual(['52', 'F3']);
  });

  it('does not download again within a day, and sends the etag after that', async () => {
    const before = requests.length;
    await ov.ensureFresh();
    expect(requests.length).toBe(before);
    clock += 25 * 3_600_000;
    await ov.ensureFresh();
    expect(requests.length).toBe(before + 1);
    expect(ov.timetable?.lines.length).toBe(2);
    clock = FIXTURE_NOW.getTime();
  });

  it('combines planned metro departures with realtime delays and cancellations', async () => {
    const board = await ov.departures({
      halte: 'centraal station',
      lijn: 'metro 52',
      richting: 'Station Zuid',
      after: at('09:00'),
      count: 3
    });
    expect(board.stop).toBe('Centraal Station');
    expect(
      board.departures.map((d) => [
        time(d.planned),
        time(d.expected),
        d.delayMinutes,
        d.realtime,
        d.cancelled
      ])
    ).toEqual([
      ['09:08', '09:08', undefined, false, false],
      ['09:18', '09:20', 2, true, false],
      ['09:28', '09:28', 0, true, true]
    ]);
    expect(board.departures[0]?.platform).toBe('3');
  });

  it('gives ferries their planned times, marked as not realtime', async () => {
    const board = await ov.departures({
      halte: 'Centraal Station',
      lijn: 'F3',
      after: at('09:01'),
      count: 2
    });
    expect(board.lines).toEqual(['F3']);
    expect(
      board.departures.map((d) => [d.direction, time(d.planned), d.realtime])
    ).toEqual([
      ['Buiksloterweg', '09:06', false],
      ['Buiksloterweg', '09:12', false]
    ]);
  });

  it('prefers the exact stop name and skips trips that end there', async () => {
    const board = await ov.departures({
      halte: 'Noord',
      after: at('09:00'),
      count: 2
    });
    expect(board.stop).toBe('Noord');
    expect(board.alternatives).toEqual([]);
    expect(board.departures.every((d) => d.direction === 'Station Zuid')).toBe(
      true
    );
  });

  it('matches a partial or misspelt stop name', async () => {
    const board = await ov.departures({
      halte: 'buikslotrweg',
      after: at('09:00'),
      count: 1
    });
    expect(board.stop).toBe('Buiksloterweg');
  });

  it('finds trips after midnight on the previous service day', async () => {
    const board = await ov.departures({
      halte: 'Centraal Station',
      lijn: '52',
      after: new Date('2026-10-07T00:30:00+02:00'),
      count: 1
    });
    expect(board.departures[0]?.planned.toISOString()).toBe(
      '2026-10-06T23:05:00.000Z'
    );
  });

  it('names the known lines when the asked one is missing', async () => {
    await expect(
      ov.departures({
        halte: 'Centraal Station',
        lijn: '26',
        after: at('09:00'),
        count: 1
      })
    ).rejects.toThrow('Lines: 52, F3');
  });
});
