import {
  oauth2Upstream,
  type OAuthOptions,
  type SettingsForm
} from '@ultimatelemon-eu/mcp-http';
import {
  CALLER_HEADERS,
  ConfigError,
  DEFAULT_TOOLSETS,
  TOOLSETS
} from '../config/schema.ts';
import { MoneybirdClient, type Limiters } from '../moneybird/client.ts';

export const AUTHORIZE_URL = 'https://moneybird.com/oauth/authorize';
export const TOKEN_URL = 'https://moneybird.com/oauth/token';

export const OAUTH_SCOPES = [
  'sales_invoices',
  'documents',
  'estimates',
  'bank',
  'time_entries',
  'settings'
] as const;

interface Administration {
  id: string | number;
  name?: string;
  country?: string;
  currency?: string;
}

export interface MoneybirdOAuthDeps {
  limiters: Limiters;
  baseUrl?: string | undefined;
  fetch?: typeof globalThis.fetch;
}

async function settingsForm(
  token: string,
  deps: MoneybirdOAuthDeps
): Promise<SettingsForm> {
  const client = new MoneybirdClient({
    token,
    limiters: deps.limiters,
    maxRetries: 1,
    ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {})
  });
  const { data } = await client.get<Administration[]>('administrations', {
    administrationScoped: false
  });
  const administrations = Array.isArray(data) ? data : [];

  return {
    title: 'Connect Moneybird',
    intro:
      'These settings apply to this connection. Request headers, when your client sends them, take precedence.',
    fields: [
      {
        name: 'administration',
        label: 'Default administration',
        hint: 'Used when a request does not name one. All administrations stay reachable.',
        options: [
          ...administrations.map((administration) => ({
            value: String(administration.id),
            label: administration.name ?? String(administration.id),
            hint:
              [administration.country, administration.currency]
                .filter(Boolean)
                .join(' · ') || String(administration.id)
          })),
          { value: '', label: 'No default' }
        ]
      },
      {
        name: 'access',
        label: 'Access',
        options: [
          { value: 'read', label: 'Read', hint: 'Look things up only.' },
          {
            value: 'write',
            label: 'Write',
            hint: 'Also create and change records.'
          },
          {
            value: 'delete',
            label: 'Delete',
            hint: 'Also delete, send invoices and register payments.'
          }
        ]
      },
      {
        name: 'toolsets',
        label: 'Extra toolsets',
        hint: 'Everyday tools are always on. Each set adds the rest of that area, at the cost of context.',
        multiple: true,
        defaults: [...DEFAULT_TOOLSETS],
        options: TOOLSETS.map((toolset) => ({
          value: toolset,
          label: toolset
        }))
      }
    ]
  };
}

/** OAuth sign-in when MONEYBIRD_CLIENT_ID and MONEYBIRD_CLIENT_SECRET are set. */
export function moneybirdOAuth(
  env: NodeJS.ProcessEnv,
  deps: MoneybirdOAuthDeps
): OAuthOptions | undefined {
  const clientId = env['MONEYBIRD_CLIENT_ID'];
  const clientSecret = env['MONEYBIRD_CLIENT_SECRET'];
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new ConfigError(
      'Set both MONEYBIRD_CLIENT_ID and MONEYBIRD_CLIENT_SECRET, or neither.'
    );
  }
  const publicUrl = env['PUBLIC_URL'];
  if (!publicUrl) {
    throw new ConfigError('PUBLIC_URL is required for the OAuth sign-in.');
  }
  return {
    publicUrl,
    name: 'Moneybird',
    upstream: oauth2Upstream({
      authorizeUrl: AUTHORIZE_URL,
      tokenUrl: TOKEN_URL,
      clientId,
      clientSecret,
      scopes: OAUTH_SCOPES,
      ...(deps.fetch ? { fetch: deps.fetch } : {})
    }),
    settings: (token) => settingsForm(token, deps)
  };
}

/** The settings chosen at sign-in, as caller headers; headers the client sends win. */
export function connectionHeaders(
  settings: Record<string, string> | undefined,
  headers: Headers
): Headers {
  const merged = new Headers();
  if (settings) {
    for (const [name, header] of Object.entries(CALLER_HEADERS)) {
      const value = settings[name];
      if (value) merged.set(header, value);
      else if (name === 'toolsets' && value === '') merged.set(header, 'none');
    }
  }
  headers.forEach((value, name) => {
    merged.set(name, value);
  });
  return merged;
}
