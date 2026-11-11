import { createHash } from 'node:crypto';
import { decrypt, encrypt, isEncrypted } from '@ultimatelemon-eu/crypto';
import {
  escapeHtml,
  htmlPage,
  htmlResponse,
  UpstreamError,
  type OAuthUpstream,
  type UpstreamTokens
} from '@ultimatelemon-eu/mcp-http';
import {
  decodeAccounts,
  encodeAccounts,
  type LinkedAccount,
  type LinkedAdministration
} from '../moneybird/accounts.ts';

/** mcp-http's own sign-in state lasts ten minutes, so linking cannot outlive it. */
const LINK_TTL_MS = 10 * 60 * 1000;
/** Wider than mcp-http's leeway, so one refresh renews every token that is close. */
const REFRESH_LEEWAY_MS = 10 * 60 * 1000;
export const MAX_LINKED = 10;

export interface LinkingOptions {
  /** `PUBLIC_URL` plus the base path: where mcp-http serves its OAuth routes. */
  issuer: string;
  basePath: string;
  /** Talks to Moneybird itself. */
  moneybird: OAuthUpstream;
  administrationsOf: (accessToken: string) => Promise<LinkedAdministration[]>;
  now?: () => number;
}

export interface Linking {
  /** What mcp-http signs in with: Moneybird, once per administration, behind one page. */
  upstream: OAuthUpstream;
  /** Serves the page Moneybird redirects back to. */
  pages: (request: Request) => Promise<Response | undefined>;
  /** Register this at Moneybird as the application's redirect URI. */
  redirectUri: string;
}

/** Between approvals: mcp-http's state and challenge, and the accounts linked so far. */
interface LinkState {
  s: string;
  c: string;
  a: LinkedAccount[];
}

/** Handed to mcp-http's callback as the code once the user is done linking. */
interface DoneCode {
  c: string;
  a: LinkedAccount[];
}

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function tokensOf(accounts: readonly LinkedAccount[]): UpstreamTokens {
  const expiries = accounts
    .map((account) => account.expiresAt)
    .filter((expiresAt): expiresAt is number => expiresAt !== undefined);
  return {
    accessToken: encodeAccounts(accounts, { withRefresh: false }),
    refreshToken: encodeAccounts(accounts, { withRefresh: true }),
    ...(expiries.length > 0 ? { expiresAt: Math.min(...expiries) } : {})
  };
}

function accountFrom(
  tokens: UpstreamTokens,
  administrations: LinkedAdministration[]
): LinkedAccount {
  return {
    accessToken: tokens.accessToken,
    ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
    ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
    administrations
  };
}

function nameOf(administration: LinkedAdministration): string {
  return administration.name ?? administration.id;
}

