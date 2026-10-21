import {
  createFetchClient,
  HttpError,
  type FetchClient,
  type QueryValue
} from '@ultimatelemon-eu/fetch-client';
import type { Logger } from '../lib/logger.ts';
import { UpstreamError } from '../errors.ts';

export const NS_GATEWAY = 'https://gateway.apiportal.ns.nl';

export interface NsClient {
  get<T>(path: string, query?: Record<string, QueryValue>): Promise<T>;
}

export interface NsClientOptions {
  apiKey: string;
  logger?: Logger;
  fetch?: typeof fetch;
  baseUrl?: string;
  language?: 'en' | 'nl';
}

function upstreamMessage(error: HttpError): string {
  const body = error.body;
  if (typeof body === 'string' && body.length < 300) return body;
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const nested = record['errors'];
    if (Array.isArray(nested) && nested.length > 0) {
      const first = nested[0] as Record<string, unknown>;
      if (typeof first['message'] === 'string') return first['message'];
    }
    for (const key of ['message', 'errorMessage', 'error']) {
      if (typeof record[key] === 'string') return record[key];
    }
  }
  return error.message;
}

export function createNsClient(options: NsClientOptions): NsClient {
  const client: FetchClient = createFetchClient({
    baseUrl: options.baseUrl ?? NS_GATEWAY,
    headers: {
      'Ocp-Apim-Subscription-Key': options.apiKey,
      // undici sends `Accept-Language: *` by default, which the Places API rejects with a 400.
      'Accept-Language': options.language ?? 'en'
    },
    // NS allows 300 requests per 5 minutes per key.
    rateLimit: { limit: 300, windowMs: 300_000, burst: 40, maxWaitMs: 8000 },
    timeoutMs: 10_000,
    retries: 1,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {})
  });

  return {
    async get<T>(path: string, query?: Record<string, QueryValue>) {
      try {
        return await client.get<T>(path, query);
      } catch (error) {
        if (error instanceof HttpError) {
          throw new UpstreamError(
            error.status,
            `NS API ${String(error.status)}: ${upstreamMessage(error)}`
          );
        }
        throw error;
      }
    }
  };
}
