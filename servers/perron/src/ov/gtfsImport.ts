import { rmSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import type { Logger } from '../lib/logger.ts';
import { columns, gtfsSeconds, parseCsvLine } from './csv.ts';

export interface ImportOptions {
  zipPath: string;
  dbPath: string;
  /** agency_id or agency_name, e.g. "GVB". */
  agency: string;
  /** route_short_names to keep; empty keeps every metro and ferry line of the agency. */
  lines: string[];
  logger: Logger;
}

export interface ImportStats {
  routes: string[];
  trips: number;
  stopTimes: number;
  stops: number;
  serviceDays: number;
}

const SCHEMA = `
CREATE TABLE routes (route_id TEXT PRIMARY KEY, short_name TEXT, long_name TEXT, type INTEGER);
CREATE TABLE trips (trip_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, service_id TEXT NOT NULL, headsign TEXT, rt_id TEXT);
CREATE TABLE stops (stop_id TEXT PRIMARY KEY, name TEXT, lat REAL, lon REAL, parent TEXT, platform TEXT);
CREATE TABLE stop_times (trip_id TEXT NOT NULL, seq INTEGER NOT NULL, stop_id TEXT NOT NULL, dep INTEGER NOT NULL, last INTEGER NOT NULL, pickup INTEGER NOT NULL);
CREATE TABLE service_dates (service_id TEXT NOT NULL, date TEXT NOT NULL, PRIMARY KEY (service_id, date));
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

const INDEXES = `
CREATE INDEX stop_times_stop ON stop_times (stop_id, dep);
CREATE INDEX stop_times_trip ON stop_times (trip_id, seq);
CREATE INDEX service_dates_date ON service_dates (date);
`;

/** Metro and ferry, in both the basic and the extended GTFS route types. */
export function isMetroOrFerry(type: number): boolean {
  return (
    type === 1 ||
    type === 4 ||
    (type >= 400 && type <= 404) ||
    (type >= 1000 && type <= 1299)
  );
}

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: false }, (error, zip) => {
      if (error) reject(error);
      else resolve(zip);
    });
  });
}

function listEntries(zip: ZipFile): Promise<Map<string, Entry>> {
  return new Promise((resolve, reject) => {
    const entries = new Map<string, Entry>();
    zip.on('entry', (entry: Entry) => {
      entries.set(entry.fileName.replace(/^.*\//, ''), entry);
      zip.readEntry();
    });
    zip.on('end', () => {
      resolve(entries);
    });
    zip.on('error', reject);
    zip.readEntry();
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(error);
      else resolve(stream);
    });
  });
}

/**
 * Calls `row` for each record of one file. `keep` sees the raw line first, so
 * the 100-million-line stop_times.txt is not split field by field.
 */
async function eachRow(
  zip: ZipFile,
  entries: Map<string, Entry>,
  file: string,
  row: (get: (column: string) => string | undefined) => void,
  keep?: (line: string, cols: Map<string, number>) => boolean
): Promise<boolean> {
  const entry = entries.get(file);
  if (!entry) return false;
  const lines = createInterface({
    input: await openEntry(zip, entry),
    crlfDelay: Infinity
  });
  let cols: Map<string, number> | undefined;
  for await (const line of lines) {
    if (!cols) {
      cols = columns(line);
      continue;
    }
    if (!line) continue;
    if (keep && !keep(line, cols)) continue;
    const fields = parseCsvLine(line);
    const current = cols;
    row((column) => {
      const i = current.get(column);
      return i === undefined ? undefined : fields[i]?.trim();
    });
  }
  return true;
}

function firstField(line: string): string {
  const comma = line.indexOf(',');
  const raw = comma === -1 ? line : line.slice(0, comma);
  return raw.startsWith('"') ? raw.slice(1, -1) : raw;
}

const ymd = (date: Date) => date.toISOString().slice(0, 10).replace(/-/g, '');

/** Reads only the agency's metro and ferry lines out of the national feed into a fresh SQLite file. */
export async function importGtfs(options: ImportOptions): Promise<ImportStats> {
  const zip = await openZip(options.zipPath);
  rmSync(options.dbPath, { force: true });
  const db = new DatabaseSync(options.dbPath);
  try {
    const entries = await listEntries(zip);
    db.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;');
    db.exec(SCHEMA);
    db.exec('BEGIN');

    const wantedAgency = options.agency.toLowerCase();
    const agencies = new Set<string>();
    await eachRow(zip, entries, 'agency.txt', (get) => {
      const id = get('agency_id') ?? '';
      if (
        id.toLowerCase() === wantedAgency ||
        get('agency_name')?.toLowerCase() === wantedAgency
      ) {
        agencies.add(id);
      }
    });

    const wantedLines = new Set(options.lines.map((l) => l.toUpperCase()));
    const routes = new Map<string, string>();
    const insertRoute = db.prepare('INSERT INTO routes VALUES (?, ?, ?, ?)');
    await eachRow(zip, entries, 'routes.txt', (get) => {
      const agency = get('agency_id') ?? '';
      const type = Number(get('route_type'));
      const short = get('route_short_name') ?? '';
      if (!agencies.has(agency) || !isMetroOrFerry(type)) return;
      if (wantedLines.size > 0 && !wantedLines.has(short.toUpperCase())) return;
      const id = get('route_id') ?? '';
      routes.set(id, short);
      insertRoute.run(id, short, get('route_long_name') ?? null, type);
    });
    if (routes.size === 0) {
      throw new Error(
        `No metro or ferry routes for agency "${options.agency}"${wantedLines.size ? ` and lines ${[...wantedLines].join(', ')}` : ''} in the feed`
      );
    }

    const trips = new Set<string>();
    const services = new Set<string>();
    const insertTrip = db.prepare('INSERT INTO trips VALUES (?, ?, ?, ?, ?)');
    await eachRow(zip, entries, 'trips.txt', (get) => {
      const route = get('route_id') ?? '';
      if (!routes.has(route)) return;
      const id = get('trip_id') ?? '';
      const service = get('service_id') ?? '';
      trips.add(id);
      services.add(service);
      insertTrip.run(
        id,
        route,
        service,
        get('trip_headsign') ?? null,
        get('realtime_trip_id') || null
      );
    });

    // Rows per trip, so the last stop (arrival only, no departure) can be marked.
    const byTrip = new Map<string, [number, string, number, number][]>();
    await eachRow(
      zip,
      entries,
      'stop_times.txt',
      (get) => {
        const trip = get('trip_id') ?? '';
        const dep =
          gtfsSeconds(get('departure_time')) ??
          gtfsSeconds(get('arrival_time'));
        if (dep === undefined) return;
        const rows = byTrip.get(trip) ?? [];
        rows.push([
          Number(get('stop_sequence')),
          get('stop_id') ?? '',
          dep,
          Number(get('pickup_type') || 0)
        ]);
        byTrip.set(trip, rows);
      },
      (line, cols) =>
        cols.get('trip_id') === 0
          ? trips.has(firstField(line))
          : trips.has(parseCsvLine(line)[cols.get('trip_id') ?? 0] ?? '')
    );
    const usedStops = new Set<string>();
    const insertStopTime = db.prepare(
      'INSERT INTO stop_times VALUES (?, ?, ?, ?, ?, ?)'
    );
    let stopTimes = 0;
    for (const [trip, rows] of byTrip) {
      rows.sort((a, b) => a[0] - b[0]);
      rows.forEach(([seq, stop, dep, pickup], i) => {
        usedStops.add(stop);
        insertStopTime.run(
          trip,
          seq,
          stop,
          dep,
          i === rows.length - 1 ? 1 : 0,
          pickup
        );
        stopTimes++;
      });
    }

    const allStops = new Map<
      string,
      {
        name: string;
        lat: number;
        lon: number;
        parent: string;
        platform: string;
      }
    >();
    await eachRow(zip, entries, 'stops.txt', (get) => {
      allStops.set(get('stop_id') ?? '', {
        name: get('stop_name') ?? '',
        lat: Number(get('stop_lat')),
        lon: Number(get('stop_lon')),
        parent: get('parent_station') ?? '',
        platform: get('platform_code') ?? ''
      });
    });
    const insertStop = db.prepare(
      'INSERT OR IGNORE INTO stops VALUES (?, ?, ?, ?, ?, ?)'
    );
    for (const id of usedStops) {
      const stop = allStops.get(id);
      if (!stop) continue;
      insertStop.run(
        id,
        stop.name,
        stop.lat,
        stop.lon,
        stop.parent || null,
        stop.platform || null
      );
    }

    // calendar.txt gives weekly patterns; calendar_dates.txt adds (1) or removes (2) single days.
    const days = new Map<string, Set<string>>();
    const dayNames = [
      'sunday',
      'monday',
      'tuesday',
      'wednesday',
      'thursday',
      'friday',
      'saturday'
    ];
    await eachRow(zip, entries, 'calendar.txt', (get) => {
      const service = get('service_id') ?? '';
      const start = get('start_date');
      const end = get('end_date');
      if (!services.has(service) || !start || !end) return;
      const set = days.get(service) ?? new Set<string>();
      const day = new Date(
        `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T12:00:00Z`
      );
      for (; ymd(day) <= end; day.setUTCDate(day.getUTCDate() + 1)) {
        if (get(dayNames[day.getUTCDay()]!) === '1') set.add(ymd(day));
      }
      days.set(service, set);
    });
    await eachRow(zip, entries, 'calendar_dates.txt', (get) => {
      const service = get('service_id') ?? '';
      const date = get('date') ?? '';
      if (!services.has(service)) return;
      const set = days.get(service) ?? new Set<string>();
      if (get('exception_type') === '2') set.delete(date);
      else set.add(date);
      days.set(service, set);
    });
    const insertDay = db.prepare(
      'INSERT OR IGNORE INTO service_dates VALUES (?, ?)'
    );
    let serviceDays = 0;
    for (const [service, set] of days) {
      for (const date of set) {
        insertDay.run(service, date);
        serviceDays++;
      }
    }

    db.exec(INDEXES);
    db.prepare('INSERT INTO meta VALUES (?, ?)').run(
      'imported_at',
      new Date().toISOString()
    );
    db.exec('COMMIT');

    const stats: ImportStats = {
      routes: [...new Set(routes.values())].sort(),
      trips: trips.size,
      stopTimes,
      stops: usedStops.size,
      serviceDays
    };
    options.logger.info(stats, 'gtfs imported');
    return stats;
  } finally {
    db.close();
    zip.close();
  }
}
