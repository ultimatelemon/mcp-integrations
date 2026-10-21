import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../context.ts';
import { TTL } from '../context.ts';
import { formatTrip, summarizeTrips } from '../format/trips.ts';
import { getTrip } from '../ns/reisinformatie.ts';
import { recallTrip } from '../tripIds.ts';
import { ok, READ_ONLY, run } from './result.ts';

export function registerTripDetails(server: McpServer, deps: Deps) {
  server.registerTool(
    'trip_details',
    {
      title: 'Trip details',
      description:
        'Refresh one option from plan_trip by its tripId: current delays, track changes and status, plus every intermediate stop per leg. Use to check whether a chosen connection still works or to see where a train stops on the way.',
      inputSchema: {
        tripId: z.string().min(1).describe('tripId from a plan_trip option')
      },
      annotations: READ_ONLY
    },
    ({ tripId }) =>
      run(deps.logger, async () => {
        const ctxRecon = await recallTrip(deps.cache, tripId);
        const trip = await deps.cache.wrap(`trip:${tripId}`, TTL.live, () =>
          getTrip(deps.ns, ctxRecon)
        );
        const option = { tripId, ...formatTrip(trip, deps.now(), true) };
        const first = trip.legs[0]?.origin.name ?? '?';
        const last = trip.legs.at(-1)?.destination.name ?? '?';
        return ok(summarizeTrips(first, last, [option]), option);
      })
  );
}
