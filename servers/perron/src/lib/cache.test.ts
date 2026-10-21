import { describe, expect, it, vi } from 'vitest';
import { createCache, memoryStore } from './cache.ts';

describe('memoryStore', () => {
  it('expires entries after their TTL', async () => {
    let now = 0;
    const store = memoryStore(10, () => now);
    await store.set('a', '1', 100);
    expect(await store.get('a')).toBe('1');
    now = 100;
    expect(await store.get('a')).toBeUndefined();
  });

  it('evicts the oldest write beyond maxEntries', async () => {
    const store = memoryStore(2);
    await store.set('a', '1', 1000);
    await store.set('b', '2', 1000);
    await store.set('c', '3', 1000);
    expect(await store.get('a')).toBeUndefined();
    expect(await store.get('c')).toBe('3');
  });
});

describe('createCache', () => {
  it('runs a loader once for concurrent misses', async () => {
    const cache = createCache();
    const load = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { v: 1 };
    });
    const results = await Promise.all([
      cache.wrap('k', 1000, load),
      cache.wrap('k', 1000, load),
      cache.wrap('k', 1000, load)
    ]);
    expect(results).toEqual([{ v: 1 }, { v: 1 }, { v: 1 }]);
    expect(load).toHaveBeenCalledTimes(1);
    await cache.wrap('k', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failed load', async () => {
    const cache = createCache();
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValueOnce(2);
    await expect(cache.wrap('k', 1000, load)).rejects.toThrow('down');
    await expect(cache.wrap('k', 1000, load)).resolves.toBe(2);
  });
});

describe('redisStore', () => {
  it('does not block or fail when Redis is unreachable', async () => {
    const started = Date.now();
    const cache = createCache({ redisUrl: 'redis://127.0.0.1:1' });
    expect(Date.now() - started).toBeLessThan(100);
    await expect(cache.wrap('k', 1000, () => Promise.resolve(7))).resolves.toBe(
      7
    );
    await expect(cache.get('k')).resolves.toBeUndefined();
    await cache.close();
  });
});
