import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { BodyTooLargeError, jsonRpcError, readBody } from './http.ts';

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
];

// The caller's credentials never reach the upstream; fetch sets host and
// length itself, and the internal hop needs no compression.
const DROPPED_REQUEST_HEADERS = new Set([
  ...HOP_BY_HOP,
  'authorization',
  'cookie',
  'host',
  'content-length',
  'accept-encoding',
  'expect'
]);

// fetch has already decoded the body, so its encoding and length no longer apply.
const DROPPED_RESPONSE_HEADERS = new Set([
  ...HOP_BY_HOP,
  'content-encoding',
  'content-length',
  'set-cookie',
  'www-authenticate'
]);

const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Names listed in a Connection header are hop-by-hop too (RFC 9110 7.6.1). */
function connectionTokens(value: string | string[] | null | undefined) {
  const joined = Array.isArray(value) ? value.join(',') : (value ?? '');
  return new Set(
    joined
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean)
  );
}

function upstreamHeaders(req: IncomingMessage, token: string): Headers {
  const listed = connectionTokens(req.headers.connection);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (DROPPED_REQUEST_HEADERS.has(name) || listed.has(name)) continue;
    headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  headers.set('authorization', `Bearer ${token}`);
  return headers;
}

function responseHeaders(upstream: Response): Record<string, string> {
  const listed = connectionTokens(upstream.headers.get('connection'));
  const headers: Record<string, string> = {};
  upstream.headers.forEach((value, name) => {
    if (!DROPPED_RESPONSE_HEADERS.has(name) && !listed.has(name)) {
      headers[name] = value;
    }
  });
  return headers;
}

export interface ProxyTarget {
  route: string;
  upstream: string;
  token: string;
}

export interface ProxyLogger {
  error(obj: object, msg?: string): void;
}

/** Forwards the request to the upstream and streams its answer back, SSE included. */
export async function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  target: ProxyTarget,
  fetchImpl: typeof globalThis.fetch,
  logger: ProxyLogger
): Promise<void> {
  const method = req.method ?? 'GET';
  let body: Buffer | undefined;
  if (method !== 'GET' && method !== 'HEAD') {
    try {
      body = await readBody(req, MAX_BODY_BYTES);
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        jsonRpcError(res, 413, 'Request body too large');
        return;
      }
      throw error;
    }
  }

  const url = new URL(target.upstream);
  url.search = new URL(req.url ?? '/', 'http://localhost').search;

  // A client that goes away ends the upstream request, open streams included.
  const controller = new AbortController();
  res.once('close', () => {
    if (!res.writableFinished) controller.abort();
  });

  let upstream: Response;
  try {
    upstream = await fetchImpl(url, {
      method,
      headers: upstreamHeaders(req, target.token),
      ...(body ? { body } : {}),
      redirect: 'manual',
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) return;
    logger.error(
      { route: target.route, err: error instanceof Error ? error.message : '' },
      'upstream unreachable'
    );
    jsonRpcError(res, 502, 'The MCP server behind this route is unreachable.');
    return;
  }

  // Its own 401 would send the client into a sign-in with the upstream, and a
  // redirect would reveal the internal address.
  if (
    upstream.status === 401 ||
    upstream.status === 403 ||
    (upstream.status >= 300 && upstream.status < 400)
  ) {
    await upstream.body?.cancel();
    logger.error(
      { route: target.route, status: upstream.status },
      upstream.status < 400
        ? 'upstream redirected; point the route at the final URL'
        : 'upstream refused the gateway token'
    );
    jsonRpcError(
      res,
      502,
      'The MCP server behind this route refused the call.'
    );
    return;
  }

  res.writeHead(upstream.status, responseHeaders(upstream));
  res.flushHeaders();
  if (!upstream.body) {
    res.end();
    return;
  }
  try {
    await pipeline(
      Readable.fromWeb(upstream.body as NodeReadableStream<Uint8Array>),
      res
    );
  } catch (error) {
    if (controller.signal.aborted) return;
    logger.error(
      { route: target.route, err: error instanceof Error ? error.message : '' },
      'upstream stream failed'
    );
    res.destroy();
  }
}
