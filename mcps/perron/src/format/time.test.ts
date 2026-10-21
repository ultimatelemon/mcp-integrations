import { describe, expect, it } from 'vitest';
import { delayMinutes, formatTime, toNsDateTime } from './time.ts';

const now = new Date('2026-10-06T07:00:00Z');

describe('formatTime', () => {
  it('shows only HH:mm today, in Amsterdam time', () => {
    expect(formatTime('2026-10-06T09:28:00+0200', now)).toBe('09:28');
    expect(formatTime('2026-10-06T07:28:00Z', now)).toBe('09:28');
  });

  it('adds the date when it is another day in Amsterdam', () => {
    expect(formatTime('2026-10-07T00:15:00+0200', now)).toBe(
      '2026-10-07 00:15'
    );
    // 23:30 UTC on the 5th is already the 6th in Amsterdam.
    expect(formatTime('2026-10-05T23:30:00Z', now)).toBe('01:30');
  });

  it('returns undefined for missing input', () => {
    expect(formatTime(undefined, now)).toBeUndefined();
  });
});

describe('delayMinutes', () => {
  it('rounds to whole minutes', () => {
    expect(
      delayMinutes('2026-10-06T09:02:00+0200', '2026-10-06T09:29:20+0200')
    ).toBe(27);
    expect(delayMinutes('2026-10-06T09:02:00+0200', undefined)).toBeUndefined();
  });
});

describe('toNsDateTime', () => {
  it('reads input without an offset as Amsterdam time', () => {
    expect(toNsDateTime('2026-10-07T18:00')).toBe('2026-10-07T16:00:00.000Z');
    expect(toNsDateTime(undefined)).toBeUndefined();
    expect(() => toNsDateTime('tomorrow')).toThrow();
  });
});
