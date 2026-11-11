import { createHash } from 'node:crypto';
import {
  createOAuthHandler,
  type OAuthHandler
} from '@ultimatelemon-eu/mcp-http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeAccounts } from '../../src/moneybird/accounts.ts';
import { createLimiters } from '../../src/moneybird/client.ts';
import { moneybirdOAuth, type MoneybirdOAuth } from '../../src/server/oauth.ts';

const ORIGIN = 'https://mcp.example.test';
const CLIENT_ID = 'https://client.test/oauth/metadata';
const CLIENT_REDIRECT = 'https://client.test/callback';
const VERIFIER = 'v'.repeat(43);

/** Moneybird approves one administration per code; each token reaches only its own. */
const MONEYBIRD: Record<string, { token: string; id: number; name: string }> = {
  'code-studio': { token: 'tok-studio', id: 1, name: 'Studio Souf' },
  'code-lemon': { token: 'tok-lemon', id: 2, name: 'Lemon' },
  'code-studio-again': { token: 'tok-studio-2', id: 1, name: 'Studio Souf' }
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { 'content-type': 'application/json' }
  });
}

const fetchStub: typeof globalThis.fetch = (input, init) => {
  const url = new URL(
    typeof input === 'string' || input instanceof URL ? input : input.url
  );
  if (url.href === CLIENT_ID) {
    return Promise.resolve(
      json({
        client_id: CLIENT_ID,
        client_name: 'Test client',
        redirect_uris: [CLIENT_REDIRECT],
        token_endpoint_auth_method: 'none'
      })
    );
  }
  if (url.href === 'https://moneybird.com/oauth/token') {
    const form = new URLSearchParams(init?.body as URLSearchParams);
    if (form.get('grant_type') === 'refresh_token') {
      return Promise.resolve(
        json({
          access_token: `renewed-${form.get('refresh_token') ?? ''}`,
          expires_in: 3600
        })
      );
    }
    const approval = MONEYBIRD[form.get('code') ?? ''];
    if (!approval) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400
        })
      );
    }
    return Promise.resolve(
      json({
        access_token: approval.token,
        refresh_token: `refresh-${approval.token}`
      })
    );
  }
  if (url.pathname === '/api/v2/administrations.json') {
    const token = new Headers(init?.headers)
      .get('authorization')
      ?.replace('Bearer ', '');
    const approval = Object.values(MONEYBIRD).find(
      (candidate) => candidate.token === token
    );
    return Promise.resolve(
      json(approval ? [{ id: approval.id, name: approval.name }] : [])
    );
  }
  return Promise.reject(new Error(`unexpected fetch ${url.href}`));
};

function unescape(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

interface PageForm {
  action: string;
  fields: URLSearchParams;
  label: string;
}

function formsOf(html: string): PageForm[] {
  return [
    ...html.matchAll(/<form method="get" action="([^"]+)">([\s\S]*?)<\/form>/g)
  ].map(([, action = '', inner = '']) => ({
    action: unescape(action),
    fields: new URLSearchParams(
      [
        ...inner.matchAll(
          /<input type="hidden" name="([^"]+)" value="([^"]*)">/g
        )
      ].map(([, name = '', value = '']) => [unescape(name), unescape(value)])
    ),
    label: /<button[^>]*>([^<]+)<\/button>/.exec(inner)?.[1] ?? ''
  }));
}

function submit(form: PageForm): string {
  return `${form.action}?${form.fields.toString()}`;
}

