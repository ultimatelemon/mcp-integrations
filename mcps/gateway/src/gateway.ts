import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from 'node:http';
import {
  createOAuthHandler,
  oidcUpstream,
  UpstreamError,
  type OAuthHandler,
  type OAuthUpstream,
  type UpstreamTokens
} from '@ultimatelemon-eu/mcp-http/oauth';
import type { GatewayConfig, Route } from './config.ts';
import { jsonRpcError, sendJson, sendResponse, toRequest } from './http.ts';
import { proxy } from './proxy.ts';

/** Hosts whose Client ID Metadata Documents may sign in: Claude and the Mike assistant. */
export const TRUSTED_CLIENT_HOSTS = [
  'claude.ai',
  'assistent.studiosouf.com'
] as const;

export interface Logger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

const silent: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined
};

export interface GatewayOptions {
  /** For OIDC discovery, client metadata documents and the upstream calls. */
  fetch?: typeof globalThis.fetch;
  logger?: Logger;
}

interface MountedRoute {
  route: Route;
  oauth: OAuthHandler;
  mcpPaths: ReadonlySet<string>;
}

// Refusing at sign-in spares other users a token that only ever gets a 403.
function onlyFor(
  upstream: OAuthUpstream,
  route: Route,
  logger: Logger
): OAuthUpstream {
  const check = (tokens: UpstreamTokens, signIn: boolean): UpstreamTokens => {
    const subject = tokens.subject;
    if (subject === undefined && !signIn) return tokens;
    if (subject === undefined || !route.allowedSubjects.has(subject)) {
      logger.warn({ route: route.key, subject }, 'sign-in refused');
      throw new UpstreamError(
        `This account has no access to ${route.name} here.`
      );
    }
    return tokens;
  };
  const refresh = upstream.refresh?.bind(upstream);
  return {
    // claude.ai's client_id is shared by every claude.ai user, so a forwarded
    // authorize link must not complete on the owner's live Zitadel session.
    authorizeUrl: async (params) => {
      const url = new URL(await upstream.authorizeUrl(params));
      url.searchParams.set('prompt', 'login');
      return url.toString();
    },
    exchangeCode: async (params) =>
      check(await upstream.exchangeCode(params), true),
    ...(refresh
      ? { refresh: async (token: string) => check(await refresh(token), false) }
      : {})
  };
}

function bearerFrom(req: IncomingMessage): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
  return match?.[1]?.trim() || undefined;
}

export function createGatewayHandler(
  config: GatewayConfig,
  options: GatewayOptions = {}
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const logger = options.logger ?? silent;
  // One Zitadel app for every route; each route registers its own callback there.
  const zitadel = oidcUpstream({
    issuer: config.oidc.issuer,
    clientId: config.oidc.clientId,
    clientSecret: config.oidc.clientSecret,
    scopes: ['openid', 'offline_access'],
    fetch: fetchImpl
  });

  // Each route is its own issuer: tokens are sealed with the issuer inside, so
  // a token from one route does not open another under the same ENCRYPTION_KEY.
  const mounted: MountedRoute[] = config.routes.map((route) => ({
    route,
    oauth: createOAuthHandler(
      {
        publicUrl: config.publicUrl,
        name: route.name,
        upstream: onlyFor(zitadel, route, logger),
        clientIdMetadata: { trustedHosts: TRUSTED_CLIENT_HOSTS },
        registration: false,
        fetch: fetchImpl
      },
      route.path
    ),
    mcpPaths: new Set([route.path, `${route.path}/mcp`])
  }));

  async function serveMcp(
    req: IncomingMessage,
    res: ServerResponse,
    { route, oauth }: MountedRoute
  ): Promise<void> {
    const bearer = bearerFrom(req);
    if (!bearer) {
      jsonRpcError(res, 401, `Sign in to use ${route.name}.`, {
        'www-authenticate': oauth.challenge()
      });
      return;
    }
    const grant = oauth.authenticate(bearer);
    if (!grant) {
      jsonRpcError(res, 401, 'The access token is invalid or expired.', {
        'www-authenticate': oauth.challenge('invalid_token')
      });
      return;
    }
    if (!grant.subject || !route.allowedSubjects.has(grant.subject)) {
      logger.warn(
        { route: route.key, subject: grant.subject },
        'subject refused'
      );
      jsonRpcError(res, 403, `This account has no access to ${route.name}.`);
      return;
    }
    await proxy(
      req,
      res,
      {
        route: route.key,
        upstream: route.upstream,
        token: route.upstreamToken
      },
      fetchImpl,
      logger
    );
  }

  return async (req, res) => {
    const started = Date.now();
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/healthz' && req.method === 'GET') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    // The pathname only: callback queries carry codes and state.
    let routeKey: string | undefined;
    res.once('close', () => {
      logger.info(
        {
          route: routeKey,
          method: req.method,
          path,
          status: res.statusCode,
          ms: Date.now() - started,
          ...(res.writableFinished ? {} : { aborted: true })
        },
        'request'
      );
    });
    for (const entry of mounted) {
      if (entry.mcpPaths.has(path)) {
        routeKey = entry.route.key;
        await serveMcp(req, res, entry);
        return;
      }
      if (entry.oauth.owns(path)) {
        routeKey = entry.route.key;
        await sendResponse(res, await entry.oauth.handle(await toRequest(req)));
        return;
      }
    }
    sendJson(res, 404, { error: 'Not found' });
  };
}

export interface RunningGateway {
  server: Server;
  url: string;
  close(): Promise<void>;
}

export async function startGateway(
  config: GatewayConfig,
  listen: { port: number; host?: string },
  options: GatewayOptions = {}
): Promise<RunningGateway> {
  const logger = options.logger ?? silent;
  const handle = createGatewayHandler(config, options);
  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : 'unknown' },
        'request failed'
      );
      if (!res.headersSent) jsonRpcError(res, 500, 'Internal server error');
      else res.destroy();
    });
  });
  const host = listen.host ?? '0.0.0.0';
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const port =
    typeof address === 'object' && address ? address.port : listen.port;
  return {
    server,
    url: `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${String(port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Open SSE streams never go idle; cut them off after a grace period.
        const force = setTimeout(() => server.closeAllConnections(), 10_000);
        force.unref();
        server.close((error) => {
          clearTimeout(force);
          if (error) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      })
  };
}
