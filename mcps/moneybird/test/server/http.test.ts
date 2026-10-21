import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Client,
  StreamableHTTPClientTransport
} from '@modelcontextprotocol/client';
import {
  startMcpHttpServer,
  type McpHttpServer
} from '@ultimatelemon-eu/mcp-http';
import { callerConfig, configFromEnv } from '../../src/config/schema.ts';
import { createMoneybirdServer } from '../../src/server/create.ts';
import { stubFetch } from '../support/fetch.ts';

const upstream = stubFetch({ body: [] });
let http: McpHttpServer;

beforeAll(async () => {
  const defaults = configFromEnv({});
  http = await startMcpHttpServer({
    createMcpServer: ({ apiKey = '', headers }) => {
      const { config, warnings } = callerConfig(defaults, headers);
      return createMoneybirdServer({
        config,
        token: apiKey,
        notes: warnings,
        fetch: upstream.fetch
      }).server;
    },
    port: 0,
    host: '127.0.0.1',
    basePath: '/moneybird',
    apiKey: {}
  });
});

afterAll(() => http.close());

async function connect(headers: Record<string, string>): Promise<Client> {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(http.url), {
      requestInit: { headers }
    })
  );
  return client;
}

describe('moneybird over Streamable HTTP', () => {
  it('rejects a call without a token', async () => {
    const res = await fetch(http.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream'
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    expect(res.status).toBe(401);
  });

  it('calls Moneybird with the caller token and default administration', async () => {
    const client = await connect({
      'x-api-key': 'caller-token',
      'x-moneybird-administration': '42'
    });
    await client.callTool({ name: 'list_contacts', arguments: {} });
    const request = upstream.requests.at(-1);
    expect(request?.headers['authorization']).toBe('Bearer caller-token');
    expect(request?.url).toContain('/42/contacts');
    await client.close();
  });

  it('is read-only by default and opens up with X-Moneybird-Access', async () => {
    const readOnly = await connect({ 'x-api-key': 't' });
    const before = (await readOnly.listTools()).tools.map((tool) => tool.name);
    expect(before).not.toContain('create_contact');
    await readOnly.close();

    const writer = await connect({
      'x-api-key': 't',
      'x-moneybird-access': 'write'
    });
    const after = (await writer.listTools()).tools.map((tool) => tool.name);
    expect(after).toContain('create_contact');
    expect(after).not.toContain('delete_contact');
    await writer.close();
  });
});
