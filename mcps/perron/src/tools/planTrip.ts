import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../context.ts';
import { TTL } from '../context.ts';
import { toNsDateTime } from '../format/time.ts';
import { formatTrip, summarizeTrips } from '../format/trips.ts';
import { getTrips } from '../ns/reisinformatie.ts';
import { rememberTrip } from '../tripIds.ts';
import { dateTime, station } from './schema.ts';
import { ok, READ_ONLY, run } from './result.ts';

export function registerPlanTrip(server: McpServer, deps: Deps) {
  server.registerTool(
    'plan_trip',
    {
      title: 'Plan a train trip',
      description:
        'Plan a train journey between two stations with live delays, track changes, crowding, transfers and the fare. Use for "how do I get from A to B" or "when do I need to leave". Each option has a tripId for trip_details.',
      inputSchema: {
        from: station('Origin'),
        to: station('Destination'),
        via: station('Optional via station').optional(),
        dateTime,
        arriveBy: z
          .boolean()
          .optional()
          .describe('Treat dateTime as the desired arrival time'),
        travelClass: z
          .union([z.literal(1), z.literal(2)])
          .optional()
          .describe('Class used for the fare; default 2'),
        localTrainsOnly: z
          .boolean()
          .optional()
          .describe('Only Sprinters and other local trains'),
        excludeHighSpeedTrains: z
          .boolean()
          .optional()
          .describe(
            'Avoid high-speed trains (no ICE / Intercity direct supplement)'
          ),
        maxOptions: z
          .number()
          .int()
          .min(1)
          .max(8)
          .optional()
          .describe('Default 4')
      },
      annotations: READ_ONLY
    },
    (input) =>
      run(deps.logger, async () => {
        const index = await deps.stations();
        const from = index.resolve(input.from);
        const to = index.resolve(input.to);
        const via = input.via ? index.resolve(input.via) : undefined;
        const query = {
          fromUic: from.uic,
          toUic: to.uic,
          viaUic: via?.uic,
          dateTime: toNsDateTime(input.dateTime),
          searchForArrival: input.arriveBy,
          travelClass: input.travelClass,
          localTrainsOnly: input.localTrainsOnly,
          excludeHighSpeedTrains: input.excludeHighSpeedTrains
        };
        const response = await deps.cache.wrap(
          `trips:${JSON.stringify(query)}`,
          TTL.live,
          () => getTrips(deps.ns, query)
        );
        const now = deps.now();
        const trips = (response.trips ?? []).slice(0, input.maxOptions ?? 4);
        const options = await Promise.all(
          trips.map(async (trip) => ({
            ...(trip.ctxRecon
              ? { tripId: await rememberTrip(deps.cache, trip.ctxRecon) }
              : {}),
            ...formatTrip(trip, now)
          }))
        );
        return ok(summarizeTrips(from.name, to.name, options), {
          from: from.name,
          to: to.name,
          ...(via ? { via: via.name } : {}),
          options
        });
      })
  );
}
