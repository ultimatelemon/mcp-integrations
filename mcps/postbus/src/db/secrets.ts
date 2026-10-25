import { decrypt, encrypt } from '@ultimatelemon-eu/crypto';
import { PostbusError } from '../types.js';

// The row id never changes once written, not even when a mailbox is relinked,
// so a sealed secret opens in its own row and nowhere else.
function context(userId: string, accountId: string): string {
  return `${userId}:${accountId}`;
}

export function sealSecret(
  value: string,
  userId: string,
  accountId: string
): string {
  return encrypt(value, { context: context(userId, accountId) });
}

export function openSecret(
  sealed: string,
  userId: string,
  accountId: string
): string {
  try {
    return decrypt(sealed, { context: context(userId, accountId) });
  } catch {
    throw new PostbusError(
      'Decryption failed.',
      'ENCRYPTION_KEY differs from the key this mailbox was stored with. ' +
        'Restore the old key, or remove the mailbox and add it again.',
      'config'
    );
  }
}

// Fail at startup, not halfway through someone's first tool call.
export function assertEncryptionKey(): void {
  try {
    decrypt(encrypt('check'));
  } catch (error) {
    throw new PostbusError(
      `ENCRYPTION_KEY is not usable: ${error instanceof Error ? error.message : String(error)}.`,
      'Generate one with `openssl rand -base64 32`. Without it, stored app passwords can be neither written nor read.',
      'config'
    );
  }
}
