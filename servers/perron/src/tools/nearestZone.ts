import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Deps } from '../context.ts';
import { TTL } from '../context.ts';
import { NotFound } from '../errors.ts';
import { formatPlace, placeLabel } from '../format/place.ts';
import { nearestZone } from '../format/zones.ts';
import { operator, place } from './schema.ts';
import { ok, READ_ONLY, run } from './result.ts';

export function registerNearestZone(server: McpServer, deps: Deps) {
  server.registerTool(
    'nearest_zone',
    {
      title: 'Nearest parking zone',
      description:
        "Whether a shared scooter may be parked at an address, station or place (inside the operator's service area), and if not, how far it is to the nearest spot that is, with its coordinates and street. Default operator: check.",
      inputSchema: { ...place, operator },
      annotations: READ_ONLY
    },
    (input) =>
      run(deps.logger, async () => {
        const at = await deps.geocoder.locate(input);
        if (!at.municipality) {
          throw new NotFound(
            `Cannot tell which municipality ${placeLabel(at)} is in, so its service area is unknown.`
          );
        }
        const op = input.operator.toLowerCase().replace(/\s+/g, '');
        const areas = await deps.cache.wrap(
          `zones:v1:${at.municipality}:${op}`,
          TTL.zones,
          () => deps.serviceAreas(at.municipality!, op)
        );
        const mine = areas.filter((a) => a.municipality === at.municipality);
        const collections = (mine.length > 0 ? mine : areas).map(
          (a) => a.geometries
        );
        if (collections.length === 0) {
          throw new NotFound(
            `${op} has no service area in municipality ${at.municipality}.`
          );
        }

        const zone = nearestZone(collections, at);
        if (zone.inZone) {
          return ok(`${placeLabel(at)} is inside the ${op} parking zone.`, {
            location: formatPlace(at),
            operator: op,
            in_zone: true
          });
        }
        const spot = zone.inside ?? zone.edge;
        const street = spot
          ? await deps.geocoder.address(spot.lat, spot.lon)
          : {};
        const data = {
          location: formatPlace(at),
          operator: op,
          in_zone: false,
          ...(zone.distanceM !== undefined
            ? { distance_m: zone.distanceM }
            : {}),
          ...(spot
            ? {
                nearest_point: {
                  lat: spot.lat,
                  lon: spot.lon,
                  ...(street.street ? { street: street.street } : {}),
                  ...(street.address ? { address: street.address } : {})
                }
              }
            : {})
        };
        return ok(
          `${placeLabel(at)} is outside the ${op} parking zone. Nearest zone: ${String(zone.distanceM ?? '?')} m as the crow flies${street.street ? `, at ${street.street}` : ''}${spot ? ` (${String(spot.lat)}, ${String(spot.lon)})` : ''}.`,
          data
        );
      })
  );
}
