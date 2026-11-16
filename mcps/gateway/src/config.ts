import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { z } from 'zod';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const RESERVED_PATHS = new Set(['/healthz', '/.well-known', '/mcp']);

const httpUrl = z.url({ protocol: /^https?$/ });

const routeSchema = z.strictObject({
  path: z
    .string()
    .regex(/^\/[a-z0-9][a-z0-9-]*$/, 'one lowercase segment, e.g. /garmin')
    .refine((path) => !RESERVED_PATHS.has(path), 'is reserved'),
  upstream: httpUrl,
  upstreamTokenEnv: z.string().regex(ENV_NAME, 'an env var name'),
  name: z.string().trim().min(1),
  allowedSubjects: z.array(z.string().min(1)).min(1)
});

const fileSchema = z.strictObject({
  subjects: z.record(
    z.string().regex(/^[a-z][a-z0-9-]*$/),
    z.string().regex(ENV_NAME, 'an env var name')
  ),
  routes: z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), routeSchema)
});

export type RoutesFile = z.infer<typeof fileSchema>;

export interface Route {
  key: string;
  path: string;
  name: string;
  upstream: string;
  upstreamToken: string;
  allowedSubjects: ReadonlySet<string>;
}

export interface GatewayConfig {
  /** Public origin without a path, e.g. https://mcp.ultimatelemon.eu. */
  publicUrl: string;
  oidc: { issuer: string; clientId: string; clientSecret: string };
  routes: Route[];
}

const GATEWAY_ENV = [
  'PUBLIC_URL',
  'ENCRYPTION_KEY',
  'GATEWAY_OIDC_ISSUER',
  'GATEWAY_OIDC_CLIENT_ID',
  'GATEWAY_OIDC_CLIENT_SECRET'
] as const;

/** `garmin` -> `GARMIN_UPSTREAM_URL`: overrides the route's upstream, for local development. */
export function upstreamOverrideEnv(key: string): string {
  return `${key.toUpperCase().replaceAll('-', '_')}_UPSTREAM_URL`;
}

export function parseRoutesFile(text: string): RoutesFile {
  const result = fileSchema.safeParse(parse(text));
  if (!result.success) {
    throw new ConfigError(
      `Invalid routes file: ${result.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')}`
    );
  }
  const file = result.data;
  const seen = new Set<string>();
  for (const [key, route] of Object.entries(file.routes)) {
    if (seen.has(route.path)) {
      throw new ConfigError(`Route ${key}: path ${route.path} is used twice.`);
    }
    seen.add(route.path);
    const unknown = route.allowedSubjects.filter(
      (name) => !(name in file.subjects)
    );
    if (unknown.length > 0) {
      throw new ConfigError(
        `Route ${key}: unknown subjects ${unknown.join(', ')}; add them under subjects.`
      );
    }
  }
  if (seen.size === 0) throw new ConfigError('The routes file has no routes.');
  return file;
}

/** Resolves the file against the environment; every missing variable is named at once. */
export function resolveConfig(
  file: RoutesFile,
  env: NodeJS.ProcessEnv
): GatewayConfig {
  const missing = new Set<string>();
  const read = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) missing.add(name);
    return value ?? '';
  };

  const gateway = Object.fromEntries(
    GATEWAY_ENV.map((name) => [name, read(name)])
  ) as Record<(typeof GATEWAY_ENV)[number], string>;

  const routes = Object.entries(file.routes).map(([key, route]): Route => {
    const override = env[upstreamOverrideEnv(key)]?.trim();
    if (override && !httpUrl.safeParse(override).success) {
      throw new ConfigError(
        `${upstreamOverrideEnv(key)} must be an http(s) URL.`
      );
    }
    return {
      key,
      path: route.path,
      name: route.name,
      upstream: override || route.upstream,
      upstreamToken: read(route.upstreamTokenEnv),
      allowedSubjects: new Set(
        route.allowedSubjects.map((name) => read(file.subjects[name] ?? ''))
      )
    };
  });

  if (missing.size > 0) {
    throw new ConfigError(
      `Missing environment variables: ${[...missing].sort().join(', ')}`
    );
  }
  if (!httpUrl.safeParse(gateway.PUBLIC_URL).success) {
    throw new ConfigError('PUBLIC_URL must be an http(s) URL.');
  }
  return {
    publicUrl: gateway.PUBLIC_URL.replace(/\/+$/, ''),
    oidc: {
      issuer: gateway.GATEWAY_OIDC_ISSUER,
      clientId: gateway.GATEWAY_OIDC_CLIENT_ID,
      clientSecret: gateway.GATEWAY_OIDC_CLIENT_SECRET
    },
    routes
  };
}

export function loadConfig(
  env: NodeJS.ProcessEnv,
  file: URL = new URL('../routes.yaml', import.meta.url)
): GatewayConfig {
  return resolveConfig(parseRoutesFile(readFileSync(file, 'utf8')), env);
}
