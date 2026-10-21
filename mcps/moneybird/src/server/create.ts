import { McpServer } from '@modelcontextprotocol/server';
import type { ServerConfig } from '../config/schema.ts';
import { permissionsFor } from '../config/schema.ts';
import { MoneybirdClient, type Limiters } from '../moneybird/client.ts';
import { allTools } from '../tools/index.ts';
import { registerTools, type RegistrationSummary } from '../tools/registry.ts';
import type { ToolDefinition } from '../tools/common.ts';

export const SERVER_NAME = 'moneybird';

export interface CreateServerOptions {
  config: ServerConfig;
  /** The caller's Moneybird API token. */
  token: string;
  /** Rate-limit budgets shared by every request in this process. */
  limiters?: Limiters;
  /** Lines added to the instructions, such as ignored header values. */
  notes?: readonly string[];
  /** Overrides the built-in tool set; used by tests. */
  tools?: readonly ToolDefinition[];
  version?: string;
  fetch?: typeof globalThis.fetch;
}

export interface CreatedServer {
  server: McpServer;
  client: MoneybirdClient;
  registration: RegistrationSummary;
}

function administrationLine(config: ServerConfig): string {
  return config.administrationId
    ? `Default administration: ${config.administrationId}. This is only a default: every ` +
        'administration the token can reach is still available, so pass administration_id ' +
        'to act on another one, and call list_administrations to see them.'
    : 'No default administration is set (header X-Moneybird-Administration) — call ' +
        'list_administrations first and pass administration_id.';
}

function instructionsFor(
  config: ServerConfig,
  notes: readonly string[]
): string {
  const permissions = permissionsFor(config);
  const mode = permissions.destroy
    ? 'read, write and delete'
    : permissions.write
      ? 'read and write (deleting is disabled)'
      : 'read-only (header X-Moneybird-Access enables write or delete)';

  return [
    'Tools for the Moneybird accounting API.',
    '',
    `Access: ${mode}.` +
      (config.toolsets.length > 0
        ? ` Full toolsets: ${config.toolsets.join(', ')}.`
        : ''),
    'For anything the tools do not cover, use find_moneybird_endpoint and moneybird_api.',
    administrationLine(config),
    ...notes,
    '',
    'Amounts are decimal strings and follow the administration currency. Dates are ISO 8601.',
    'Moneybird allows 150 requests per 5 minutes per IP (50 for reports), so prefer filters over ' +
      'paging through entire collections.'
  ].join('\n');
}

/** Builds the MCP server and the Moneybird client behind it for one caller. */
export function createMoneybirdServer(
  options: CreateServerOptions
): CreatedServer {
  const { config } = options;

  const client = new MoneybirdClient({
    token: options.token,
    administrationId: config.administrationId,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.timeZone ? { timeZone: config.timeZone } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.limiters ? { limiters: options.limiters } : {}),
    maxRetries: config.maxRetries,
    requestTimeoutMs: config.requestTimeoutMs,
    userAgent: `moneybird-mcp/${options.version ?? '0.0.0'}`
  });

  const server = new McpServer(
    { name: SERVER_NAME, version: options.version ?? '0.0.0' },
    { instructions: instructionsFor(config, options.notes ?? []) }
  );

  const registration = registerTools({
    server,
    definitions: options.tools ?? allTools,
    config,
    context: { client, config }
  });

  return { server, client, registration };
}
