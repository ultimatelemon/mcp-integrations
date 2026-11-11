import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../../src/config/schema.ts';
import {
  accountsOf,
  decodeAccounts,
  encodeAccounts,
  tokenFor,
  type LinkedAccount
} from '../../src/moneybird/accounts.ts';
import { createMoneybirdServer } from '../../src/server/create.ts';
import { stubFetch } from '../support/fetch.ts';

const ACCOUNTS: LinkedAccount[] = [
  {
    accessToken: 'tok-studio',
    refreshToken: 'r-studio',
    expiresAt: 1_000,
    administrations: [{ id: '1', name: 'Studio Souf' }]
  },
  { accessToken: 'tok-lemon', administrations: [{ id: '2', name: 'Lemon' }] }
];

describe('linked accounts', () => {
  it('round-trips, with refresh tokens only on request', () => {
    expect(
      decodeAccounts(encodeAccounts(ACCOUNTS, { withRefresh: true }))
    ).toEqual(ACCOUNTS);
    expect(
      decodeAccounts(encodeAccounts(ACCOUNTS, { withRefresh: false }))?.[0]
    ).toEqual({
      accessToken: 'tok-studio',
      administrations: [{ id: '1', name: 'Studio Souf' }]
    });
  });

  it('treats anything else as one plain token', () => {
    expect(decodeAccounts('personal-token')).toBeUndefined();
    expect(decodeAccounts('mbl1.not-json')).toBeUndefined();
    expect(accountsOf('personal-token')).toEqual([
      { accessToken: 'personal-token', administrations: [] }
    ]);
  });

  it('picks the token that covers the administration', () => {
    expect(tokenFor(ACCOUNTS, '2')).toBe('tok-lemon');
    expect(tokenFor(ACCOUNTS, '1')).toBe('tok-studio');
    expect(tokenFor(ACCOUNTS, undefined)).toBe('tok-studio');
    expect(() => tokenFor(ACCOUNTS, '3')).toThrow(/not linked.*1, 2/);
    // A single token answers for every administration, as a personal token does.
    expect(tokenFor(accountsOf('personal-token'), '3')).toBe('personal-token');
  });
});

describe('a server for a connection with several administrations', () => {
  async function connect(responses: Parameters<typeof stubFetch>[0]) {
    const http = stubFetch(responses);
    const { server } = createMoneybirdServer({
      config: configFromEnv({ MONEYBIRD_ADMINISTRATION_ID: '1' }),
      token: encodeAccounts(ACCOUNTS, { withRefresh: false }),
      fetch: http.fetch
    });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0.0.0' });
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport)
    ]);
    return { client, http };
  }

  function textOf(result: unknown): string {
    return (result as { content: Array<{ text?: string }> }).content
      .map((entry) => entry.text ?? '')
      .join('\n');
  }

  it('names the linked administrations in its instructions', async () => {
    const { client } = await connect({ body: [] });
    expect(client.getInstructions()).toContain('Studio Souf (1), Lemon (2)');
  });

  it('sends each administration its own token', async () => {
    const { client, http } = await connect({ body: [] });
    await client.callTool({ name: 'list_contacts', arguments: {} });
    await client.callTool({
      name: 'list_contacts',
      arguments: { administration_id: '2' }
    });
    expect(http.requests.map((request) => request.url)).toEqual([
      expect.stringContaining('/1/contacts'),
      expect.stringContaining('/2/contacts')
    ]);
    expect(
      http.requests.map((request) => request.headers['authorization'])
    ).toEqual(['Bearer tok-studio', 'Bearer tok-lemon']);
  });

  it('lists the administrations of every approval', async () => {
    const { client, http } = await connect([
      { body: [{ id: '1', name: 'Studio Souf' }] },
      { body: [{ id: '2', name: 'Lemon' }] }
    ]);
    const result = await client.callTool({
      name: 'list_administrations',
      arguments: {}
    });
    expect(JSON.parse(textOf(result))).toEqual([
      { id: '1', name: 'Studio Souf' },
      { id: '2', name: 'Lemon' }
    ]);
    expect(
      http.requests.map((request) => request.headers['authorization'])
    ).toEqual(['Bearer tok-studio', 'Bearer tok-lemon']);
  });

  it('explains an administration that is not linked, without calling Moneybird', async () => {
    const { client, http } = await connect({ body: [] });
    const result = await client.callTool({
      name: 'list_contacts',
      arguments: { administration_id: '3' }
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('not linked to this connection');
    expect(http.requests).toHaveLength(0);
  });
});
