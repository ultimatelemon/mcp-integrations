import { z } from 'zod';

/** Tool groups that can be enabled independently, mirroring the Moneybird API's own domains. */
export const TOOLSETS = [
  'core',
  'invoicing',
  'purchases',
  'banking',
  'time',
  'reports',
  'assets',
  'tasks',
  'webhooks'
] as const;

export const Toolset = z.enum(TOOLSETS);
export type Toolset = z.infer<typeof Toolset>;

/** Full toolsets enabled by default. Essential tools and `moneybird_api` are always there. */
export const DEFAULT_TOOLSETS: readonly Toolset[] = [];

export const ServerConfig = z.object({
  administrationId: z.string().optional(),
  baseUrl: z.string().url().optional(),
  timeZone: z.string().optional(),
  toolsets: z.array(Toolset),
  allowWrite: z.boolean(),
  allowDelete: z.boolean(),
  requestTimeoutMs: z.number().int().positive(),
  maxRetries: z.number().int().min(0)
});
export type ServerConfig = z.infer<typeof ServerConfig>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** Accepts `all`, `none`, or a comma-separated list; `-name` removes one from the defaults. */
export function resolveToolsets(raw: string | undefined): Toolset[] {
  const entries = parseList(raw);
  if (entries.length === 0) return [...DEFAULT_TOOLSETS];

  const normalised = entries.map((entry) => entry.toLowerCase());
  if (normalised.includes('all')) return [...TOOLSETS];

  const selected = new Set<Toolset>(
    normalised.some((entry) => entry.startsWith('-')) ? DEFAULT_TOOLSETS : []
  );

  for (const entry of normalised) {
    if (entry === 'none') {
      selected.clear();
      continue;
    }
    const removing = entry.startsWith('-');
    const name = removing ? entry.slice(1) : entry;
    const parsed = Toolset.safeParse(name);
    if (!parsed.success) {
      throw new ConfigError(
        `Unknown toolset "${name}". Valid toolsets: ${TOOLSETS.join(', ')} (or "all").`
      );
    }
    if (removing) selected.delete(parsed.data);
    else selected.add(parsed.data);
  }

  return TOOLSETS.filter((toolset) => selected.has(toolset));
}

/** Server-wide defaults from the environment; each caller can override them with headers. */
export function configFromEnv(
  env: NodeJS.ProcessEnv = process.env
): ServerConfig {
  const config: ServerConfig = {
    ...(env['MONEYBIRD_ADMINISTRATION_ID']
      ? { administrationId: env['MONEYBIRD_ADMINISTRATION_ID'] }
      : {}),
    ...(env['MONEYBIRD_BASE_URL']
      ? { baseUrl: env['MONEYBIRD_BASE_URL'] }
      : {}),
    ...(env['MONEYBIRD_TIME_ZONE']
      ? { timeZone: env['MONEYBIRD_TIME_ZONE'] }
      : {}),
    toolsets: resolveToolsets(env['MONEYBIRD_TOOLSETS']),
    allowWrite: parseBoolean(env['MONEYBIRD_ALLOW_WRITE'], false),
    allowDelete: parseBoolean(env['MONEYBIRD_ALLOW_DELETE'], false),
    requestTimeoutMs: parseInteger(env['MONEYBIRD_REQUEST_TIMEOUT_MS'], 30_000),
    maxRetries: parseInteger(env['MONEYBIRD_MAX_RETRIES'], 3)
  };
  return ServerConfig.parse(config);
}

export const ACCESS_LEVELS = ['read', 'write', 'delete'] as const;
export type AccessLevel = (typeof ACCESS_LEVELS)[number];

export const CALLER_HEADERS = {
  access: 'x-moneybird-access',
  toolsets: 'x-moneybird-toolsets',
  administration: 'x-moneybird-administration'
} as const;

export interface CallerConfig {
  config: ServerConfig;
  /** Header values that were ignored, for the model to relay to the user. */
  warnings: string[];
}

/**
 * Applies one caller's headers on top of the server defaults. A bad value is ignored rather than
 * failing the request, so a typo in a connector setting still leaves a working server.
 */
export function callerConfig(
  defaults: ServerConfig,
  headers: Headers
): CallerConfig {
  const config: ServerConfig = { ...defaults };
  const warnings: string[] = [];

  const access = headers.get(CALLER_HEADERS.access)?.trim().toLowerCase();
  if (access) {
    if ((ACCESS_LEVELS as readonly string[]).includes(access)) {
      config.allowWrite = access !== 'read';
      config.allowDelete = access === 'delete';
    } else {
      warnings.push(
        `Ignored X-Moneybird-Access "${access}"; use one of ${ACCESS_LEVELS.join(', ')}.`
      );
    }
  }

  const toolsets = headers.get(CALLER_HEADERS.toolsets);
  if (toolsets?.trim()) {
    try {
      config.toolsets = resolveToolsets(toolsets);
    } catch (error) {
      warnings.push(
        `Ignored X-Moneybird-Toolsets: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  const administration = headers.get(CALLER_HEADERS.administration)?.trim();
  if (administration) config.administrationId = administration;

  return { config, warnings };
}

/** Deleting is gated behind its own flag, so `allowWrite` alone never permits destruction. */
export function permissionsFor(config: ServerConfig): {
  write: boolean;
  destroy: boolean;
} {
  return {
    write: config.allowWrite,
    destroy: config.allowWrite && config.allowDelete
  };
}
