import { readFileSync } from 'node:fs';

export function fixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')
  ) as T;
}

/** Morning of the day the fixtures were recorded, in UTC. */
export const FIXTURE_NOW = new Date('2026-10-06T07:00:00Z');
