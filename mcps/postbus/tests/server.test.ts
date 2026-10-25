import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
import type { McpHttpServer } from '@ultimatelemon-eu/mcp-http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb } from '../src/db/index.js';
import { createUser, setUserDisabled } from '../src/db/users.js';
import { startServer } from '../src/server.js';

let http: McpHttpServer;
let base: string;

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  closeDb();
  getDb();
  http = await startServer({
    port: 0,
    host: '127.0.0.1',
    basePath: '/postbus'
  });
  base = `http://127.0.0.1:${http.port}`;
});

afterAll(async () => {
  await http.close();
  vi.restoreAllMocks();
});

function listTools(token?: string): Promise<Response> {
  return fetch(`${base}/postbus/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
  });
}

describe('server', () => {
  it('answers 401 without a token', async () => {
    expect((await listTools()).status).toBe(401);
  });

  it('answers 401 for an unknown or disabled token', async () => {
    const { user, token } = createUser('disabled');
    setUserDisabled(user.id, true);

    for (const candidate of ['pb_unknown', token]) {
      const res = await listTools(candidate);
      expect(res.status).toBe(401);
      expect(res.headers.get('www-authenticate')).toBe(
        'Bearer error="invalid_token"'
      );
    }
  });

  it('serves the tools to a known token under the base path', async () => {
    const { token } = createUser('known');
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${base}/postbus`), {
        requestInit: { headers: { authorization: `Bearer ${token}` } }
      })
    );

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('list_accounts');

    const result = await client.callTool({
      name: 'list_accounts',
      arguments: {}
    });
    expect(result.isError).toBeFalsy();
    await client.close();
  });

  it('reports health on /healthz', async () => {
    const res = await fetch(`${base}/postbus/healthz`);
    expect(res.status).toBe(200);
  });
});
