import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../context.ts';
import { TTL } from '../context.ts';
import {
  formatFacilities,
  formatLifts,
  formatOvFiets
} from '../format/facilities.ts';
import { getLifts, getOvFiets, getStationPlaces } from '../ns/places.ts';
import { station } from './schema.ts';
import { ok, READ_ONLY, run } from './result.ts';

const PARTS = ['ovfiets', 'lifts', 'facilities'] as const;
type Part = (typeof PARTS)[number];

function isoWeekday(date: Date): number {
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    weekday: 'short'
  }).format(date);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(day) + 1;
}

export function registerStationFacilities(server: McpServer, deps: Deps) {
  server.registerTool(
    'station_facilities',
    {
      title: 'Station facilities',
      description:
        "What is at a station: OV-fiets rental bikes with live availability, lift status (out-of-order lifts first), and facilities such as toilets, shops, lockers and bicycle parking with today's opening hours.",
      inputSchema: {
        station: station('Station'),
        include: z
          .array(z.enum(PARTS))
          .optional()
          .describe('Subset to fetch; default all three')
      },
      annotations: READ_ONLY
    },
    (input) =>
      run(deps.logger, async () => {
        const s = (await deps.stations()).resolve(input.station);
        const want = new Set<Part>(
          input.include?.length ? input.include : PARTS
        );
        const now = deps.now();

        const [ovfiets, lifts, facilities] = await Promise.all([
          want.has('ovfiets')
            ? deps.cache.wrap(`ovfiets:${s.code}`, TTL.ovfiets, () =>
                getOvFiets(deps.ns, s.code)
              )
            : undefined,
          want.has('lifts')
            ? deps.cache.wrap(`lifts:${s.code}`, TTL.lifts, () =>
                getLifts(deps.ns, s.code)
              )
            : undefined,
          want.has('facilities')
            ? deps.cache.wrap(`places:${s.code}`, TTL.places, () =>
                getStationPlaces(deps.ns, s.code)
              )
            : undefined
        ]);

        const data = {
          station: s.name,
          code: s.code,
          ...(ovfiets ? { ovfiets: formatOvFiets(ovfiets) } : {}),
          ...(lifts ? { lifts: formatLifts(lifts) } : {}),
          ...(facilities ? formatFacilities(facilities, isoWeekday(now)) : {})
        };

        const lines = [`Facilities at ${s.name}:`];
        if (data.ovfiets) {
          const bikes = data.ovfiets.reduce(
            (n, l) => n + (l.available ?? 0),
            0
          );
          lines.push(
            `OV-fiets: ${String(bikes)} bikes at ${String(data.ovfiets.length)} location(s)`
          );
        }
        if (data.lifts) {
          lines.push(
            `Lifts: ${String(data.lifts.available)}/${String(data.lifts.total)} working`
          );
        }
        if (data.facilities) {
          lines.push(
            `${String(data.facilities.length)} facilities, ${String(data.shops?.length ?? 0)} shops`
          );
        }
        return ok(lines.join('\n'), data);
      })
  );
}
