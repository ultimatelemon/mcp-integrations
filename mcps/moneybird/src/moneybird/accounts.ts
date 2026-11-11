import { MoneybirdError } from './errors.ts';

/**
 * A Moneybird OAuth approval covers the one administration picked on Moneybird's consent
 * screen, so a connection that reaches several holds one token per approval. They travel
 * together as a single upstream token, which mcp-http seals inside the access token it issues.
 */
export const LINKED_PREFIX = 'mbl1.';

export interface LinkedAdministration {
  id: string;
  name?: string;
}

export interface LinkedAccount {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds; unset when Moneybird did not say. */
  expiresAt?: number;
  administrations: LinkedAdministration[];
}

interface Encoded {
  t: string;
  r?: string;
  x?: number;
  a: Array<{ i: string; n?: string }>;
}

/** The access side leaves refresh tokens out; the refresh side carries everything. */
export function encodeAccounts(
  accounts: readonly LinkedAccount[],
  { withRefresh }: { withRefresh: boolean }
): string {
  const encoded: Encoded[] = accounts.map((account) => ({
    t: account.accessToken,
    ...(withRefresh && account.refreshToken ? { r: account.refreshToken } : {}),
    ...(withRefresh && account.expiresAt !== undefined
      ? { x: account.expiresAt }
      : {}),
    a: account.administrations.map((administration) => ({
      i: administration.id,
      ...(administration.name ? { n: administration.name } : {})
    }))
  }));
  return (
    LINKED_PREFIX + Buffer.from(JSON.stringify(encoded)).toString('base64url')
  );
}

function isEncoded(value: unknown): value is Encoded {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['t'] === 'string' &&
    (entry['r'] === undefined || typeof entry['r'] === 'string') &&
    (entry['x'] === undefined || typeof entry['x'] === 'number') &&
    Array.isArray(entry['a']) &&
    entry['a'].every(
      (administration: unknown) =>
        typeof administration === 'object' &&
        administration !== null &&
        typeof (administration as Record<string, unknown>)['i'] === 'string'
    )
  );
}

/** Undefined when `value` is not a bundle, such as a personal API token. */
export function decodeAccounts(value: string): LinkedAccount[] | undefined {
  if (!value.startsWith(LINKED_PREFIX)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      Buffer.from(value.slice(LINKED_PREFIX.length), 'base64url').toString()
    );
  } catch {
    return undefined;
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined;
  if (!parsed.every(isEncoded)) return undefined;
  return parsed.map((entry) => ({
    accessToken: entry.t,
    ...(entry.r ? { refreshToken: entry.r } : {}),
    ...(entry.x !== undefined ? { expiresAt: entry.x } : {}),
    administrations: entry.a.map((administration) => ({
      id: administration.i,
      ...(administration.n ? { name: administration.n } : {})
    }))
  }));
}

/** The accounts behind a caller's token: a bundle from the sign-in, or one plain token. */
export function accountsOf(token: string): LinkedAccount[] {
  return decodeAccounts(token) ?? [{ accessToken: token, administrations: [] }];
}

export function linkedAdministrations(
  accounts: readonly LinkedAccount[]
): LinkedAdministration[] {
  return accounts.flatMap((account) => account.administrations);
}

/**
 * Picks the token for an administration. One account answers for everything, as a personal
 * token reaches every administration of its user; with several, an administration none of
 * them covers fails here instead of as a confusing 403 from Moneybird.
 */
export function tokenFor(
  accounts: readonly LinkedAccount[],
  administrationId: string | undefined
): string {
  const [first] = accounts;
  if (!first) throw new Error('No Moneybird token.');
  if (accounts.length === 1 || administrationId === undefined) {
    return first.accessToken;
  }
  const account = accounts.find((candidate) =>
    candidate.administrations.some(
      (administration) => administration.id === administrationId
    )
  );
  if (account) return account.accessToken;
  const linked = linkedAdministrations(accounts)
    .map((administration) => administration.id)
    .join(', ');
  throw new MoneybirdError(
    `Administration ${administrationId} is not linked to this connection (linked: ${linked}). ` +
      'Reconnect the connector and approve that administration too.',
    { status: 0, method: 'GET', url: '' }
  );
}
