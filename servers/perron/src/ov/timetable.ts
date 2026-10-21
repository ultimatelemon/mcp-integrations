import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { normalize, scoreName } from '../resolve.ts';

export interface Line {
  routeId: string;
  name: string;
  longName: string | undefined;
  type: number;
}

/** One stop as a traveller names it; metro platforms and ferry piers with that name together. */
export interface StopGroup {
  name: string;
  stopIds: string[];
  routeIds: Set<string>;
}

export interface ScheduledDeparture {
  tripId: string;
  rtId: string | undefined;
  routeId: string;
  line: string;
  headsign: string | undefined;
  stopId: string;
  platform: string | undefined;
  seq: number;
  /** Seconds after the service day's start. */
  dep: number;
}

const WORDS = /\b(metro|pont|veer|ferry|lijn|line|gvb)\b/g;

/** "Amsterdam, Centraal Station" → "Centraal Station": GTFS NL prefixes the town. */
export function stopName(name: string): string {
  return name.replace(/^[^,]+,\s*/, '').trim();
}

export function lineKey(name: string): string {
  return normalize(name).replace(WORDS, ' ').replace(/\s+/g, '');
}

/** Read-only view of an imported GTFS database. */
export class Timetable {
  readonly lines: Line[];
  readonly importedAt: string | undefined;
  private readonly db: DatabaseSync;
  private readonly groups: StopGroup[];
  private readonly tripIds: Set<string>;
  private readonly byRtId: Map<string, string>;
  private readonly cache = new Map<string, StatementSync>();

  constructor(file: string) {
    this.db = new DatabaseSync(file, { readOnly: true });
    this.lines = (
      this.db
        .prepare('SELECT route_id, short_name, long_name, type FROM routes')
        .all() as {
        route_id: string;
        short_name: string;
        long_name: string | null;
        type: number;
      }[]
    ).map((r) => ({
      routeId: r.route_id,
      name: r.short_name,
      longName: r.long_name ?? undefined,
      type: r.type
    }));
    this.importedAt = (
      this.db
        .prepare("SELECT value FROM meta WHERE key = 'imported_at'")
        .get() as { value: string } | undefined
    )?.value;

    const served = this.db
      .prepare(
        `SELECT DISTINCT s.stop_id, s.name, t.route_id FROM stop_times st
         JOIN trips t ON t.trip_id = st.trip_id JOIN stops s ON s.stop_id = st.stop_id`
      )
      .all() as { stop_id: string; name: string; route_id: string }[];
    const groups = new Map<string, StopGroup>();
    for (const row of served) {
      const name = stopName(row.name);
      const key = normalize(name);
      const group = groups.get(key) ?? {
        name,
        stopIds: [],
        routeIds: new Set()
      };
      if (!group.stopIds.includes(row.stop_id)) group.stopIds.push(row.stop_id);
      group.routeIds.add(row.route_id);
      groups.set(key, group);
    }
    this.groups = [...groups.values()];

    const trips = this.db.prepare('SELECT trip_id, rt_id FROM trips').all() as {
      trip_id: string;
      rt_id: string | null;
    }[];
    this.tripIds = new Set(trips.map((t) => t.trip_id));
    this.byRtId = new Map(
      trips.flatMap((t) => (t.rt_id ? [[t.rt_id, t.trip_id] as const] : []))
    );
  }

  /** Static trip id for an id from the realtime feed, which may use either id. */
  tripFor(realtimeId: string): string | undefined {
    if (this.tripIds.has(realtimeId)) return realtimeId;
    return this.byRtId.get(realtimeId);
  }

  findLines(query: string): Line[] {
    const key = lineKey(query);
    return this.lines.filter((l) => lineKey(l.name) === key);
  }

  /** Stops ranked by how well their name fits, limited to the given lines. */
  findStops(
    query: string,
    routeIds?: Set<string>
  ): { group: StopGroup; score: number }[] {
    const q = normalize(query);
    return this.groups
      .filter((g) => !routeIds || [...g.routeIds].some((r) => routeIds.has(r)))
      .map((group) => ({
        group,
        score: scoreName(q, normalize(group.name), false)
      }))
      .filter((m) => m.score > 0)
      .sort(
        (a, b) => b.score - a.score || a.group.name.localeCompare(b.group.name)
      );
  }

  /** Planned departures at the stops on one service date, between two offsets in seconds. */
  departures(
    stopIds: string[],
    routeIds: string[],
    serviceDate: string,
    from: number,
    until: number,
    limit: number
  ): ScheduledDeparture[] {
    const sql = `SELECT st.trip_id, t.rt_id, t.route_id, r.short_name, t.headsign, st.stop_id,
        s.platform, st.seq, st.dep
      FROM stop_times st
      JOIN trips t ON t.trip_id = st.trip_id
      JOIN routes r ON r.route_id = t.route_id
      JOIN stops s ON s.stop_id = st.stop_id
      JOIN service_dates d ON d.service_id = t.service_id AND d.date = ?
      WHERE st.stop_id IN (${stopIds.map(() => '?').join(',')})
        AND t.route_id IN (${routeIds.map(() => '?').join(',')})
        AND st.last = 0 AND st.pickup != 1 AND st.dep BETWEEN ? AND ?
      ORDER BY st.dep LIMIT ?`;
    let statement = this.cache.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.cache.set(sql, statement);
    }
    const rows = statement.all(
      serviceDate,
      ...stopIds,
      ...routeIds,
      from,
      until,
      limit
    ) as {
      trip_id: string;
      rt_id: string | null;
      route_id: string;
      short_name: string;
      headsign: string | null;
      stop_id: string;
      platform: string | null;
      seq: number;
      dep: number;
    }[];
    return rows.map((r) => ({
      tripId: r.trip_id,
      rtId: r.rt_id ?? undefined,
      routeId: r.route_id,
      line: r.short_name,
      headsign: r.headsign ?? undefined,
      stopId: r.stop_id,
      platform: r.platform ?? undefined,
      seq: r.seq,
      dep: r.dep
    }));
  }

  close(): void {
    this.db.close();
  }
}
