import { request as httpRequest } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RunningGateway } from '../src/gateway.ts';
import {
  captureLogger,
  CLAUDE_CLIENT_ID,
  DUMMY_TOKEN,
  ENCRYPTION_KEY,
  FRIEND_SUB,
  GARMIN_TOKEN,
  mcpCall,
  MIKE_CLIENT_ID,
  MIKE_REDIRECT_URI,
  OWNER_SUB,
  PUBLIC_URL,
  routesWithDummy,
  signIn,
  startFakeUpstream,
  startTestGateway,
  testEnv,
  type FakeUpstream,
  type LogEntry
} from './support/fakes.ts';

let upstream: FakeUpstream;
let gateway: RunningGateway;
let entries: LogEntry[];
let ownerGarmin: string;
let ownerDummy: string;
const previousKey = process.env['ENCRYPTION_KEY'];

beforeAll(async () => {
  // @ultimatelemon-eu/crypto reads the key from process.env itself.
  process.env['ENCRYPTION_KEY'] = ENCRYPTION_KEY;
  upstream = await startFakeUpstream();
  const capture = captureLogger();
  entries = capture.entries;
  gateway = await startTestGateway(
    routesWithDummy(),
    testEnv(upstream.url),
    capture.logger
  );
  const garmin = await signIn(gateway.url, '/garmin', OWNER_SUB);
  const dummy = await signIn(gateway.url, '/dummy', OWNER_SUB);
  if (!garmin.ok || !dummy.ok) throw new Error('owner sign-in failed');
  ownerGarmin = garmin.accessToken;
  ownerDummy = dummy.accessToken;
});

afterAll(async () => {
  await gateway.close();
  await upstream.close();
  if (previousKey === undefined) delete process.env['ENCRYPTION_KEY'];
  else process.env['ENCRYPTION_KEY'] = previousKey;
});

beforeEach(() => {
  upstream.requests.length = 0;
});

describe('metadata', () => {
  it.each(['/garmin', '/dummy'])(
    'serves protected resource metadata for %s at the root and under the path',
    async (path) => {
      for (const url of [
        `/.well-known/oauth-protected-resource${path}`,
        `${path}/.well-known/oauth-protected-resource`
      ]) {
        const response = await fetch(`${gateway.url}${url}`);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          resource: `${PUBLIC_URL}${path}`,
          authorization_servers: [`${PUBLIC_URL}${path}`]
        });
      }
    }
  );

  it.each(['/garmin', '/dummy'])(
    'advertises CIMD and no registration endpoint for %s',
    async (path) => {
      for (const url of [
        `/.well-known/oauth-authorization-server${path}`,
        `/.well-known/openid-configuration${path}`
      ]) {
        const response = await fetch(`${gateway.url}${url}`);
        const metadata = (await response.json()) as Record<string, unknown>;
        expect(metadata).toMatchObject({
          issuer: `${PUBLIC_URL}${path}`,
          authorization_endpoint: `${PUBLIC_URL}${path}/authorize`,
          token_endpoint: `${PUBLIC_URL}${path}/token`,
          client_id_metadata_document_supported: true,
          code_challenge_methods_supported: ['S256']
        });
        expect(metadata).not.toHaveProperty('registration_endpoint');
      }
    }
  );

  it('has no dynamic client registration', async () => {
    const response = await fetch(`${gateway.url}/garmin/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['https://evil.test/cb'] })
    });
    expect(response.status).toBe(404);
  });
});

describe('clients', () => {
  it('accepts the Mike client metadata document', async () => {
    const result = await signIn(gateway.url, '/garmin', OWNER_SUB, {
      id: MIKE_CLIENT_ID,
      redirectUri: MIKE_REDIRECT_URI
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a client from an untrusted host', async () => {
    const result = await signIn(gateway.url, '/garmin', OWNER_SUB, {
      id: 'https://evil.test/client.json',
      redirectUri: 'https://evil.test/cb'
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
    expect(!result.ok && result.body).toContain(
      'Clients from evil.test are not accepted here.'
    );
  });

  it('refuses a redirect uri the client did not publish', async () => {
    const result = await signIn(gateway.url, '/garmin', OWNER_SUB, {
      id: CLAUDE_CLIENT_ID,
      redirectUri: 'https://evil.test/cb'
    });
    expect(result).toMatchObject({ ok: false, status: 400 });
  });
});

describe('authentication', () => {
  it.each(['/garmin', '/garmin/mcp'])(
    'answers 401 with a challenge without a token on %s',
    async (path) => {
      const response = await mcpCall(gateway.url, path);
      expect(response.status).toBe(401);
      expect(response.headers.get('www-authenticate')).toBe(
        `Bearer resource_metadata="${PUBLIC_URL}/garmin/.well-known/oauth-protected-resource"`
      );
      expect(upstream.requests).toHaveLength(0);
    }
  );

  it('answers 401 invalid_token with a bad token', async () => {
    const response = await mcpCall(gateway.url, '/garmin/mcp', 'not-a-token');
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="${PUBLIC_URL}/garmin/.well-known/oauth-protected-resource"`
    );
    expect(upstream.requests).toHaveLength(0);
  });

  it('refuses a refresh token used as an access token', async () => {
    const result = await signIn(gateway.url, '/garmin', OWNER_SUB);
    if (!result.ok) throw new Error('sign-in failed');
    const response = await mcpCall(
      gateway.url,
      '/garmin/mcp',
      result.refreshToken
    );
    expect(response.status).toBe(401);
  });

  it('refuses a token issued for another route', async () => {
    const onDummy = await mcpCall(gateway.url, '/dummy/mcp', ownerGarmin);
    expect(onDummy.status).toBe(401);
    expect(onDummy.headers.get('www-authenticate')).toBe(
      `Bearer error="invalid_token", resource_metadata="${PUBLIC_URL}/dummy/.well-known/oauth-protected-resource"`
    );
    const onGarmin = await mcpCall(gateway.url, '/garmin/mcp', ownerDummy);
    expect(onGarmin.status).toBe(401);
    expect(upstream.requests).toHaveLength(0);
  });

  it('serves each route with its own token', async () => {
    const garmin = await mcpCall(gateway.url, '/garmin/mcp', ownerGarmin);
    const dummy = await mcpCall(gateway.url, '/dummy/mcp', ownerDummy);
    expect(garmin.status).toBe(200);
    expect(dummy.status).toBe(200);
    expect(
      upstream.requests.map((r) => [r.url, r.headers.authorization])
    ).toEqual([
      ['/garmin-mcp', `Bearer ${GARMIN_TOKEN}`],
      ['/dummy-mcp', `Bearer ${DUMMY_TOKEN}`]
    ]);
  });
});

