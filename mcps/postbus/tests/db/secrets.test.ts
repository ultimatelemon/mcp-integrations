import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertEncryptionKey,
  openSecret,
  sealSecret
} from '../../src/db/secrets.js';
import { PostbusError } from '../../src/types.js';

const KEY = process.env.ENCRYPTION_KEY;

afterEach(() => {
  process.env.ENCRYPTION_KEY = KEY;
});

describe('sealSecret / openSecret', () => {
  it('round-trips, with a fresh IV every time', () => {
    const first = sealSecret('app-password', 'user1', 'account1');
    const second = sealSecret('app-password', 'user1', 'account1');

    expect(first).not.toBe(second);
    expect(first).not.toContain('app-password');
    expect(openSecret(first, 'user1', 'account1')).toBe('app-password');
  });

  it('does not open in another row', () => {
    const sealed = sealSecret('app-password', 'user1', 'account1');

    expect(() => openSecret(sealed, 'user2', 'account9')).toThrow(PostbusError);
    expect(() => openSecret(sealed, 'user1', 'account2')).toThrow(
      /Decryption failed/
    );
  });

  it('does not open under another key', () => {
    const sealed = sealSecret('app-password', 'user1', 'account1');
    process.env.ENCRYPTION_KEY = randomBytes(32).toString('base64');

    expect(() => openSecret(sealed, 'user1', 'account1')).toThrow(PostbusError);
  });
});

describe('assertEncryptionKey', () => {
  it('complains with a hint when the key is missing or malformed', () => {
    for (const key of [undefined, 'short']) {
      if (key === undefined) delete process.env.ENCRYPTION_KEY;
      else process.env.ENCRYPTION_KEY = key;

      try {
        assertEncryptionKey();
        expect.unreachable('should have thrown');
      } catch (error) {
        expect(error).toBeInstanceOf(PostbusError);
        expect((error as PostbusError).hint).toMatch(/openssl rand -base64 32/);
      }
    }
  });

  it('accepts a 32-byte key', () => {
    expect(() => assertEncryptionKey()).not.toThrow();
  });
});
