import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type ServerResponse
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { stringify } from 'yaml';
import {
  parseRoutesFile,
  resolveConfig,
  type RoutesFile
} from '../../src/config.ts';
import {
  startGateway,
  type Logger,
  type RunningGateway
} from '../../src/gateway.ts';

export const PUBLIC_URL = 'https://mcp.test';
export const ISSUER = 'https://id.test';
export const OIDC_CLIENT_ID = 'gateway-client';
export const OIDC_CLIENT_SECRET = 'gateway-secret';
export const CLAUDE_CLIENT_ID =
  'https://claude.ai/oauth/mcp-oauth-client-metadata';
export const CLAUDE_REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';
export const MIKE_CLIENT_ID =
  'https://assistent.studiosouf.com/oauth/client-metadata.json';
export const MIKE_REDIRECT_URI =
  'https://assistent.studiosouf.com/oauth/callback';
export const OWNER_SUB = 'owner-sub-1';
export const FRIEND_SUB = 'friend-sub-2';
export const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
export const GARMIN_TOKEN = 'garmin-upstream-token';
export const DUMMY_TOKEN = 'dummy-upstream-token';

const ZITADEL_ACCESS_TOKEN = 'zitadel-access-token';

function base64url(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function idToken(sub: string): string {
  const now = Math.floor(Date.now() / 1000);
  return [
    base64url({ alg: 'RS256' }),
    base64url({
      iss: ISSUER,
      aud: [OIDC_CLIENT_ID],
      azp: OIDC_CLIENT_ID,
      sub,
      exp: now + 3600,
      iat: now
    }),
    'signature'
  ].join('.');
}

function clientDocument(clientId: string, redirectUri: string): Response {
  return Response.json({
    client_id: clientId,
    client_name: 'Test client',
    redirect_uris: [redirectUri],
    grant_types: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_method: 'none'
  });
}

/** Zitadel and the client metadata documents; anything else goes to the network. */
export const fakeFetch: typeof globalThis.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.href === CLAUDE_CLIENT_ID) {
    return clientDocument(CLAUDE_CLIENT_ID, CLAUDE_REDIRECT_URI);
  }
  if (url.href === MIKE_CLIENT_ID) {
    return clientDocument(MIKE_CLIENT_ID, MIKE_REDIRECT_URI);
  }
  if (url.origin !== ISSUER) return globalThis.fetch(input, init);

  if (url.pathname === '/.well-known/openid-configuration') {
    return Response.json({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth/v2/authorize`,
      token_endpoint: `${ISSUER}/oauth/v2/token`
    });
  }
  if (url.pathname === '/oauth/v2/token') {
    // mcp-http posts the token request as URLSearchParams.
    const body = new URLSearchParams(init?.body as URLSearchParams);
    if (
      body.get('client_id') !== OIDC_CLIENT_ID ||
      body.get('client_secret') !== OIDC_CLIENT_SECRET
    ) {
      return Response.json({ error: 'invalid_client' }, { status: 401 });
    }
    // The fake signs in whoever the code names: `code:<sub>`.
    const code = body.get('code') ?? '';
    if (!code.startsWith('code:')) {
      return Response.json({ error: 'invalid_grant' }, { status: 400 });
    }
    return Response.json({
      access_token: ZITADEL_ACCESS_TOKEN,
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: 'zitadel-refresh-token',
      id_token: idToken(code.slice('code:'.length))
    });
  }
  return new Response('not found', { status: 404 });
};

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type UpstreamHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: string
) => void | Promise<void>;

export interface FakeUpstream {
  url: string;
  requests: RecordedRequest[];
  /** Answers requests whose path starts with `prefix`; the default echoes JSON-RPC. */
  on(prefix: string, handler: UpstreamHandler): void;
  close(): Promise<void>;
}

/** The MCP servers behind the routes, as one HTTP server with a path per route. */
export async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: RecordedRequest[] = [];
  const handlers = new Map<string, UpstreamHandler>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body
      });
      const handler = [...handlers].find(([prefix]) =>
        (req.url ?? '').startsWith(prefix)
      )?.[1];
      if (handler) {
        void handler(req, res, body);
        return;
      }
      res.writeHead(200, {
        'content-type': 'application/json',
        'mcp-session-id': 'session-1',
        'set-cookie': 'upstream=1'
      });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: 1, result: { path: req.url } })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests,
    on: (prefix, handler) => handlers.set(prefix, handler),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

const REPO_ROUTES = new URL('../../routes.yaml', import.meta.url);

/** The repository's routes.yaml plus a dummy route: config only, no code. */
export function routesWithDummy(
  edit: (file: RoutesFile) => void = () => undefined
): string {
  const file = parseRoutesFile(readFileSync(REPO_ROUTES, 'utf8'));
  file.subjects['friend'] = 'GATEWAY_FRIEND_SUB';
  file.routes['dummy'] = {
    path: '/dummy',
    upstream: 'http://dummy-mcp:9000/mcp',
    upstreamTokenEnv: 'DUMMY_MCP_TOKEN',
    name: 'Dummy',
    allowedSubjects: ['owner', 'friend']
  };
  edit(file);
  return stringify(file);
}

export function testEnv(upstream: string): NodeJS.ProcessEnv {
  return {
    PUBLIC_URL,
    ENCRYPTION_KEY,
    GATEWAY_OIDC_ISSUER: ISSUER,
    GATEWAY_OIDC_CLIENT_ID: OIDC_CLIENT_ID,
    GATEWAY_OIDC_CLIENT_SECRET: OIDC_CLIENT_SECRET,
    GATEWAY_OWNER_SUB: OWNER_SUB,
    GATEWAY_FRIEND_SUB: FRIEND_SUB,
    GARMIN_MCP_HTTP_TOKEN: GARMIN_TOKEN,
    DUMMY_MCP_TOKEN: DUMMY_TOKEN,
    GARMIN_UPSTREAM_URL: `${upstream}/garmin-mcp`,
    DUMMY_UPSTREAM_URL: `${upstream}/dummy-mcp`
  };
}

export interface LogEntry {
  level: string;
  obj: object;
  msg: string | undefined;
}

export function captureLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  const at =
    (level: string) =>
    (obj: object, msg?: string): void => {
      entries.push({ level, obj, msg });
    };
  return {
    entries,
    logger: { info: at('info'), warn: at('warn'), error: at('error') }
  };
}

export async function startTestGateway(
  routesYaml: string,
  env: NodeJS.ProcessEnv,
  logger?: Logger
): Promise<RunningGateway> {
  const config = resolveConfig(parseRoutesFile(routesYaml), env);
  return startGateway(
    config,
    { port: 0, host: '127.0.0.1' },
    { fetch: fakeFetch, ...(logger ? { logger } : {}) }
  );
}

export type SignInResult =
  | { ok: true; accessToken: string; refreshToken: string }
  | { ok: false; status: number; body: string };

/** The whole sign-in as claude.ai does it: authorize, Zitadel, callback, token. */
export async function signIn(
  base: string,
  path: string,
  sub: string,
  client = { id: CLAUDE_CLIENT_ID, redirectUri: CLAUDE_REDIRECT_URI }
): Promise<SignInResult> {
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(`${base}${path}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: 'code',
    client_id: client.id,
    redirect_uri: client.redirectUri,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'client-state'
  }).toString();
  const toZitadel = await fetch(authorize, { redirect: 'manual' });
  if (toZitadel.status !== 302) {
    return {
      ok: false,
      status: toZitadel.status,
      body: await toZitadel.text()
    };
  }
  const zitadel = new URL(toZitadel.headers.get('location') ?? '');
  if (
    `${zitadel.origin}${zitadel.pathname}` !== `${ISSUER}/oauth/v2/authorize` ||
    zitadel.searchParams.get('redirect_uri') !==
      `${PUBLIC_URL}${path}/oauth/callback` ||
    !zitadel.searchParams.get('scope')?.split(' ').includes('offline_access')
  ) {
    throw new Error(`Unexpected Zitadel redirect: ${zitadel.href}`);
  }

  const callback = new URL(`${base}${path}/oauth/callback`);
  callback.searchParams.set('code', `code:${sub}`);
  callback.searchParams.set('state', zitadel.searchParams.get('state') ?? '');
  const toClient = await fetch(callback, { redirect: 'manual' });
  if (toClient.status !== 302) {
    return { ok: false, status: toClient.status, body: await toClient.text() };
  }
  const back = new URL(toClient.headers.get('location') ?? '');
  const code = back.searchParams.get('code') ?? '';

  const token = await fetch(`${base}${path}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: client.id,
      redirect_uri: client.redirectUri
    })
  });
  const body = (await token.json()) as {
    access_token?: string;
    refresh_token?: string;
  };
  if (!token.ok || !body.access_token || !body.refresh_token) {
    return { ok: false, status: token.status, body: JSON.stringify(body) };
  }
  return {
    ok: true,
    accessToken: body.access_token,
    refreshToken: body.refresh_token
  };
}

export function mcpCall(
  base: string,
  path: string,
  token?: string,
  init: RequestInit = {}
): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    ...init,
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers as Record<string, string> | undefined)
    },
    body:
      init.body ??
      JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
}
