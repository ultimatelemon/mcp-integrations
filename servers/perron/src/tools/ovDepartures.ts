import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../context.ts';
import { amsterdamDay, formatTime, parseTime } from '../format/time.ts';
import { compact } from '../format/util.ts';
import { fail, ok, READ_ONLY, run } from './result.ts';

const HOUR = 3_600_000;

/** `HH:MM` today in Amsterdam, or tomorrow when that is long past; ISO date/times as they are. */
export function readAfter(value: string | undefined, now: Date): Date | null {
  if (!value) return now;
  if (/^\d{1,2}:\d{2}$/.test(value.trim())) {
    const [h, m] = value.trim().split(':');
    const today = parseTime(
      `${amsterdamDay(now)}T${h!.padStart(2, '0')}:${m!}`
    );
    if (!today) return null;
    return today.getTime() < now.getTime() - 6 * HOUR
      ? new Date(today.getTime() + 24 * HOUR)
      : today;
  }
  return parseTime(value);
}

export function registerOvDepartures(server: McpServer, deps: Deps) {
  server.registerTool(
    'ov_departures',
    {
      title: 'GVB metro and ferry departures',
      description:
        'Next departures of GVB metro 52 and the Amsterdam IJ ferries (F2 IJplein, F3 Buiksloterweg, F4 NDSM) from a stop, with live delays where available (metro yes, ferries timetable only). Use `na` for departures after a train arrives.',
      inputSchema: {
        halte: z
          .string()
          .min(1)
          .describe(
            'Stop name, e.g. "Centraal Station", "Buiksloterweg", "Noorderpark", "Noord"'
          ),
        lijn: z
          .string()
          .min(1)
          .optional()
          .describe('Line, e.g. "52" or "F3". Default: all'),
        richting: z
          .string()
          .min(1)
          .optional()
          .describe(
            'Only departures whose destination contains this, e.g. "Noord"'
          ),
        na: z
          .string()
          .optional()
          .describe(
            'Departures after this time, HH:MM in Amsterdam time. Default: now'
          ),
        aantal: z
          .number()
          .int()
          .min(1)
          .max(20)
          .default(5)
          .describe('Number of departures')
      },
      annotations: READ_ONLY
    },
    (input) =>
      run(deps.logger, async () => {
        const now = deps.now();
        const after = readAfter(input.na, now);
        if (!after)
          return fail(`Cannot read time "${input.na ?? ''}"; use HH:MM.`);

        const board = await deps.ov.departures({
          halte: input.halte,
          lijn: input.lijn,
          richting: input.richting,
          after,
          count: input.aantal
        });
        const departures = board.departures.map((d) => ({
          ...compact({
            line: d.line,
            direction: d.direction,
            platform: d.platform,
            planned: formatTime(d.planned.toISOString(), now),
            expected: formatTime(d.expected.toISOString(), now),
            delay_min: d.delayMinutes
          }),
          realtime: d.realtime,
          cancelled: d.cancelled
        }));

        const data = compact({
          stop: board.stop,
          other_matches: board.alternatives,
          lines: board.lines,
          after: formatTime(after.toISOString(), now),
          departures,
          realtime_feed: board.realtimeAvailable ? undefined : 'unavailable',
          timetable_imported: board.timetableDate
        });
        const lines = [
          `${board.lines.join('/')} from ${board.stop}${input.na ? ` after ${input.na}` : ''}:`,
          ...departures.map(
            (d) =>
              `${d.planned ?? ''}${d.expected !== d.planned ? ` → ${d.expected ?? ''}` : ''} ${d.line ?? ''} to ${d.direction ?? '?'}${d.cancelled ? ' CANCELLED' : ''}${d.realtime ? '' : ' (timetable)'}`
          )
        ];
        if (departures.length === 0)
          lines.push('No departures in the next six hours.');
        return ok(lines.join('\n'), data);
      })
  );
}
