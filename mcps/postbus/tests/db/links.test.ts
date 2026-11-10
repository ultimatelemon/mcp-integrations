import { beforeEach, describe, expect, it } from 'vitest';
import { closeDb, getDb } from '../../src/db/index.js';
import {
  completeLinkRequest,
  createLinkRequest,
  findLinkRequest,
  LINK_TTL_MS,
  MAX_LINK_ATTEMPTS,
  takeLinkAttempt,
  type NewLinkRequest
} from '../../src/db/links.js';
import { createUser, deleteUser, setUserDisabled } from '../../src/db/users.js';

beforeEach(() => {
  closeDb();
  getDb();
});

function request(userId: string, alias = 'work'): NewLinkRequest {
  return {
    userId,
    alias,
    email: 'me@example.com',
    username: 'me@example.com',
    imapHost: 'imap.example.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.example.com',
    smtpPort: 465,
    smtpSecure: true
  };
}

describe('link requests', () => {
  it('finds a fresh link by its token and stores only a hash', () => {
    const { user } = createUser('a');
    const { token } = createLinkRequest(request(user.id));

    expect(findLinkRequest(token)).toMatchObject({
      userId: user.id,
      alias: 'work',
      imapHost: 'imap.example.com',
      attempts: 0
    });
    const stored = JSON.stringify(
      getDb().prepare('SELECT * FROM link_requests').all()
    );
    expect(stored).not.toContain(token);
  });

  it('stops working once expired', () => {
    const { user } = createUser('a');
    const now = new Date('2026-11-10T10:00:00Z');
    const { token } = createLinkRequest(request(user.id), now);

    expect(
      findLinkRequest(token, new Date(now.getTime() + LINK_TTL_MS - 1))
    ).toBeDefined();
    expect(
      findLinkRequest(token, new Date(now.getTime() + LINK_TTL_MS))
    ).toBeUndefined();
  });

  it('replaces an older link for the same alias, case-insensitively', () => {
    const { user } = createUser('a');
    const first = createLinkRequest(request(user.id, 'work'));
    const other = createLinkRequest(request(user.id, 'personal'));
    const second = createLinkRequest(request(user.id, 'Work'));

    expect(findLinkRequest(first.token)).toBeUndefined();
    expect(findLinkRequest(second.token)).toBeDefined();
    expect(findLinkRequest(other.token)).toBeDefined();
  });

  it('runs out of attempts', () => {
    const { user } = createUser('a');
    const { token } = createLinkRequest(request(user.id));
    const id = findLinkRequest(token)?.id ?? '';

    for (let i = 0; i < MAX_LINK_ATTEMPTS; i++) {
      expect(takeLinkAttempt(id)).toBe(true);
    }
    expect(takeLinkAttempt(id)).toBe(false);
    expect(findLinkRequest(token)).toBeUndefined();
  });

  it('works only once', () => {
    const { user } = createUser('a');
    const { token } = createLinkRequest(request(user.id));
    const id = findLinkRequest(token)?.id ?? '';

    completeLinkRequest(id);

    expect(findLinkRequest(token)).toBeUndefined();
    expect(takeLinkAttempt(id)).toBe(false);
  });

  it('ignores links of a disabled user and drops those of a removed one', () => {
    const { user } = createUser('a');
    const { token } = createLinkRequest(request(user.id));

    setUserDisabled(user.id, true);
    expect(findLinkRequest(token)).toBeUndefined();

    deleteUser(user.id);
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM link_requests').get()
    ).toEqual({ n: 0 });
  });
});
