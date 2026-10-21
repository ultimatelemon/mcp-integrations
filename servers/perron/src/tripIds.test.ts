import { describe, expect, it } from 'vitest';
import { NotFound } from './errors.ts';
import { createCache } from './lib/cache.ts';
import { recallTrip, rememberTrip, tripIdFor } from './tripIds.ts';

describe('trip ids', () => {
  it('are short, stable and URL-safe', () => {
    const id = tripIdFor('arnu|fromStation=8400621|toStation=8400282');
    expect(id).toMatch(/^[A-Za-z0-9_-]{10}$/);
    expect(tripIdFor('arnu|fromStation=8400621|toStation=8400282')).toBe(id);
    expect(tripIdFor('arnu|other')).not.toBe(id);
  });

  it('round-trip through the cache', async () => {
    const cache = createCache();
    const id = await rememberTrip(cache, 'ctx-1');
    await expect(recallTrip(cache, id)).resolves.toBe('ctx-1');
  });

  it('tell the assistant to plan again when unknown', async () => {
    const cache = createCache();
    await expect(recallTrip(cache, 'nope')).rejects.toBeInstanceOf(NotFound);
  });
});
