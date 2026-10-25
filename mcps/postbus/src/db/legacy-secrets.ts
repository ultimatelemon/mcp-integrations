import { createDecipheriv } from 'node:crypto';
import { existsSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { PostbusError } from '../types.js';
import { sealSecret } from './secrets.js';

// Up to 0.2.0 secrets were sealed under MASTER_KEY by a helper of our own.
// Startup rewrites them under ENCRYPTION_KEY; remove this file and MASTER_KEY
// in a release after every deployment has started once on 0.3.0.
const LEGACY = /^enc:v([12]):([^:]+):([^:]+):([^:]+)$/;

function masterKey(): Buffer {
  const raw = process.env.MASTER_KEY?.trim();
  if (!raw || !/^[0-9a-f]{64}$/i.test(raw)) {
    throw new PostbusError(
      'The database still holds secrets sealed under MASTER_KEY, and MASTER_KEY is missing or not 64 hex characters.',
      'Keep the old MASTER_KEY set next to ENCRYPTION_KEY for this first start, so they can be moved over.',
      'config'
    );
  }
  return Buffer.from(raw, 'hex');
}

function openLegacy(sealed: string, context: string, key: Buffer): string {
  const match = LEGACY.exec(sealed);
  if (!match) throw new Error('not a legacy secret');
  const [, version, iv = '', tag = '', data = ''] = match;

  const decipher = createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(iv, 'base64')
  );
  // v1 predates binding the secret to its row.
  if (version === '2') decipher.setAAD(Buffer.from(context, 'utf8'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(data, 'base64')),
    decipher.final()
  ]).toString('utf8');
}

interface LegacyRow {
  id: string;
  user_id: string;
  alias: string;
  encrypted_password: string;
}

/** Returns how many secrets were moved over. */
export function migrateLegacySecrets(
  db: Database.Database,
  databasePath: string
): number {
  const rows = db
    .prepare<[], LegacyRow>(
      `SELECT id, user_id, alias, encrypted_password FROM mail_accounts
       WHERE encrypted_password LIKE 'enc:v%'`
    )
    .all();
  if (rows.length === 0) return 0;

  const key = masterKey();
  const resealed = rows.map((row) => {
    try {
      const value = openLegacy(
        row.encrypted_password,
        `${row.user_id}:${row.id}`,
        key
      );
      return { id: row.id, sealed: sealSecret(value, row.user_id, row.id) };
    } catch {
      throw new PostbusError(
        `The secret of mailbox "${row.alias}" does not open with MASTER_KEY.`,
        'Set the MASTER_KEY it was stored with, or remove the mailbox from the database.',
        'config'
      );
    }
  });

  // A copy as it was, in case ENCRYPTION_KEY gets lost before anyone notices.
  const backup = `${databasePath}.before-encryption-key`;
  if (databasePath !== ':memory:' && !existsSync(backup)) {
    db.prepare('VACUUM INTO ?').run(backup);
  }

  const update = db.prepare(
    'UPDATE mail_accounts SET encrypted_password = ? WHERE id = ?'
  );
  db.transaction(() => {
    for (const row of resealed) update.run(row.sealed, row.id);
  })();
  return resealed.length;
}
