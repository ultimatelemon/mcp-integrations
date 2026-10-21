import type { NsClient } from './client.ts';
import type { NsDisruption } from './types.ts';

export type DisruptionType = 'disruption' | 'maintenance' | 'calamity';

export function listDisruptions(
  ns: NsClient,
  options: { activeOnly: boolean; type?: DisruptionType | undefined }
): Promise<NsDisruption[]> {
  return ns.get('/disruptions/v3', {
    isActive: options.activeOnly ? true : undefined,
    type: options.type
  });
}

export function stationDisruptions(
  ns: NsClient,
  stationCode: string
): Promise<NsDisruption[]> {
  return ns.get(`/disruptions/v3/station/${encodeURIComponent(stationCode)}`);
}

export function getDisruption(
  ns: NsClient,
  type: DisruptionType,
  id: string
): Promise<NsDisruption> {
  return ns.get(`/disruptions/v3/${type}/${encodeURIComponent(id)}`);
}
