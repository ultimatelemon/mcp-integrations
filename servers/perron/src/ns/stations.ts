import type { NsClient } from './client.ts';
import type { NsStationV3 } from './types.ts';

export async function fetchStations(ns: NsClient): Promise<NsStationV3[]> {
  const body = await ns.get<{ payload?: NsStationV3[] }>('/nsapp-stations/v3');
  return body.payload ?? [];
}
