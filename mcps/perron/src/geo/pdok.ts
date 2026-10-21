import { createJsonClient } from '../lib/json.ts';
import type { Logger } from '../lib/logger.ts';

export const PDOK_LOCATIESERVER =
  'https://api.pdok.nl/bzk/locatieserver/search/v3_1';

/** One document from the Locatieserver; which fields are set depends on its type. */
export interface PdokDoc {
  type?: string;
  weergavenaam?: string;
  centroide_ll?: string;
  straatnaam?: string;
  woonplaatsnaam?: string;
  gemeentecode?: string;
  gemeentenaam?: string;
  afstand?: number;
}

interface PdokResponse {
  response?: { numFound?: number; docs?: PdokDoc[] };
}

export interface Pdok {
  search(query: string): Promise<PdokDoc | undefined>;
  /** The nearest address to a point. */
  reverse(lat: number, lon: number): Promise<PdokDoc | undefined>;
}

export interface PdokOptions {
  logger?: Logger;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function createPdok(options: PdokOptions = {}): Pdok {
  const get = createJsonClient('PDOK Locatieserver', {
    baseUrl: options.baseUrl ?? PDOK_LOCATIESERVER,
    rateLimit: { limit: 50, windowMs: 1000, burst: 10, maxWaitMs: 5000 },
    timeoutMs: 8000,
    retries: 1,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {})
  });
  return {
    async search(query) {
      const body = await get<PdokResponse>('/free', {
        q: query,
        rows: 1,
        fl: '*'
      });
      return body.response?.docs?.[0];
    },
    async reverse(lat, lon) {
      const body = await get<PdokResponse>('/reverse', {
        lat,
        lon,
        type: 'adres',
        rows: 1,
        fl: '*'
      });
      return body.response?.docs?.[0];
    }
  };
}

/** `POINT(4.90058 52.3789)` → lat/lon; WKT puts longitude first. */
export function parsePoint(
  wkt: string | undefined
): { lat: number; lon: number } | undefined {
  const match = /POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/i.exec(wkt ?? '');
  if (!match) return undefined;
  return { lon: Number(match[1]), lat: Number(match[2]) };
}

/** CBS municipality code as the MDS API wants it: `0363` → `GM0363`. */
export function municipalityCode(code: string | undefined): string | undefined {
  if (!code) return undefined;
  const digits = code.replace(/^GM/i, '');
  return /^\d{1,4}$/.test(digits) ? `GM${digits.padStart(4, '0')}` : undefined;
}
