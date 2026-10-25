import { describe, expect, it } from 'vitest';
import { generateApiToken, hashToken } from '../../src/db/users.js';

describe('API tokens', () => {
  it('hashes deterministically and irreversibly', () => {
    const token = 'pb_example';

    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toHaveLength(64);
  });

  // Existing tokens must keep matching the hashes postbus 0.2.0 stored.
  it('hashes as before', () => {
    expect(hashToken('pb_example')).toBe(
      'cc62b5025555e126498068b18145e5698161d62999f744fa558efc666623d72f'
    );
  });

  it('ignores whitespace around a pasted token', () => {
    expect(hashToken('  pb_example\n')).toBe(hashToken('pb_example'));
  });

  it('gives different tokens different hashes', () => {
    expect(hashToken('pb_a')).not.toBe(hashToken('pb_b'));
  });

  it('generates recognisable, unique tokens', () => {
    const tokens = new Set(
      Array.from({ length: 50 }, () => generateApiToken())
    );

    expect(tokens.size).toBe(50);
    for (const token of tokens) {
      expect(token.startsWith('pb_')).toBe(true);
      expect(token.length).toBeGreaterThan(40);
    }
  });
});
