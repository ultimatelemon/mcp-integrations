import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/server';
import { loadConfig } from './config.ts';
import { createStationProvider, type Deps } from './context.ts';
import { createCache } from './lib/cache.ts';
import { startMcpHttpServer } from '@ultimatelemon-eu/mcp-http';
import {
  createVehicleProvider,
  createVehiclesClient
} from './deelmobiliteit/client.ts';
import { createServiceAreaClient } from './deelmobiliteit/serviceAreas.ts';
import { Geocoder, type GeocoderDeps } from './geo/geocode.ts';
import { createNominatim } from './geo/nominatim.ts';
import { createPdok } from './geo/pdok.ts';
import { sqliteStore } from './lib/store.ts';
import { createLogger } from './log.ts';
import { OvService } from './ov/service.ts';
import { createNsClientPool, type NsClient } from './ns/client.ts';
import type { StationIndex } from './resolve.ts';
import { registerTools } from './tools/index.ts';

// src/ and dist/ both sit one level below package.json.
const { version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
) as { version: string };

// Inlined so the icon needs no route or hosting; clients read it from serverInfo.
const ICON = `data:image/svg+xml;base64,${readFileSync(
  new URL('../assets/icon.svg', import.meta.url)
).toString('base64')}`;

const INSTRUCTIONS =
  'Dutch Railways (NS) travel information. Tools accept station names, NS codes or UIC codes. Times are Europe/Amsterdam, HH:mm, with the date only when it is not today. Prices are in euros. For the last mile: scooters_nearby and nearest_zone (shared scooters and where to park them) and ov_departures (GVB metro 52 and IJ ferries) take an address, station or place, and echo the coordinates they used. This is not an official NS service.';

export function createPerronServer(deps: Deps, iconUrl?: string): McpServer {
  const server = new McpServer(
    {
      name: 'perron',
      title: 'Perron',
      version,
      description: 'Dutch Railways (NS) travel information',
      websiteUrl: 'https://github.com/ultimatelemon/mcp-integrations',
      icons: [
        iconUrl
          ? { src: iconUrl }
          : { src: ICON, mimeType: 'image/svg+xml', sizes: ['any'] }
      ]
    },
    { instructions: INSTRUCTIONS }
  );
  registerTools(server, deps);
  return server;
}

/** Deps shared by every request; the NS client comes from the caller's key. */
export interface SharedDeps extends Omit<Deps, 'ns' | 'stations' | 'geocoder'> {
  nsFor: (apiKey: string) => NsClient;
  stations: (ns: NsClient) => Promise<StationIndex>;
  geocoder: Omit<GeocoderDeps, 'stations'>;
}

export function depsFor(shared: SharedDeps, apiKey: string): Deps {
  const { nsFor, stations: stationsFor, geocoder, ...rest } = shared;
  const ns = nsFor(apiKey);
  const stations = () => stationsFor(ns);
  return {
    ...rest,
    ns,
    stations,
    geocoder: new Geocoder({ ...geocoder, stations })
  };
}

const API_KEY_HINT =
  'Use your own NS API key: subscribe to the "Ns-App" product at https://apiportal.ns.nl.';

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const cache = createCache({
    redisUrl: config.REDIS_URL,
    prefix: 'perron:',
    logger
  });
  const stations = createStationProvider(cache);
  const vehicles = createVehicleProvider(createVehiclesClient({ logger }), {
    minTtlMs: config.VEHICLES_CACHE_SECONDS * 1000,
    logger
  });
  const store = sqliteStore(join(config.DATA_DIR, 'geocode.sqlite'));
  const geocoder = {
    pdok: createPdok({ logger }),
    nominatim: createNominatim({
      userAgent: `perron/${version} (+https://github.com/ultimatelemon/mcp-integrations)`,
      logger
    }),
    store,
    logger
  };
  const ov = new OvService({
    dataDir: config.DATA_DIR,
    gtfsUrl: config.GTFS_URL,
    realtimeUrl: config.GTFS_RT_URL,
    agency: config.OV_AGENCY,
    lines: config.OV_LINES,
    logger
  });
  const stopOv = ov.start();
  const shared: SharedDeps = {
    nsFor: createNsClientPool({ logger }),
    cache,
    stations,
    vehicles,
    geocoder,
    serviceAreas: createServiceAreaClient({ logger }),
    ov,
    now: () => new Date(),
    logger
  };

  const http = await startMcpHttpServer({
    // mcp-http answers 401 before this runs when the caller sent no key.
    createMcpServer: ({ apiKey = '' }) =>
      createPerronServer(depsFor(shared, apiKey), config.ICON_URL),
    apiKey: { hint: API_KEY_HINT },
    port: config.PORT,
    host: config.HOST,
    basePath: config.BASE_PATH,
    logger
  });
  logger.info({ url: http.url, redis: !!config.REDIS_URL }, 'perron listening');

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'shutting down');
    stopOv();
    Promise.all([http.close(), cache.close()])
      .then(() => {
        store.close();
        process.exit(0);
      })
      .catch(() => process.exit(1));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
