import { UpstreamError } from '../errors.ts';

export interface BinaryOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

/** GET for non-JSON bodies (protobuf, zip); the JSON APIs go through fetch-client. */
export async function fetchBinary(
  url: string,
  service: string,
  options: BinaryOptions = {}
): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(url, {
      ...(options.headers ? { headers: options.headers } : {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000)
    });
  } catch (error) {
    const timedOut =
      error instanceof DOMException && error.name === 'TimeoutError';
    throw new UpstreamError(
      timedOut ? 504 : 502,
      timedOut
        ? `${service} did not answer in time`
        : `${service} could not be reached`,
      service
    );
  }
  if (response.status === 304) return response;
  if (!response.ok) {
    await response.body?.cancel();
    throw new UpstreamError(
      response.status,
      `${service} ${String(response.status)}`,
      service
    );
  }
  return response;
}
