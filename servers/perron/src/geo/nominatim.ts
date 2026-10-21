import { createJsonClient } from '../lib/json.ts';
import type { Logger } from '../lib/logger.ts';

export const NOMINATIM = 'https://nominatim.openstreetmap.org';

export interface NominatimPlace {
  lat: string;
  lon: string;
  name?: string;
  display_name?: string;
}

export interface Nominatim {
  search(query: string): Promise<NominatimPlace | undefined>;
}

export interface NominatimOptions {
  userAgent: string;
  logger?: Logger;
  fetch?: typeof fetch;
  baseUrl?: string;
}

/** Fallback geocoder. The usage policy allows one request a second and wants an identifying User-Agent. */
export function createNominatim(options: NominatimOptions): Nominatim {
  const get = createJsonClient('Nominatim', {
    baseUrl: options.baseUrl ?? NOMINATIM,
    headers: { 'User-Agent': options.userAgent },
    // Never more than two in any two seconds; answers are kept for good, so this is rarely felt.
    rateLimit: { limit: 2, windowMs: 2000, burst: 1, maxWaitMs: 5000 },
    timeoutMs: 8000,
    retries: 0,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {})
  });
  return {
    async search(query) {
      const results = await get<NominatimPlace[]>('/search', {
        q: query,
        format: 'jsonv2',
        limit: 1,
        countrycodes: 'nl'
      });
      return Array.isArray(results) ? results[0] : undefined;
    }
  };
}
