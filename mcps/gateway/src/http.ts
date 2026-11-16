import type { IncomingMessage, ServerResponse } from 'node:http';

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'BodyTooLargeError';
  }
}

export async function readBody(
  req: IncomingMessage,
  maxBytes: number
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > maxBytes) throw new BodyTooLargeError();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(JSON.stringify(body));
}

export function jsonRpcError(
  res: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {}
): void {
  sendJson(
    res,
    status,
    { jsonrpc: '2.0', error: { code: -32000, message }, id: null },
    headers
  );
}

const MAX_OAUTH_BODY_BYTES = 64 * 1024;

/** The node request as a web Request, for the OAuth handler. */
export async function toRequest(req: IncomingMessage): Promise<Request> {
  const method = req.method ?? 'GET';
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) {
      headers.set(name, Array.isArray(value) ? value.join(', ') : value);
    }
  }
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(new URL(req.url ?? '/', 'http://localhost'), {
    method,
    headers,
    ...(hasBody ? { body: await readBody(req, MAX_OAUTH_BODY_BYTES) } : {})
  });
}

export async function sendResponse(
  res: ServerResponse,
  response: Response
): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') headers[name] = value;
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) headers['set-cookie'] = cookies;
  res.writeHead(response.status, headers);
  res.end(Buffer.from(await response.arrayBuffer()));
}