function hiddenInputs(params: URLSearchParams): string {
  return [...params]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`
    )
    .join('');
}

const PAGE_STYLE = `<style>
  ul { margin: 0 0 1.5rem; padding-left: 1.25rem; }
  form + form { margin-top: .75rem; }
  button.secondary { background: transparent; color: inherit; border: 1px solid currentColor; }
</style>`;

export function createLinking(options: LinkingOptions): Linking {
  const now = options.now ?? Date.now;
  const redirectUri = `${options.issuer}/oauth/link`;
  const path = `${options.basePath}/oauth/link`;
  const callbackUrl = `${options.issuer}/oauth/callback`;

  function seal(type: string, value: object): string {
    return encrypt(JSON.stringify({ ...value, x: now() + LINK_TTL_MS }), {
      context: `moneybird-link:${type}:${options.issuer}`
    });
  }

  function open<T>(type: string, value: string | null): T | undefined {
    if (!value || !isEncrypted(value)) return undefined;
    try {
      const parsed = JSON.parse(
        decrypt(value, { context: `moneybird-link:${type}:${options.issuer}` })
      ) as T & { x?: number };
      if (typeof parsed.x !== 'number' || parsed.x < now()) return undefined;
      return parsed;
    } catch {
      return undefined;
    }
  }

  function moneybirdUrl(state: LinkState): string | Promise<string> {
    return options.moneybird.authorizeUrl({
      redirectUri,
      state: seal('state', state),
      codeChallenge: state.c
    });
  }

  function errorResponse(title: string, detail: string, status: number) {
    return htmlResponse(
      htmlPage(
        title,
        `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`
      ),
      status
    );
  }

  async function linkedPage(
    state: LinkState,
    notice?: string
  ): Promise<Response> {
    const names = state.a
      .flatMap((account) => account.administrations)
      .map((administration) => `<li>${escapeHtml(nameOf(administration))}</li>`)
      .join('');

    const formTargets: string[] = [];
    let addForm = '';
    if (state.a.length < MAX_LINKED) {
      const url = new URL(await moneybirdUrl(state));
      formTargets.push(url.origin);
      addForm = `<form method="get" action="${escapeHtml(url.origin + url.pathname)}">
        ${hiddenInputs(url.searchParams)}
        <button type="submit" class="secondary">Link another administration</button>
      </form>`;
    }
    const done = new URLSearchParams({
      code: seal('code', { c: state.c, a: state.a } satisfies DoneCode),
      state: state.s
    });

    return htmlResponse(
      htmlPage(
        'Moneybird linked',
        `${PAGE_STYLE}
        <h1>Moneybird linked</h1>
        ${notice ? `<p>${escapeHtml(notice)}</p>` : ''}
        <p>This connection reaches:</p>
        <ul>${names}</ul>
        <p>Moneybird approves one administration at a time. To add another, approve again and pick it on Moneybird's screen.</p>
        ${addForm}
        <form method="get" action="${escapeHtml(callbackUrl)}">
          ${hiddenInputs(done)}
          <button type="submit">Continue</button>
        </form>`
      ),
      200,
      formTargets
    );
  }

  async function callback(url: URL): Promise<Response> {
    const state = open<LinkState>('state', url.searchParams.get('state'));
    if (!state) {
      return errorResponse(
        'Sign-in expired',
        'This sign-in is unknown or took too long. Start again from your client.',
        400
      );
    }

    const failure = url.searchParams.get('error');
    if (failure) {
      const reason = url.searchParams.get('error_description') ?? failure;
      // Declining a second administration keeps the ones already approved.
      if (state.a.length > 0) {
        return linkedPage(state, `Moneybird added nothing: ${reason}`);
      }
      return errorResponse('Moneybird refused the sign-in', reason, 400);
    }
    const code = url.searchParams.get('code');
    if (!code) {
      return errorResponse(
        'Sign-in failed',
        'Moneybird sent no code. Start again from your client.',
        400
      );
    }

    let account: LinkedAccount;
    try {
      const tokens = await options.moneybird.exchangeCode({
        code,
        redirectUri,
        codeVerifier: ''
      });
      account = accountFrom(
        tokens,
        await options.administrationsOf(tokens.accessToken)
      );
    } catch (error) {
      return errorResponse(
        'Could not finish signing in to Moneybird',
        error instanceof Error ? error.message : String(error),
        502
      );
    }
    if (account.administrations.length === 0) {
      return errorResponse(
        'No administration',
        'This Moneybird approval reaches no administration.',
        400
      );
    }

    const ids = new Set(account.administrations.map((entry) => entry.id));
    const overlaps = (candidate: LinkedAccount): boolean =>
      candidate.administrations.some((entry) => ids.has(entry.id));
    const again = state.a.some(overlaps);
    const next: LinkState = {
      ...state,
      // A newer approval for the same administration replaces the older one.
      a: [...state.a.filter((candidate) => !overlaps(candidate)), account]
    };
    return linkedPage(
      next,
      again
        ? `${account.administrations.map(nameOf).join(', ')} was already linked. To add another administration, pick it on Moneybird's screen.`
        : undefined
    );
  }

  const upstream: OAuthUpstream = {
    authorizeUrl: ({ state, codeChallenge }) =>
      moneybirdUrl({ s: state, c: codeChallenge, a: [] }),

    exchangeCode: ({ code, codeVerifier }) => {
      const done = open<DoneCode>('code', code);
      if (!done) {
        return Promise.reject(
          new UpstreamError(
            'This sign-in is unknown or took too long. Start again.'
          )
        );
      }
      if (done.c !== challengeOf(codeVerifier)) {
        return Promise.reject(
          new UpstreamError('This sign-in belongs to another attempt.')
        );
      }
      return Promise.resolve(tokensOf(done.a));
    },

    refresh: async (refreshToken) => {
      const refresh = options.moneybird.refresh?.bind(options.moneybird);
      const accounts = decodeAccounts(refreshToken);
      // Connections made before linking hold a plain Moneybird refresh token.
      if (!accounts) {
        if (!refresh) throw new UpstreamError('Sign in again.');
        return refresh(refreshToken);
      }
      const renewed: LinkedAccount[] = [];
      for (const account of accounts) {
        if (
          account.expiresAt === undefined ||
          account.expiresAt - REFRESH_LEEWAY_MS > now()
        ) {
          renewed.push(account);
          continue;
        }
        if (!account.refreshToken || !refresh) {
          throw new UpstreamError(
            'The Moneybird sign-in expired. Sign in again.'
          );
        }
        const tokens = await refresh(account.refreshToken);
        renewed.push(
          accountFrom(
            {
              ...tokens,
              refreshToken: tokens.refreshToken ?? account.refreshToken
            },
            account.administrations
          )
        );
      }
      return tokensOf(renewed);
    }
  };

  return {
    upstream,
    redirectUri,
    pages: async (request) => {
      const url = new URL(request.url);
      if (url.pathname !== path || request.method !== 'GET') return undefined;
      return callback(url);
    }
  };
}
