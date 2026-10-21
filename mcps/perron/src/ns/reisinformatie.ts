import type { NsClient } from './client.ts';
import type {
  NsBoardEntry,
  NsJourney,
  NsPriceV2,
  NsTrip,
  NsTripsResponse
} from './types.ts';

const BASE = '/reisinformatie-api/api';

export interface TripQuery {
  fromUic: string;
  toUic: string;
  viaUic?: string | undefined;
  dateTime?: string | undefined;
  searchForArrival?: boolean | undefined;
  travelClass?: 1 | 2 | undefined;
  localTrainsOnly?: boolean | undefined;
  excludeHighSpeedTrains?: boolean | undefined;
}

export function getTrips(ns: NsClient, q: TripQuery): Promise<NsTripsResponse> {
  return ns.get(`${BASE}/v3/trips`, {
    originUicCode: q.fromUic,
    destinationUicCode: q.toUic,
    viaUicCode: q.viaUic,
    dateTime: q.dateTime,
    searchForArrival: q.searchForArrival || undefined,
    travelClass: q.travelClass,
    localTrainsOnly: q.localTrainsOnly || undefined,
    excludeHighSpeedTrains: q.excludeHighSpeedTrains || undefined,
    lang: 'en'
  });
}

export function getTrip(ns: NsClient, ctxRecon: string): Promise<NsTrip> {
  return ns.get(`${BASE}/v3/trips/trip`, { ctxRecon, lang: 'en' });
}

export interface PriceQuery {
  fromCode: string;
  toCode: string;
  travelClass?: 1 | 2 | undefined;
  returnTrip?: boolean | undefined;
  adults?: number | undefined;
  children?: number | undefined;
  jointJourney?: boolean | undefined;
  routeId?: string | undefined;
}

/*
 * v2 rather than v3: on our product /api/v3/price answers every request with a
 * 500 (checked 2026-10-06), while v2 returns the same domestic fares.
 */
export async function getPrice(
  ns: NsClient,
  q: PriceQuery
): Promise<NsPriceV2> {
  const body = await ns.get<{ payload?: NsPriceV2 }>(`${BASE}/v2/price`, {
    fromStation: q.fromCode,
    toStation: q.toCode,
    travelClass: q.travelClass,
    travelType: q.returnTrip ? 'return' : 'single',
    adults: q.adults,
    children: q.children,
    isJointJourney: q.jointJourney || undefined,
    routeId: q.routeId
  });
  return body.payload ?? {};
}

export type BoardKind = 'departures' | 'arrivals';

/*
 * The one place that knows where boards come from. NS marks /api/v2/departures
 * and /arrivals deprecated in favour of timetable-api, which is not in the Ns-App
 * product; switching later only touches this function.
 */
export async function getStationBoard(
  ns: NsClient,
  kind: BoardKind,
  stationCode: string,
  limit: number
): Promise<NsBoardEntry[]> {
  const body = await ns.get<{
    payload?: { departures?: NsBoardEntry[]; arrivals?: NsBoardEntry[] };
  }>(`${BASE}/v2/${kind}`, {
    station: stationCode,
    maxJourneys: limit,
    lang: 'en'
  });
  return body.payload?.[kind] ?? [];
}

export async function getJourney(
  ns: NsClient,
  train: number,
  dateTime?: string
): Promise<NsJourney> {
  const body = await ns.get<{ payload?: NsJourney }>(`${BASE}/v2/journey`, {
    train,
    dateTime
  });
  return body.payload ?? {};
}
