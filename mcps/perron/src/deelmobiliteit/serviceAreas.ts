import type { FeatureCollection, MultiPolygon, Polygon } from 'geojson';
import { createJsonClient } from '../lib/json.ts';
import type { Logger } from '../lib/logger.ts';
import { SERVICE } from './client.ts';

export const MDS_PUBLIC = 'https://mds.dashboarddeelmobiliteit.nl/public';

/** One operator's service area in one municipality: where a rental may be ended. */
export interface ServiceArea {
  service_area_version_id?: number;
  municipality: string;
  operator: string;
  valid_from?: string;
  valid_until?: string | null;
  geometries: FeatureCollection<Polygon | MultiPolygon>;
}

export interface ServiceAreaOptions {
  logger?: Logger;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function createServiceAreaClient(
  options: ServiceAreaOptions = {}
): (municipality: string, operator: string) => Promise<ServiceArea[]> {
  const get = createJsonClient(SERVICE, {
    baseUrl: options.baseUrl ?? MDS_PUBLIC,
    rateLimit: { limit: 30, windowMs: 60_000, burst: 5, maxWaitMs: 8000 },
    timeoutMs: 20_000,
    retries: 1,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {})
  });
  return async (municipality, operator) => {
    const body = await get<ServiceArea[]>('/service_area', {
      municipalities: municipality,
      operators: operator
    });
    return Array.isArray(body) ? body : [];
  };
}