describe('allowed subjects', () => {
  it('refuses another Zitadel user at sign-in', async () => {
    const result = await signIn(gateway.url, '/garmin', FRIEND_SUB);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.body).toContain(
      'This account has no access to Garmin here.'
    );
    expect(entries).toContainEqual({
      level: 'warn',
      obj: { route: 'garmin', subject: FRIEND_SUB },
      msg: 'sign-in refused'
    });
  });

  it('lets a user in on the routes that allow them', async () => {
    const result = await signIn(gateway.url, '/dummy', FRIEND_SUB);
    if (!result.ok) throw new Error(result.body);
    const response = await mcpCall(
      gateway.url,
      '/dummy/mcp',
      result.accessToken
    );
    expect(response.status).toBe(200);
  });

  it('answers 403 once a subject is no longer allowed', async () => {
    // Earlier config: garmin also allowed the friend, who got a token then.
    const before = await startTestGateway(
      routesWithDummy((file) => {
        file.routes['garmin']?.allowedSubjects.push('friend');
      }),
      testEnv(upstream.url)
    );
    const result = await signIn(before.url, '/garmin', FRIEND_SUB);
    await before.close();
    if (!result.ok) throw new Error(result.body);

    const response = await mcpCall(
      gateway.url,
      '/garmin/mcp',
      result.accessToken
    );
    expect(response.status).toBe(403);
    expect(upstream.requests).toHaveLength(0);
  });
});

