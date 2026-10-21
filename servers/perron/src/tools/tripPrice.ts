import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../context.ts';
import { TTL } from '../context.ts';
import { formatPrice } from '../format/price.ts';
import { getPrice } from '../ns/reisinformatie.ts';
import { station } from './schema.ts';
import { ok, READ_ONLY, run } from './result.ts';

export function registerTripPrice(server: McpServer, deps: Deps) {
  server.registerTool(
    'trip_price',
    {
      title: 'Train fare',
      description:
        'Price of a domestic NS train ticket between two stations, for single or return, 1st or 2nd class, and groups. Use when the user asks what a trip costs without needing the timetable.',
      inputSchema: {
        from: station('Origin'),
        to: station('Destination'),
        travelClass: z
          .union([z.literal(1), z.literal(2)])
          .optional()
          .describe('Default 2'),
        returnTrip: z
          .boolean()
          .optional()
          .describe('Return ticket instead of single'),
        adults: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe('Default 1'),
        children: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe('Children 4-11; default 0'),
        jointJourney: z
          .boolean()
          .optional()
          .describe('Apply the joint-journey (samenreizen) discount'),
        routeId: z
          .string()
          .optional()
          .describe(
            'Specific route between the stations, when several are possible'
          )
      },
      annotations: READ_ONLY
    },
    (input) =>
      run(deps.logger, async () => {
        const index = await deps.stations();
        const from = index.resolve(input.from);
        const to = index.resolve(input.to);
        const query = {
          fromCode: from.code,
          toCode: to.code,
          travelClass: input.travelClass,
          returnTrip: input.returnTrip,
          adults: input.adults,
          children: input.children,
          jointJourney: input.jointJourney,
          routeId: input.routeId
        };
        const price = formatPrice(
          await deps.cache.wrap(
            `price:${JSON.stringify(query)}`,
            TTL.places,
            () => getPrice(deps.ns, query)
          )
        );
        const kind = input.returnTrip ? 'return' : 'single';
        const summary = `${from.name} → ${to.name}, ${kind}, class ${String(price.travelClass ?? 2)}: € ${price.priceEur?.toFixed(2) ?? '?'}`;
        return ok(summary, {
          from: from.name,
          to: to.name,
          type: kind,
          adults: input.adults ?? 1,
          children: input.children ?? 0,
          ...price
        });
      })
  );
}
