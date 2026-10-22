import { describe, expect, it } from 'vitest';
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

  it('sends the user to Moneybird with every scope', () => {
    const oauth = moneybirdOAuth(env, { limiters: createLimiters() });
    const url = new URL(
      oauth?.upstream.authorizeUrl({
        redirectUri: 'https://mcp.example.test/moneybird/oauth/callback',
        state: 's'
      }) ?? ''
    );
    expect(url.origin + url.pathname).toBe(
      'https://moneybird.com/oauth/authorize'
    );
    expect(url.searchParams.get('scope')).toBe(
      'sales_invoices documents estimates bank time_entries settings'
    );
  });

  it('offers the administrations the token reaches', async () => {
    const upstream = stubFetch({
      body: [
        { id: 1, name: 'Studio', country: 'NL', currency: 'EUR' },
        { id: 2, name: 'Lemon' }
      ]
    });
    const oauth = moneybirdOAuth(env, {
      limiters: createLimiters(),
      fetch: upstream.fetch
    });
    const form = await oauth?.settings?.('token');

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
