import type { McpHttpServer } from '@ultimatelemon-eu/mcp-http';
import { BASE_PATH, HOST, PORT } from './config.js';
import { closeDb, databasePath, getDb } from './db/index.js';
import { migrateLegacySecrets } from './db/legacy-secrets.js';
import { assertEncryptionKey } from './db/secrets.js';
import { logEvent } from './log.js';
import { closeAllConnections } from './providers/imap/connection.js';
import { gmailApiEnabled } from './providers/gmail/auth.js';
import { startServer } from './server.js';

// Docker sends SIGKILL ten seconds after SIGTERM. Give up before that so the
// database still gets closed rather than being killed mid-checkpoint.
const SHUTDOWN_GRACE_MS = 8_000;

export async function main(): Promise<void> {
  assertEncryptionKey();
  const migrated = migrateLegacySecrets(getDb(), databasePath());
  if (migrated > 0) logEvent({ event: 'secrets_migrated', count: migrated });

  const http = await startServer({
    port: PORT,
    host: HOST,
    basePath: BASE_PATH
  });
  logEvent({
    event: 'started',
    url: http.url,
    database: databasePath(),
    gmailApi: gmailApiEnabled()
  });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => void shutdown(http, signal));
  }

  // An unhandled rejection kills the process by default, taking the reason
  // with it. Log it, then let the same orderly shutdown run.
  process.on('unhandledRejection', (reason) => {
    logEvent({ event: 'unhandled_rejection', error: String(reason) });
    void shutdown(http, 'unhandledRejection', 1);
  });
}

async function shutdown(
  http: McpHttpServer,
  reason: string,
  code = 0
): Promise<void> {
  logEvent({ event: 'shutting_down', reason });

  const giveUp = setTimeout(() => {
    logEvent({ event: 'shutdown_timeout' });
    process.exit(code || 1);
  }, SHUTDOWN_GRACE_MS);
  giveUp.unref();

  // Without awaiting these the LOGOUT never left the socket and the mail
  // server held the session open until its own timeout.
  await Promise.allSettled([http.close(), closeAllConnections()]);
  closeDb();

  clearTimeout(giveUp);
  process.exit(code);
}
