import {
  createFetchClient,
  HttpError,
  type FetchClientOptions,
  type QueryValue
} from '@ultimatelemon-eu/fetch-client';
import { UpstreamError } from '../errors.ts';

export type JsonGet = <T>(
  path: string,
  query?: Record<string, QueryValue>
) => Promise<T>;

/** A fetch-client whose HTTP errors carry the service name the assistant sees. */
export function createJsonClient(
  service: string,
  options: FetchClientOptions
): JsonGet {
  const client = createFetchClient(options);
  return async <T>(path: string, query?: Record<string, QueryValue>) => {
    try {
      return await client.get<T>(path, query);
    } catch (error) {
      if (error instanceof HttpError) {
        throw new UpstreamError(
          error.status,
          `${service} API ${String(error.status)}: ${error.message}`,
          service
        );
      }
      throw error;
    }
  };
}
