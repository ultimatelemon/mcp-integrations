import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Deps } from '../context.ts';
import { registerArrivals, registerDepartures } from './board.ts';
import { registerDisruptions } from './disruptions.ts';
import { registerPlanTrip } from './planTrip.ts';
import { registerSearchStations } from './searchStations.ts';
import { registerScootersNearby } from './scootersNearby.ts';
import { registerNearestZone } from './nearestZone.ts';
import { registerOvDepartures } from './ovDepartures.ts';
import { registerStationFacilities } from './stationFacilities.ts';
import { registerTrainComposition } from './trainComposition.ts';
import { registerTrainJourney } from './trainJourney.ts';
import { registerTripDetails } from './tripDetails.ts';
import { registerTripPrice } from './tripPrice.ts';

export function registerTools(server: McpServer, deps: Deps): void {
  registerSearchStations(server, deps);
  registerPlanTrip(server, deps);
  registerTripDetails(server, deps);
  registerTripPrice(server, deps);
  registerDepartures(server, deps);
  registerArrivals(server, deps);
  registerTrainJourney(server, deps);
  registerDisruptions(server, deps);
  registerTrainComposition(server, deps);
  registerStationFacilities(server, deps);
  registerScootersNearby(server, deps);
  registerNearestZone(server, deps);
  registerOvDepartures(server, deps);
}
