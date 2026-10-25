import { RATE_LIMIT_PER_MINUTE } from '../config.js';

// A fixed window per user, in process: one container per deployment, and what
// it protects is a connection pool that talks to someone else's mail server.
const WINDOW_MS = 60_000;

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Counts one call; returns the seconds to wait when the user is over the limit. */
export function takeCall(userId: string, now = Date.now()): number | undefined {
  const window = windows.get(userId);

  if (!window || window.resetAt <= now) {
    windows.set(userId, { count: 1, resetAt: now + WINDOW_MS });
    sweep(now);
    return undefined;
  }

  if (window.count >= RATE_LIMIT_PER_MINUTE) {
    return Math.ceil((window.resetAt - now) / 1000);
  }

  window.count += 1;
  return undefined;
}

// A server that runs for months should not keep a window per user forever.
function sweep(now: number): void {
  if (windows.size < 1000) return;
  for (const [userId, window] of windows) {
    if (window.resetAt <= now) windows.delete(userId);
  }
}

export function resetRateLimits(): void {
  windows.clear();
}
