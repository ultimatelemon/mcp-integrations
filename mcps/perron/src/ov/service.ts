import {
  createWriteStream,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  mkdirSync
} from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream } from 'node:stream/web';
import { NotFound } from '../errors.ts';
import { amsterdamDay, parseTime } from '../format/time.ts';
import { fetchBinary } from '../lib/http.ts';
import type { Logger } from '../lib/logger.ts';
import { importGtfs } from './gtfsImport.ts';
import {
  decodeTripUpdates,
  delayAt,
  fetchTripUpdates,
  type RealtimeIndex
} from './realtime.ts';
import { Timetable, type Line, type StopGroup } from './timetable.ts';

export const GTFS_URL = 'https://gtfs.ovapi.nl/nl/gtfs-nl.zip';
export const GTFS_RT_URL = 'https://gtfs.ovapi.nl/nl/tripUpdates.pb';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** After a failed refresh, wait this long before downloading 230 MB again. */
const RETRY_AFTER = 3 * HOUR;
const REALTIME_TTL = 30_000;

export interface OvOptions {
  dataDir: string;
  gtfsUrl?: string;
  realtimeUrl?: string;
  agency: string;
  lines: string[];
  logger: Logger;
  fetch?: typeof fetch;
  now?: () => Date;
}

interface FeedState {
  etag?: string;
  lastModified?: string;
  checkedAt?: string;
  failedAt?: string;
}

export interface Departure {
  line: string;
  direction: string | undefined;
  platform: string | undefined;
  planned: Date;
  expected: Date;
  delayMinutes: number | undefined;
  realtime: boolean;
  cancelled: boolean;
}

export interface DepartureBoard {
  stop: string;
  alternatives: string[];
  lines: string[];
  departures: Departure[];
  timetableDate: string | undefined;
  realtimeAvailable: boolean;
}

/** Wall-clock start of a GTFS service day: noon minus twelve hours, which differs from midnight on DST days. */
export function serviceDayStart(ymd: string): Date {
  const noon = parseTime(
    `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T12:00`
  );
  if (!noon) throw new Error(`Bad service date ${ymd}`);
  return new Date(noon.getTime() - 12 * HOUR);
}

function ymdOf(date: Date): string {
  return amsterdamDay(date).replace(/-/g, '');
}

/**
 * The GVB metro and ferry timetable, rebuilt once a day from the national GTFS
 * feed into SQLite, plus GTFS-Realtime delays on top.
 */
export class OvService {
  private readonly options: OvOptions;
  private readonly dbPath: string;
  private readonly statePath: string;
  private readonly now: () => Date;
  private current: Timetable | undefined;
  private refreshing: Promise<void> | undefined;
  private rt: { index: RealtimeIndex; expires: number } | undefined;
  private rtPending: Promise<RealtimeIndex | undefined> | undefined;

  constructor(options: OvOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    mkdirSync(options.dataDir, { recursive: true });
    this.dbPath = join(options.dataDir, 'gtfs.sqlite');
    this.statePath = join(options.dataDir, 'gtfs.json');
    if (existsSync(this.dbPath)) {
      try {
        this.current = new Timetable(this.dbPath);
      } catch (error) {
        options.logger.warn(
          { err: String(error) },
          'gtfs database unreadable, rebuilding'
        );
      }
    }
  }

  get timetable(): Timetable | undefined {
    return this.current;
  }

  /** Downloads and imports when the last check is a day old; never runs twice at once. */
  ensureFresh(): Promise<void> {
    const state = this.state();
    const now = this.now().getTime();
    const checked = state.checkedAt ? Date.parse(state.checkedAt) : 0;
    const failed = state.failedAt ? Date.parse(state.failedAt) : 0;
    if (this.current && now - checked < DAY) return Promise.resolve();
    if (now - failed < RETRY_AFTER) return Promise.resolve();
    this.refreshing ??= this.refresh(state)
      .catch((error: unknown) => {
        this.options.logger.error(
          { err: String(error) },
          'gtfs refresh failed'
        );
        this.saveState({ ...state, failedAt: this.now().toISOString() });
      })
      .finally(() => {
        this.refreshing = undefined;
      });
    return this.refreshing;
  }

  /** Checks hourly whether a day has passed; returns a stop function. */
  start(): () => void {
    void this.ensureFresh();
    const timer = setInterval(() => void this.ensureFresh(), HOUR);
    timer.unref();
    return () => {
      clearInterval(timer);
      this.current?.close();
    };
  }

  private state(): FeedState {
    try {
      return JSON.parse(readFileSync(this.statePath, 'utf8')) as FeedState;
    } catch {
      return {};
    }
  }

  private async refresh(state: FeedState): Promise<void> {
    const { logger } = this.options;
    const headers: Record<string, string> = {};
    // Only skip the download when the database it belongs to is still there.
    if (this.current && state.etag) headers['If-None-Match'] = state.etag;
    if (this.current && state.lastModified)
      headers['If-Modified-Since'] = state.lastModified;
    logger.info({}, 'gtfs download started');
    const response = await fetchBinary(
      this.options.gtfsUrl ?? GTFS_URL,
      'OVapi GTFS',
      {
        timeoutMs: 15 * 60_000,
        headers,
        ...(this.options.fetch ? { fetch: this.options.fetch } : {})
      }
    );
    const checkedAt = this.now().toISOString();
    if (response.status === 304) {
      this.saveState({ ...state, checkedAt });
      logger.info({}, 'gtfs unchanged');
      return;
    }

    const zipPath = join(this.options.dataDir, 'gtfs-nl.zip.part');
    const tmpDb = `${this.dbPath}.tmp`;
    try {
      if (!response.body) throw new Error('GTFS download has no body');
      await pipeline(
        Readable.fromWeb(response.body as ReadableStream<Uint8Array>),
        createWriteStream(zipPath)
      );
      await importGtfs({
        zipPath,
        dbPath: tmpDb,
        agency: this.options.agency,
        lines: this.options.lines,
        logger
      });
      // The old handle keeps reading its own file until the new one is open.
      renameSync(tmpDb, this.dbPath);
      const previous = this.current;
      this.current = new Timetable(this.dbPath);
      previous?.close();
      this.rt = undefined;
      this.saveState({
        ...(response.headers.get('etag')
          ? { etag: response.headers.get('etag')! }
          : {}),
        ...(response.headers.get('last-modified')
          ? { lastModified: response.headers.get('last-modified')! }
          : {}),
        checkedAt
      });
    } finally {
      rmSync(zipPath, { force: true });
      rmSync(tmpDb, { force: true });
    }
  }

