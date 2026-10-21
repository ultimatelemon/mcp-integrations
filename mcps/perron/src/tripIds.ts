import { createHash } from 'node:crypto';
import { NotFound } from './errors.ts';
import type { Cache } from './lib/cache.ts';

// ctxRecon is ~380 characters per option; the assistant gets this id instead.
const TTL_MS = 6 * 60 * 60_000;

export function tripIdFor(ctxRecon: string): string {
  return createHash('sha256').update(ctxRecon).digest('base64url').slice(0, 10);
}

export async function rememberTrip(
  cache: Cache,
  ctxRecon: string
): Promise<string> {
  const id = tripIdFor(ctxRecon);
  await cache.set(`tripid:${id}`, ctxRecon, TTL_MS);
  return id;
}

export async function recallTrip(cache: Cache, id: string): Promise<string> {
  const ctxRecon = await cache.get<string>(`tripid:${id}`);
  if (!ctxRecon) {
    throw new NotFound(
      `Trip ${id} is unknown or expired (ids last 6 hours). Run plan_trip again.`
    );
  }
  return ctxRecon;
}
