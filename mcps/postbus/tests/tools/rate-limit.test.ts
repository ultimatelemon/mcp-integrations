import { beforeEach, describe, expect, it } from 'vitest';
import { RATE_LIMIT_PER_MINUTE } from '../../src/config.js';
import { resetRateLimits, takeCall } from '../../src/tools/rate-limit.js';

beforeEach(() => resetRateLimits());

describe('takeCall', () => {
  it('allows the limit, then says how long to wait', () => {
    const now = 1_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) {
      expect(takeCall('user1', now)).toBeUndefined();
    }

    expect(takeCall('user1', now + 15_000)).toBe(45);
  });

  it('counts every user on their own', () => {
    const now = 1_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) takeCall('user1', now);

    expect(takeCall('user2', now)).toBeUndefined();
  });

  it('starts over once the window has passed', () => {
    const now = 1_000_000;
    for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) takeCall('user1', now);

    expect(takeCall('user1', now + 60_000)).toBeUndefined();
  });
});
