import { createDateTime } from '@ultimatelemon-eu/datetime';

export const TIME_ZONE = 'Europe/Amsterdam';

const dt = createDateTime({ locale: 'en-GB', timeZone: TIME_ZONE });

/** Reads NS timestamps (`+0200` offsets) and user input; ISO without offset is Amsterdam wall-clock time. */
export function parseTime(input: string | undefined | null): Date | null {
  if (!input) return null;
  return dt.parse(input);
}

/** `HH:mm`, prefixed with `YYYY-MM-DD ` when the day differs from today in Amsterdam. */
export function formatTime(
  input: string | undefined | null,
  now: Date
): string | undefined {
  const date = parseTime(input);
  if (!date) return undefined;
  const zoned = dt.toZonedInput(date);
  const day = zoned.slice(0, 10);
  const time = zoned.slice(11, 16);
  return day === dt.toZonedInput(now).slice(0, 10) ? time : `${day} ${time}`;
}

/** Minutes between planned and actual, rounded; undefined when either is missing. */
export function delayMinutes(
  planned: string | undefined | null,
  actual: string | undefined | null
): number | undefined {
  const p = parseTime(planned);
  const a = parseTime(actual);
  if (!p || !a) return undefined;
  return Math.round((a.getTime() - p.getTime()) / 60_000);
}

/** ISO string with offset for upstream query parameters, e.g. `2026-10-06T18:00:00+02:00`. */
export function toNsDateTime(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const date = parseTime(input);
  if (!date) throw new Error(`Cannot read date/time "${input}"`);
  return date.toISOString();
}

/** `YYYY-MM-DD` in Amsterdam. */
export function amsterdamDay(date: Date): string {
  return dt.toZonedInput(date).slice(0, 10);
}