  private saveState(state: FeedState) {
    writeFileSync(this.statePath, JSON.stringify(state));
  }

  /** Realtime for the known trips, cached 30 s; undefined when the feed is down and nothing is cached. */
  private realtime(timetable: Timetable): Promise<RealtimeIndex | undefined> {
    const now = this.now().getTime();
    if (this.rt && now < this.rt.expires) return Promise.resolve(this.rt.index);
    const stale = this.rt?.index;
    this.rtPending ??= fetchTripUpdates(
      this.options.realtimeUrl ?? GTFS_RT_URL,
      this.options.fetch
    )
      .then((buffer) => {
        const raw = decodeTripUpdates(
          buffer,
          (id) => timetable.tripFor(id) !== undefined
        );
        const index: RealtimeIndex = new Map();
        for (const [id, trip] of raw)
          index.set(timetable.tripFor(id) ?? id, trip);
        this.rt = { index, expires: this.now().getTime() + REALTIME_TTL };
        return index;
      })
      .catch((error: unknown) => {
        this.options.logger.warn(
          { err: String(error) },
          'gtfs-realtime unavailable'
        );
        return stale;
      })
      .finally(() => {
        this.rtPending = undefined;
      });
    return this.rtPending;
  }

  private ready(): Timetable {
    if (this.current) return this.current;
    void this.ensureFresh();
    throw new NotFound(
      'The GVB timetable is still being loaded (a 230 MB download once a day). Try again in a few minutes.'
    );
  }

  async departures(input: {
    halte: string;
    lijn?: string | undefined;
    richting?: string | undefined;
    after: Date;
    count: number;
  }): Promise<DepartureBoard> {
    const timetable = this.ready();

    let lines: Line[] = timetable.lines;
    if (input.lijn) {
      lines = timetable.findLines(input.lijn);
      if (lines.length === 0) {
        const known = [...new Set(timetable.lines.map((l) => l.name))].sort();
        throw new NotFound(
          `No line "${input.lijn}". Lines: ${known.join(', ')}.`
        );
      }
    }
    const routeIds = new Set(lines.map((l) => l.routeId));
    const matches = timetable.findStops(input.halte, routeIds);
    const best = matches[0];
    if (!best) {
      throw new NotFound(
        `No stop matches "${input.halte}"${input.lijn ? ` on line ${input.lijn}` : ''}.`
      );
    }
    const group: StopGroup = best.group;
    const served = [...group.routeIds].filter((r) => routeIds.has(r));

    const after = input.after.getTime();
    const today = ymdOf(input.after);
    const days = [-1, 0, 1].map((offset) =>
      ymdOf(
        new Date(serviceDayStart(today).getTime() + offset * DAY + 12 * HOUR)
      )
    );
    const wanted = input.count * 6;
    const scheduled = days.flatMap((day) => {
      const start = serviceDayStart(day).getTime();
      const from = Math.max(0, Math.floor((after - start) / 1000));
      return timetable
        .departures(group.stopIds, served, day, from, from + 6 * 3600, wanted)
        .map((d) => ({ ...d, day, planned: new Date(start + d.dep * 1000) }));
    });

    const direction = input.richting ? input.richting.toLowerCase() : undefined;
    const filtered = scheduled
      .filter((d) => d.planned.getTime() >= after - 60_000)
      .filter(
        (d) =>
          !direction || (d.headsign ?? '').toLowerCase().includes(direction)
      )
      .sort((a, b) => a.planned.getTime() - b.planned.getTime())
      .slice(0, input.count);

    const rt = filtered.length > 0 ? await this.realtime(timetable) : undefined;
    const departures = filtered.map((d): Departure => {
      const trip = rt?.get(d.tripId);
      const live =
        trip && (!trip.startDate || trip.startDate === d.day)
          ? trip
          : undefined;
      const at = live
        ? delayAt(live, d.seq, d.stopId, Math.round(d.planned.getTime() / 1000))
        : undefined;
      const delay = at?.delay ?? 0;
      return {
        line: d.line,
        direction: d.headsign,
        platform: d.platform,
        planned: d.planned,
        expected: new Date(d.planned.getTime() + delay * 1000),
        delayMinutes: live ? Math.round(delay / 60) : undefined,
        realtime: live !== undefined,
        cancelled: (live?.cancelled ?? false) || (at?.skipped ?? false)
      };
    });

    return {
      stop: group.name,
      alternatives: matches
        .slice(1, 4)
        .filter((m) => m.score >= best.score - 150)
        .map((m) => m.group.name),
      lines: [
        ...new Set(
          lines.filter((l) => served.includes(l.routeId)).map((l) => l.name)
        )
      ],
      departures,
      timetableDate: timetable.importedAt,
      realtimeAvailable: rt !== undefined
    };
  }
}
