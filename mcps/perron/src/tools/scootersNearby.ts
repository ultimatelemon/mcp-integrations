import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../context.ts';
import { formatPlace, placeLabel } from '../format/place.ts';
import { formatTime } from '../format/time.ts';
import {
  findNearby,
  knownOperators,
  operatorKey,
  type NearbyVehicle
} from '../format/vehicles.ts';
import { operator, place } from './schema.ts';
import { fail, ok, READ_ONLY, run } from './result.ts';

const FORM_FACTORS = [
  'moped',
  'bicycle',
  'cargo_bicycle',
  'scooter_standing',
  'scooter_seated',
  'car',
  'other'
] as const;

function line(v: NearbyVehicle): string {
  return `${v.operator ?? ''} ${v.form_factor ?? ''}: ${String(v.distance_m)} m ${v.direction ?? ''}`;
}

export function registerScootersNearby(server: McpServer, deps: Deps) {
  server.registerTool(
    'scooters_nearby',
    {
      title: 'Shared scooters nearby',
      description:
        'Available shared scooters (deelscooters) near an address, station or place, nearest first, with walking distance. Default: Check mopeds within 500 m. Reserved and disabled vehicles are left out. Also finds shared bikes and cars via form_factor.',
      inputSchema: {
        ...place,
        radius_m: z
          .number()
          .int()
          .min(50)
          .max(5000)
          .default(500)
          .describe('Search radius in metres'),
        operator: operator.describe(
          'Operator, e.g. "check", "felyx", "gosharing"; "all" for every operator'
        ),
        form_factor: z
          .array(z.enum(FORM_FACTORS))
          .default(['moped'])
          .describe(
            'Vehicle types; moped = scooter. Check also has bicycle and car.'
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(10)
          .describe('Most vehicles to list')
      },
      annotations: READ_ONLY
    },
    (input) =>
      run(deps.logger, async () => {
        const [at, snapshot] = await Promise.all([
          deps.geocoder.locate(input),
          deps.vehicles()
        ]);
        const all = operatorKey(input.operator) === 'all';
        if (
          !all &&
          !snapshot.operators.some(
            (o) => operatorKey(o) === operatorKey(input.operator)
          )
        ) {
          return fail(
            `No vehicles from "${input.operator}" in the feed right now. Operators: ${knownOperators(snapshot).join(', ')}.`
          );
        }

        const nearby = findNearby(snapshot, at, {
          operators: all ? undefined : [input.operator],
          formFactors: input.form_factor,
          radiusM: input.radius_m,
          limit: input.limit,
          includeUnavailable: false
        });
        const updated = formatTime(snapshot.updated, deps.now());
        const closest = nearby.vehicles[0] ?? nearby.closestOutsideRadius;
        const data = {
          location: formatPlace(at),
          operator: all ? 'all' : input.operator,
          form_factor: input.form_factor,
          radius_m: input.radius_m,
          count: nearby.total,
          ...(closest ? { nearest_m: closest.distance_m } : {}),
          ...(nearby.total > 1 && all
            ? { by_operator: nearby.byOperator }
            : {}),
          vehicles: nearby.vehicles,
          ...(nearby.closestOutsideRadius
            ? { closest_outside_radius: nearby.closestOutsideRadius }
            : {}),
          ...(updated ? { updated } : {})
        };

        const lines = [
          `${String(nearby.total)} ${all ? '' : `${input.operator} `}${input.form_factor.join('/')} within ${String(input.radius_m)} m of ${placeLabel(at)}${updated ? `, feed ${updated}` : ''}`,
          ...nearby.vehicles.map(line)
        ];
        if (nearby.closestOutsideRadius) {
          lines.push(`Closest: ${line(nearby.closestOutsideRadius)}`);
        }
        return ok(lines.join('\n'), data);
      })
  );
}
