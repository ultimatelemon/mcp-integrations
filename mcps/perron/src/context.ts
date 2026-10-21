import type { VehicleSnapshot } from './deelmobiliteit/client.ts';
import type { ServiceArea } from './deelmobiliteit/serviceAreas.ts';
import type { Geocoder } from './geo/geocode.ts';
import type { OvService } from './ov/service.ts';
import type { Cache } from './lib/cache.ts';
import type { Logger } from './lib/logger.ts';
import type { NsClient } from './ns/client.ts';
import { fetchStations } from './ns/stations.ts';
import { StationIndex } from './resolve.ts';

const MINUTE = 60_000;

export const TTL = {
  stations: 24 * 60 * MINUTE,
  places: 60 * MINUTE,
  ovfiets: 2 * MINUTE,
  lifts: 2 * MINUTE,
  disruptions: MINUTE,
  live: 30_000,
  zones: 24 * 60 * MINUTE
} as const;

export interface Deps {
  ns: NsClient;
  cache: Cache;
  stations: () => Promise<StationIndex>;
  /** Nationwide snapshot of unrented shared vehicles. */
  vehicles: () => Promise<VehicleSnapshot>;
  geocoder: Geocoder;
  serviceAreas: (
    municipality: string,
    operator: string
  ) => Promise<ServiceArea[]>;
  ov: OvService;
  now: () => Date;
  logger: Logger;
}

/** Keeps one StationIndex in memory and rebuilds it once the cached list expires. */
export function createStationProvider(
  ns: NsClient,
  cache: Cache,
  now: () => number = Date.now
): () => Promise<StationIndex> {
  let current: { index: StationIndex; builtAt: number } | undefined;
  let pending: Promise<StationIndex> | undefined;

  const build = async () => {
    const raw = await cache.wrap('stations:v3', TTL.stations, () =>
      fetchStations(ns)
    );
    const index = new StationIndex(raw);
    current = { index, builtAt: now() };
    return index;
  };

  return () => {
    if (current && now() - current.builtAt < TTL.stations) {
      return Promise.resolve(current.index);
    }
    pending ??= build().finally(() => {
      pending = undefined;
    });
    // A stale index beats an error while NS is unreachable.
    if (current) {
      const stale = current.index;
      return pending.catch(() => stale);
    }
    return pending;
  };
}
