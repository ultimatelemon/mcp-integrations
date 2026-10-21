import GtfsRealtimeBindings from 'gtfs-realtime-bindings';
import { fetchBinary } from '../lib/http.ts';

const { transit_realtime: rt } = GtfsRealtimeBindings;

export const SERVICE = 'OVapi GTFS-Realtime';

export interface StopUpdate {
  seq?: number;
  stopId?: string;
  /** Seconds late (negative: early). */
  delay?: number;
  /** Absolute departure or arrival, epoch seconds. */
  time?: number;
  skipped: boolean;
}

export interface TripRealtime {
  cancelled: boolean;
  startDate?: string;
  updates: StopUpdate[];
}

/** Realtime keyed by trip id, kept only for the trips the timetable knows. */
export type RealtimeIndex = Map<string, TripRealtime>;

function num(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

export function decodeTripUpdates(
  buffer: Uint8Array,
  known: (tripId: string) => boolean
): RealtimeIndex {
  const feed = rt.FeedMessage.decode(buffer);
  const index: RealtimeIndex = new Map();
  for (const entity of feed.entity) {
    const update = entity.tripUpdate;
    const tripId = update?.trip.tripId;
    if (!update || !tripId || !known(tripId)) continue;
    const relationship = update.trip.scheduleRelationship;
    index.set(tripId, {
      cancelled:
        relationship === rt.TripDescriptor.ScheduleRelationship.CANCELED,
      ...(update.trip.startDate ? { startDate: update.trip.startDate } : {}),
      updates: (update.stopTimeUpdate ?? []).map((u) => {
        const event = u.departure ?? u.arrival;
        const seq = num(u.stopSequence);
        const delay = num(event?.delay);
        const time = num(event?.time);
        return {
          ...(seq !== undefined ? { seq } : {}),
          ...(u.stopId ? { stopId: u.stopId } : {}),
          ...(delay !== undefined ? { delay } : {}),
          ...(time ? { time } : {}),
          skipped:
            u.scheduleRelationship ===
            rt.TripUpdate.StopTimeUpdate.ScheduleRelationship.SKIPPED
        };
      })
    });
  }
  return index;
}

/** Seconds of delay at one stop: its own update, else the nearest one before it (GTFS-RT propagation). */
export function delayAt(
  trip: TripRealtime,
  seq: number,
  stopId: string,
  scheduled: number
): { delay: number; skipped: boolean } | undefined {
  let best: StopUpdate | undefined;
  for (const u of trip.updates) {
    if (u.seq === seq || (u.seq === undefined && u.stopId === stopId)) {
      best = u;
      break;
    }
    if (
      u.seq !== undefined &&
      u.seq < seq &&
      (!best || (best.seq ?? -1) < u.seq)
    ) {
      best = u;
    }
  }
  if (!best) return undefined;
  const own =
    best.seq === seq || (best.seq === undefined && best.stopId === stopId);
  const delay =
    own && best.time !== undefined ? best.time - scheduled : (best.delay ?? 0);
  return { delay, skipped: own && best.skipped };
}

export async function fetchTripUpdates(
  url: string,
  fetchImpl?: typeof fetch
): Promise<Uint8Array> {
  const response = await fetchBinary(url, SERVICE, {
    timeoutMs: 20_000,
    ...(fetchImpl ? { fetch: fetchImpl } : {})
  });
  return new Uint8Array(await response.arrayBuffer());
}