describe('linking several administrations in one sign-in', () => {
  const previousKey = process.env['ENCRYPTION_KEY'];
  let signIn: MoneybirdOAuth;
  let handler: OAuthHandler;

  beforeAll(() => {
    process.env['ENCRYPTION_KEY'] = Buffer.alloc(32, 9).toString('base64');
    const created = moneybirdOAuth(
      {
        MONEYBIRD_CLIENT_ID: 'id',
        MONEYBIRD_CLIENT_SECRET: 'secret',
        PUBLIC_URL: ORIGIN,
        BASE_PATH: '/moneybird'
      },
      { limiters: createLimiters(), fetch: fetchStub }
    );
    if (!created) throw new Error('OAuth should be on');
    signIn = created;
    handler = createOAuthHandler(
      {
        ...signIn.oauth,
        clientIdMetadata: { trustedHosts: ['client.test'] },
        fetch: fetchStub
      },
      '/moneybird'
    );
  });
  afterAll(() => {
    if (previousKey === undefined) delete process.env['ENCRYPTION_KEY'];
    else process.env['ENCRYPTION_KEY'] = previousKey;
  });

  async function startSignIn(): Promise<URL> {
    const authorize = new URL(`${ORIGIN}/moneybird/authorize`);
    authorize.search = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: CLIENT_REDIRECT,
      response_type: 'code',
      state: 'client-state',
      code_challenge: createHash('sha256').update(VERIFIER).digest('base64url'),
      code_challenge_method: 'S256'
    }).toString();
    const response = await handler.handle(new Request(authorize));
    expect(response.status).toBe(302);
    return new URL(response.headers.get('location') ?? '');
  }

  /** Moneybird sends the user back to the link page, as it would after an approval. */
  async function approve(
    moneybird: URL,
    code: string
  ): Promise<{ html: string; forms: PageForm[] }> {
    expect(moneybird.searchParams.get('redirect_uri')).toBe(signIn.redirectUri);
    const back = new URL(signIn.redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', moneybird.searchParams.get('state') ?? '');
    const response = await signIn.pages(new Request(back));
    expect(response?.status).toBe(200);
    const html = (await response?.text()) ?? '';
    return { html, forms: formsOf(html) };
  }

  function linkAnother(forms: PageForm[]): URL {
    const form = forms.find((candidate) => candidate.label.includes('another'));
    if (!form) throw new Error('no link-another button');
    return new URL(submit(form));
  }

  async function finish(
    forms: PageForm[],
    administration: string
  ): Promise<string> {
    const form = forms.find((candidate) => candidate.label === 'Continue');
    if (!form) throw new Error('no continue button');
    expect(form.action).toBe(`${ORIGIN}/moneybird/oauth/callback`);

    // mcp-http takes over: settings page, then a code for the client.
    const settingsPage = await handler.handle(new Request(submit(form)));
    expect(settingsPage.status).toBe(200);
    const page = await settingsPage.text();
    expect(page).toContain('Studio Souf');
    const pending = unescape(
      /name="pending" value="([^"]+)"/.exec(page)?.[1] ?? ''
    );

    const settings = await handler.handle(
      new Request(`${ORIGIN}/moneybird/oauth/settings`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          pending,
          administration,
          access: 'write',
          toolsets: 'core'
        })
      })
    );
    expect(settings.status).toBe(302);
    const code = new URL(
      settings.headers.get('location') ?? ''
    ).searchParams.get('code');

    const token = await handler.handle(
      new Request(`${ORIGIN}/moneybird/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code ?? '',
          code_verifier: VERIFIER,
          client_id: CLIENT_ID,
          redirect_uri: CLIENT_REDIRECT
        })
      })
    );
    expect(token.status).toBe(200);
    return ((await token.json()) as { access_token: string }).access_token;
  }

  it('bundles one token per approved administration into the issued token', async () => {
    const first = await approve(await startSignIn(), 'code-studio');
    expect(first.html).toContain('Studio Souf');
    const second = await approve(linkAnother(first.forms), 'code-lemon');
    expect(second.html).toContain('Studio Souf');
    expect(second.html).toContain('Lemon');

    const grant = handler.authenticate(await finish(second.forms, '2'));
    expect(grant?.settings['administration']).toBe('2');
    expect(decodeAccounts(grant?.accessToken ?? '')).toEqual([
      {
        accessToken: 'tok-studio',
        administrations: [{ id: '1', name: 'Studio Souf' }]
      },
      {
        accessToken: 'tok-lemon',
        administrations: [{ id: '2', name: 'Lemon' }]
      }
    ]);
  });

  it('replaces an administration approved twice and says so', async () => {
    const first = await approve(await startSignIn(), 'code-studio');
    const again = await approve(linkAnother(first.forms), 'code-studio-again');
    expect(again.html).toContain('was already linked');

    const grant = handler.authenticate(await finish(again.forms, '1'));
    expect(
      decodeAccounts(grant?.accessToken ?? '')?.map(
        (account) => account.accessToken
      )
    ).toEqual(['tok-studio-2']);
  });

  it('keeps what was linked when the next approval is declined', async () => {
    const first = await approve(await startSignIn(), 'code-studio');
    const declined = new URL(signIn.redirectUri);
    declined.searchParams.set('error', 'access_denied');
    declined.searchParams.set(
      'state',
      linkAnother(first.forms).searchParams.get('state') ?? ''
    );
    const response = await signIn.pages(new Request(declined));
    expect(response?.status).toBe(200);
    const html = (await response?.text()) ?? '';
    expect(html).toContain('Moneybird added nothing');
    expect(html).toContain('Studio Souf');
  });

  it('refuses a link page whose state it did not seal', async () => {
    const forged = new URL(signIn.redirectUri);
    forged.searchParams.set('code', 'code-studio');
    forged.searchParams.set('state', 'forged');
    const response = await signIn.pages(new Request(forged));
    expect(response?.status).toBe(400);
  });

  it('refuses a finished link meant for another sign-in', async () => {
    const first = await approve(await startSignIn(), 'code-studio');
    const done = first.forms.find((form) => form.label === 'Continue');
    await expect(
      signIn.oauth.upstream.exchangeCode({
        code: done?.fields.get('code') ?? '',
        redirectUri: `${ORIGIN}/moneybird/oauth/callback`,
        codeVerifier: 'someone-else'
      })
    ).rejects.toThrow(/another attempt/);
  });

  it('only serves the link page', async () => {
    expect(
      await signIn.pages(new Request(`${ORIGIN}/moneybird/elsewhere`))
    ).toBeUndefined();
  });

  it('renews the tokens that are about to expire and keeps the rest', async () => {
    const { encodeAccounts } = await import('../../src/moneybird/accounts.ts');
    const bundle = encodeAccounts(
      [
        {
          accessToken: 'old',
          refreshToken: 'r-old',
          expiresAt: Date.now() + 1000,
          administrations: [{ id: '1' }]
        },
        { accessToken: 'fresh', administrations: [{ id: '2' }] }
      ],
      { withRefresh: true }
    );
    const renewed = await signIn.oauth.upstream.refresh?.(bundle);
    const accounts = decodeAccounts(renewed?.refreshToken ?? '');
    expect(accounts?.map((account) => account.accessToken)).toEqual([
      'renewed-r-old',
      'fresh'
    ]);
    expect(accounts?.[0]?.refreshToken).toBe('r-old');
    expect(renewed?.expiresAt).toBeGreaterThan(Date.now() + 30 * 60 * 1000);
    // The access side carries no refresh tokens.
    expect(decodeAccounts(renewed?.accessToken ?? '')?.[0]).not.toHaveProperty(
      'refreshToken'
    );
  });

  it('still renews a plain refresh token from before linking', async () => {
    const renewed = await signIn.oauth.upstream.refresh?.('r-plain');
    expect(renewed?.accessToken).toBe('renewed-r-plain');
  });
});