describe('proxy', () => {
  it('serves <path> and <path>/mcp, keeping the query string', async () => {
    const plain = await mcpCall(gateway.url, '/garmin?x=1', ownerGarmin);
    const mcp = await mcpCall(gateway.url, '/garmin/mcp', ownerGarmin);
    expect(plain.status).toBe(200);
    expect(mcp.status).toBe(200);
    expect(upstream.requests.map((r) => r.url)).toEqual([
      '/garmin-mcp?x=1',
      '/garmin-mcp'
    ]);
  });

  it('passes GET and DELETE for stateful servers', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(`${gateway.url}/garmin/mcp`, {
        method,
        headers: { authorization: `Bearer ${ownerGarmin}` }
      });
      expect(response.status).toBe(200);
    }
    expect(upstream.requests.map((r) => r.method)).toEqual(['GET', 'DELETE']);
  });

  it('swaps the caller token for the upstream token and strips hop-by-hop headers', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' });
    const response = await new Promise<{
      status: number;
      headers: Record<string, unknown>;
    }>((resolve, reject) => {
      const req = httpRequest(
        `${gateway.url}/garmin/mcp`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${ownerGarmin}`,
            'content-type': 'application/json',
            cookie: 'session=secret',
            connection: 'keep-alive, x-hop',
            'x-hop': 'dropped',
            'keep-alive': 'timeout=5',
            te: 'trailers',
            'proxy-authorization': 'Basic abc',
            'mcp-session-id': 'session-1',
            'mcp-protocol-version': '2025-06-18',
            'x-kept': 'yes'
          }
        },
        (res) => {
          res.resume();
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers })
          );
        }
      );
      req.on('error', reject);
      req.end(body);
    });

    expect(response.status).toBe(200);
    expect(response.headers['mcp-session-id']).toBe('session-1');
    expect(response.headers['set-cookie']).toBeUndefined();

    const [seen] = upstream.requests;
    expect(seen?.body).toBe(body);
    expect(seen?.headers).toMatchObject({
      authorization: `Bearer ${GARMIN_TOKEN}`,
      'mcp-session-id': 'session-1',
      'mcp-protocol-version': '2025-06-18',
      'x-kept': 'yes'
    });
    for (const name of [
      'cookie',
      'x-hop',
      'keep-alive',
      'te',
      'proxy-authorization'
    ]) {
      expect(seen?.headers).not.toHaveProperty(name);
    }
  });

  it('streams an SSE response through as it arrives', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first =
      'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n';
    const second =
      'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"tools":[]}}\n\n';
    upstream.on('/garmin-mcp', async (_req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache'
      });
      res.write(first);
      await held;
      res.end(second);
    });

    const response = await mcpCall(gateway.url, '/garmin/mcp', ownerGarmin);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = (response.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    // The second event is held back upstream, so the first must arrive alone.
    while (text.length < first.length) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toBe(first);
    release();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    expect(text).toBe(first + second);
    upstream.on('/garmin-mcp', (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
  });

  it.each([
    ['while the upstream stream is open', true],
    ['before the upstream answers', false]
  ])(
    'ends the upstream request when the client goes away %s',
    async (_when, streaming) => {
      let reached: () => void = () => undefined;
      const arrived = new Promise<void>((resolve) => {
        reached = resolve;
      });
      let upstreamClosed: () => void = () => undefined;
      const closed = new Promise<void>((resolve) => {
        upstreamClosed = resolve;
      });
      upstream.on('/garmin-mcp', (_req, res) => {
        res.on('close', () => upstreamClosed());
        if (streaming) {
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.write('event: message\ndata: {}\n\n');
        }
        reached();
      });

      const controller = new AbortController();
      const response = fetch(`${gateway.url}/garmin/mcp`, {
        headers: { authorization: `Bearer ${ownerGarmin}` },
        signal: controller.signal
      });
      if (streaming) {
        const body = (await response).body as ReadableStream<Uint8Array>;
        await body.getReader().read();
      } else {
        response.catch(() => undefined);
        await arrived;
      }
      controller.abort();

      await expect(closed).resolves.toBeUndefined();
      upstream.on('/garmin-mcp', (_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    }
  );

  it('answers 502 without the upstream challenge when the upstream refuses its token', async () => {
    upstream.on('/dummy-mcp', (_req, res) => {
      res.writeHead(401, { 'www-authenticate': 'Bearer realm="upstream"' });
      res.end();
    });
    const response = await mcpCall(gateway.url, '/dummy/mcp', ownerDummy);
    expect(response.status).toBe(502);
    expect(response.headers.get('www-authenticate')).toBeNull();
  });

  it('answers 502 when the upstream is down', async () => {
    const down = await startTestGateway(routesWithDummy(), {
      ...testEnv(upstream.url),
      DUMMY_UPSTREAM_URL: 'http://127.0.0.1:1/mcp'
    });
    const result = await signIn(down.url, '/dummy', OWNER_SUB);
    if (!result.ok) throw new Error(result.body);
    const response = await mcpCall(down.url, '/dummy/mcp', result.accessToken);
    await down.close();
    expect(response.status).toBe(502);
  });
});

describe('gateway', () => {
  it('answers /healthz', async () => {
    const response = await fetch(`${gateway.url}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it.each(['/', '/garmin/other', '/unknown/mcp', '/garmin/'])(
    'answers 404 for %s',
    async (path) => {
      const response = await fetch(`${gateway.url}${path}`, {
        headers: { authorization: `Bearer ${ownerGarmin}` }
      });
      expect(response.status).toBe(404);
      expect(upstream.requests).toHaveLength(0);
    }
  );

  it('logs no tokens and no bodies', async () => {
    await mcpCall(gateway.url, '/garmin/mcp', ownerGarmin, {
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'body-marker' })
    });
    const logged = JSON.stringify(entries);
    expect(entries.length).toBeGreaterThan(0);
    for (const secret of [
      ownerGarmin,
      ownerDummy,
      GARMIN_TOKEN,
      DUMMY_TOKEN,
      'zitadel-access-token',
      'body-marker',
      'code:'
    ]) {
      expect(logged).not.toContain(secret);
    }
  });
});
