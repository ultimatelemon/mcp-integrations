import { pino } from 'pino';
import { loadConfig } from './config.ts';
import { startGateway } from './gateway.ts';

async function main(): Promise<void> {
  // Only fields this code builds are logged: no headers, bodies or tokens.
  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    base: { service: 'mcp-gateway' }
  });
  const config = loadConfig(process.env);
  const gateway = await startGateway(
    config,
    {
      port: Number(process.env['PORT'] ?? 3000),
      host: process.env['HOST'] ?? '0.0.0.0'
    },
    { logger }
  );
  logger.info(
    {
      url: gateway.url,
      routes: config.routes.map(({ key, path }) => ({ key, path }))
    },
    'gateway listening'
  );

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'shutting down');
    gateway.close().then(
      () => process.exit(0),
      () => process.exit(1)
    );
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
