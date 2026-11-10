import { randomToken } from '@ultimatelemon-eu/crypto';
import { getDb } from './index.js';
import { hashToken, newId } from './users.js';

export const LINK_TTL_MS = 10 * 60 * 1000;
export const MAX_LINK_ATTEMPTS = 5;

export interface NewLinkRequest {
  userId: string;
  alias: string;
  email: string;
  displayName?: string | undefined;
  username: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
}

export interface LinkRequest extends NewLinkRequest {
  id: string;
  attempts: number;
  expiresAt: string;
}

interface LinkRow {
  id: string;
  user_id: string;
  alias: string;
  email: string;
  display_name: string | null;
  username: string;
  imap_host: string;
  imap_port: number;
  imap_secure: number;
  smtp_host: string;
  smtp_port: number;
  smtp_secure: number;
  attempts: number;
  expires_at: string;
}

function toRequest(row: LinkRow): LinkRequest {
  return {
    id: row.id,
    userId: row.user_id,
    alias: row.alias,
    email: row.email,
    displayName: row.display_name ?? undefined,
    username: row.username,
    imapHost: row.imap_host,
    imapPort: row.imap_port,
    imapSecure: row.imap_secure === 1,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecure: row.smtp_secure === 1,
    attempts: row.attempts,
    expiresAt: row.expires_at
  };
}

// Only the hash is stored, like the API tokens: the link itself is the secret.
export function createLinkRequest(
  input: NewLinkRequest,
  now = new Date()
): { token: string; expiresAt: string } {
  const db = getDb();
  const token = randomToken();
  const expiresAt = new Date(now.getTime() + LINK_TTL_MS).toISOString();

  db.transaction(() => {
    // A newer link for the same alias replaces the older one, so only the link
    // Claude handed out last can still store a password.
    db.prepare(
      `DELETE FROM link_requests
       WHERE (user_id = ? AND alias = ?) OR used_at IS NOT NULL OR expires_at <= ?`
    ).run(input.userId, input.alias, now.toISOString());

    db.prepare(
      `INSERT INTO link_requests (
         id, user_id, token_hash, alias, email, display_name, username,
         imap_host, imap_port, imap_secure, smtp_host, smtp_port, smtp_secure,
         expires_at, created_at
       ) VALUES (
         @id, @userId, @tokenHash, @alias, @email, @displayName, @username,
         @imapHost, @imapPort, @imapSecure, @smtpHost, @smtpPort, @smtpSecure,
         @expiresAt, @createdAt
       )`
    ).run({
      ...input,
      id: newId(),
      tokenHash: hashToken(token),
      displayName: input.displayName ?? null,
      imapSecure: input.imapSecure ? 1 : 0,
      smtpSecure: input.smtpSecure ? 1 : 0,
      expiresAt,
      createdAt: now.toISOString()
    });
  })();

  return { token, expiresAt };
}

// Unknown, expired, used up and disabled-user links all look the same from
// outside, so a link says nothing about whether it ever existed.
export function findLinkRequest(
  token: string,
  now = new Date()
): LinkRequest | undefined {
  const row = getDb()
    .prepare<[string, string, number], LinkRow>(
      `SELECT l.id, l.user_id, l.alias, l.email, l.display_name, l.username,
              l.imap_host, l.imap_port, l.imap_secure, l.smtp_host, l.smtp_port,
              l.smtp_secure, l.attempts, l.expires_at
       FROM link_requests l JOIN users u ON u.id = l.user_id
       WHERE l.token_hash = ? AND l.used_at IS NULL AND l.expires_at > ?
         AND l.attempts < ? AND u.disabled = 0`
    )
    .get(hashToken(token), now.toISOString(), MAX_LINK_ATTEMPTS);

  return row ? toRequest(row) : undefined;
}

// Counted before the mail server is contacted, in one statement, so parallel
// posts cannot share an attempt.
export function takeLinkAttempt(id: string, now = new Date()): boolean {
  return (
    getDb()
      .prepare(
        `UPDATE link_requests SET attempts = attempts + 1
         WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?`
      )
      .run(id, now.toISOString(), MAX_LINK_ATTEMPTS).changes > 0
  );
}

export function completeLinkRequest(id: string, now = new Date()): void {
  getDb()
    .prepare(`UPDATE link_requests SET used_at = ? WHERE id = ?`)
    .run(now.toISOString(), id);
}
