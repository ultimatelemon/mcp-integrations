import { readFileSync } from 'node:fs';
import { startMcpHttpServer } from '@ultimatelemon-eu/mcp-http';
import { pino } from 'pino';
import { callerConfig, configFromEnv } from './config/schema.ts';
import { createLimiters } from './moneybird/client.ts';
import { createMoneybirdServer } from './server/create.ts';
import { connectionHeaders, moneybirdOAuth } from './server/oauth.ts';

// src/ and dist/ both sit one level below package.json.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string };

const API_KEY_HINT =
  'Use your own personal Moneybird API token: https://moneybird.com/user/applications/new.';

async function main(): Promise<void> {
  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    base: { service: 'moneybird' },
    redact: ['headers']
  });
  const defaults = configFromEnv();
  const limiters = createLimiters();
  const oauth = moneybirdOAuth(process.env, {
    limiters,
    baseUrl: defaults.baseUrl
  });

  const http = await startMcpHttpServer({
    // mcp-http answers 401 before this runs when the caller sent no token.
    createMcpServer: ({ apiKey = '', headers, oauth: signedIn }) => {
      const { config, warnings } = callerConfig(
        defaults,
        connectionHeaders(signedIn?.settings, headers)
      );
      return createMoneybirdServer({
        config,
        token: apiKey,
        limiters,
        notes: warnings,
        version
      }).server;
    },
    port: Number(process.env['PORT'] ?? 3000),
    host: process.env['HOST'] ?? '0.0.0.0',
    basePath: process.env['BASE_PATH'] ?? '',
    apiKey: { hint: API_KEY_HINT },
    ...(oauth ? { oauth } : {}),
    logger
  });
  logger.info(
    { url: http.url, version, oauth: Boolean(oauth) },
    'moneybird listening'
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    http.close().then(
      () => process.exit(0),
      () => process.exit(1)
    );
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
