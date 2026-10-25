import { createCipheriv, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAccount, saveImapAccount } from '../../src/db/accounts.js';
import { closeDb, getDb } from '../../src/db/index.js';
import { migrateLegacySecrets } from '../../src/db/legacy-secrets.js';
import { createUser } from '../../src/db/users.js';
import type { ImapAccount } from '../../src/types.js';

const MASTER_KEY = process.env.MASTER_KEY as string;

// The format postbus 0.2.0 wrote: v2 binds the row, v1 does not.
function sealLegacy(value: string, context: string, version: 1 | 2): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    'aes-256-gcm',
    Buffer.from(MASTER_KEY, 'hex'),
    iv
  );
  if (version === 2) cipher.setAAD(Buffer.from(context, 'utf8'));
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return `enc:v${version}:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${data.toString('base64')}`;
}

function legacyMailbox(alias: string, password: string, version: 1 | 2) {
  const { user } = createUser('legacy');
  const saved = saveImapAccount({
    userId: user.id,
    alias,
    email: `${alias}@example.com`,
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true,
    username: `${alias}@example.com`,
    password: 'replaced below'
  });
  getDb()
    .prepare('UPDATE mail_accounts SET encrypted_password = ? WHERE id = ?')
    .run(sealLegacy(password, `${user.id}:${saved.id}`, version), saved.id);
  return user.id;
}

function storedSecrets(): string[] {
  return getDb()
    .prepare<[], { encrypted_password: string }>(
      'SELECT encrypted_password FROM mail_accounts'
    )
    .all()
    .map((row) => row.encrypted_password);
}

beforeEach(() => {
  closeDb();
  getDb();
});

afterEach(() => {
  process.env.MASTER_KEY = MASTER_KEY;
});

describe('migrateLegacySecrets', () => {
  it('reseals v1 and v2 secrets under ENCRYPTION_KEY', () => {
    const first = legacyMailbox('work', 'pw-work', 2);
    const second = legacyMailbox('old', 'pw-old', 1);

    expect(migrateLegacySecrets(getDb(), ':memory:')).toBe(2);

    expect(storedSecrets().every((value) => value.startsWith('v1.'))).toBe(
      true
    );
    expect((getAccount(first, 'work') as ImapAccount).password).toBe('pw-work');
    expect((getAccount(second, 'old') as ImapAccount).password).toBe('pw-old');
  });

  it('does nothing, and needs no MASTER_KEY, once everything is moved', () => {
    legacyMailbox('work', 'pw-work', 2);
    migrateLegacySecrets(getDb(), ':memory:');
    delete process.env.MASTER_KEY;

    expect(migrateLegacySecrets(getDb(), ':memory:')).toBe(0);
  });

  it('refuses to start without MASTER_KEY while legacy secrets remain', () => {
    legacyMailbox('work', 'pw-work', 2);
    delete process.env.MASTER_KEY;

    expect(() => migrateLegacySecrets(getDb(), ':memory:')).toThrow(
      /MASTER_KEY is missing/
    );
  });

  it('changes nothing when one secret does not open', () => {
    legacyMailbox('work', 'pw-work', 2);
    process.env.MASTER_KEY = 'f'.repeat(64);
    const before = storedSecrets();

    expect(() => migrateLegacySecrets(getDb(), ':memory:')).toThrow(
      /does not open with MASTER_KEY/
    );
    expect(storedSecrets()).toEqual(before);
  });
});
