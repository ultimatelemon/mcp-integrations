import type { NsClient } from './client.ts';
import type { NsLift, NsPlaceGroup, NsPlacesResponse } from './types.ts';

const BASE = '/places-api';

export async function getStationPlaces(
  ns: NsClient,
  stationCode: string
): Promise<NsPlaceGroup[]> {
  const body = await ns.get<NsPlacesResponse>(`${BASE}/v2/places`, {
    station_code: stationCode,
    type: ['stationfacility', 'station-retail'],
    details: true,
    lang: 'en'
  });
  return body.payload ?? [];
}

export async function getOvFiets(
  ns: NsClient,
  stationCode: string
): Promise<NsPlaceGroup[]> {
  const body = await ns.get<NsPlacesResponse>(`${BASE}/v2/ovfiets`, {
    station_code: stationCode
  });
  return body.payload ?? [];
}

export function getLifts(ns: NsClient, stationCode: string): Promise<NsLift[]> {
  return ns.get(`${BASE}/v1/stationfacility/lifts`, { stationCode });
}
