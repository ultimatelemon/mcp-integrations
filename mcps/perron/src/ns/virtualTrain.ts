import type { NsClient } from './client.ts';
import type { NsPrognose, NsTrainInfo } from './types.ts';

// The spec also lists /api/v1/...; on the gateway only /v1/... answers (the other 404s).
const BASE = '/virtual-train-api/v1';

export function getTrainInfo(
  ns: NsClient,
  trainNumber: number,
  stationCode?: string,
  dateTime?: string
): Promise<NsTrainInfo> {
  const path = stationCode
    ? `${BASE}/trein/${String(trainNumber)}/${encodeURIComponent(stationCode)}`
    : `${BASE}/trein/${String(trainNumber)}`;
  return ns.get(path, { features: 'zitplaats,drukte', dateTime });
}

export function getPrognose(
  ns: NsClient,
  trainNumber: number
): Promise<NsPrognose> {
  return ns.get(`${BASE}/prognose/${String(trainNumber)}`);
}
