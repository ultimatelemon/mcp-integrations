import { createOAuthHandler } from '@ultimatelemon-eu/mcp-http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callerConfig,
  configFromEnv,
  permissionsFor
} from '../../src/config/schema.ts';
import { createLimiters } from '../../src/moneybird/client.ts';
import { connectionHeaders, moneybirdOAuth } from '../../src/server/oauth.ts';
import { stubFetch } from '../support/fetch.ts';

const env = {
  MONEYBIRD_CLIENT_ID: 'id',
  MONEYBIRD_CLIENT_SECRET: 'secret',
  PUBLIC_URL: 'https://mcp.example.test'
};

describe('moneybirdOAuth', () => {
  const previousKey = process.env['ENCRYPTION_KEY'];
  beforeAll(() => {
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 7).toString('base64');
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env['ENCRYPTION_KEY'];
    else process.env['ENCRYPTION_KEY'] = previousKey;
  });

  it('is off without client credentials', () => {
    expect(moneybirdOAuth({}, { limiters: createLimiters() })).toBeUndefined();
  });

  it('needs both client values and a public URL', () => {
    const deps = { limiters: createLimiters() };
    expect(() => moneybirdOAuth({ MONEYBIRD_CLIENT_ID: 'id' }, deps)).toThrow(
      /both/
    );
    expect(() =>
      moneybirdOAuth({ ...env, PUBLIC_URL: undefined }, deps)
    ).toThrow(/PUBLIC_URL/);
  });

  it('sends the user to Moneybird with every scope, back to the link page', async () => {
    const signIn = moneybirdOAuth(
      { ...env, BASE_PATH: '/moneybird' },
      { limiters: createLimiters() }
    );
    expect(signIn?.redirectUri).toBe(
      'https://mcp.example.test/moneybird/oauth/link'
    );
    const url = new URL(
      (await signIn?.oauth.upstream.authorizeUrl({
        redirectUri: 'https://mcp.example.test/moneybird/oauth/callback',
        state: 's',
        codeChallenge: 'c'
      })) ?? ''
    );
    expect(url.origin + url.pathname).toBe(
      'https://moneybird.com/oauth/authorize'
    );
    expect(url.searchParams.get('scope')).toBe(
      'sales_invoices documents estimates bank time_entries settings'
    );
    expect(url.searchParams.get('redirect_uri')).toBe(signIn?.redirectUri);
  });

  it('accepts metadata-document clients only, without open registration', async () => {
    const signIn = moneybirdOAuth(env, { limiters: createLimiters() });
    if (!signIn) throw new Error('OAuth should be on');
    const handler = createOAuthHandler(signIn.oauth, '/moneybird');

    const response = await handler.handle(
      new Request(
        'https://mcp.example.test/.well-known/oauth-authorization-server/moneybird'
      )
    );
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata['client_id_metadata_document_supported']).toBe(true);
    expect(metadata).not.toHaveProperty('registration_endpoint');
    expect(handler.owns('/moneybird/register')).toBe(false);
  });

  it('trusts metadata documents from claude.ai and the Mike assistant', () => {
    const signIn = moneybirdOAuth(env, { limiters: createLimiters() });
    expect(signIn?.oauth.clientIdMetadata).toEqual({
      trustedHosts: ['claude.ai', 'assistent.studiosouf.com']
    });
  });

  it('offers the administrations the token reaches', async () => {
    const upstream = stubFetch({
      body: [
        { id: 1, name: 'Studio', country: 'NL', currency: 'EUR' },
        { id: 2, name: 'Lemon' }
      ]
    });
    const signIn = moneybirdOAuth(env, {
      limiters: createLimiters(),
      fetch: upstream.fetch
    });
    const form = await signIn?.oauth.settings?.('token');

    expect(upstream.lastRequest().headers['authorization']).toBe(
      'Bearer token'
    );
    const administration = form?.fields.find(
      (field) => field.name === 'administration'
    );
    expect(administration?.options.map((option) => option.value)).toEqual([
      '1',
      '2',
      ''
    ]);
    expect(form?.fields.map((field) => field.name)).toEqual([
      'administration',
      'access',
      'toolsets'
    ]);
  });
});

describe('connectionHeaders', () => {
  const defaults = configFromEnv({});

  it('turns the sign-in settings into caller config', () => {
    const { config } = callerConfig(
      defaults,
      connectionHeaders(
        { administration: '7', access: 'delete', toolsets: 'core,banking' },
        new Headers()
      )
    );
    expect(config.administrationId).toBe('7');
    expect(permissionsFor(config)).toEqual({ write: true, destroy: true });
    expect(config.toolsets).toEqual(['core', 'banking']);
  });

  it('lets request headers win over the sign-in settings', () => {
    const { config } = callerConfig(
      defaults,
      connectionHeaders(
        { administration: '7', access: 'delete', toolsets: '' },
        new Headers({ 'x-moneybird-access': 'read' })
      )
    );
    expect(permissionsFor(config)).toEqual({ write: false, destroy: false });
    expect(config.toolsets).toEqual([]);
  });

  it('passes headers through without sign-in settings', () => {
    const headers = connectionHeaders(
      undefined,
      new Headers({ 'x-moneybird-administration': '3' })
    );
    expect(headers.get('x-moneybird-administration')).toBe('3');
  });
});
