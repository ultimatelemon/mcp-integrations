/** Drops undefined, null, false, empty strings and empty arrays so the JSON stays small. */
export function compact<T extends Record<string, unknown>>(
  value: T
): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null || item === false || item === '') {
      continue;
    }
    if (Array.isArray(item) && item.length === 0) continue;
    out[key] = item;
  }
  return out as Partial<T>;
}

export function euros(cents: number | undefined | null): number | undefined {
  return typeof cents === 'number' ? Math.round(cents) / 100 : undefined;
}

/** Positive delays only; early running is reported as on time. */
export function positiveDelay(minutes: number | undefined): number | undefined {
  return minutes !== undefined && minutes > 0 ? minutes : undefined;
}

export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/** NS crowd values to a short lowercase form; UNKNOWN is dropped. */
export function crowd(value: string | undefined | null): string | undefined {
  if (!value || value === 'UNKNOWN') return undefined;
  return value.toLowerCase();
}
