import { createJsonClient } from '../lib/json.ts';
import type { Logger } from '../lib/logger.ts';

export const DEELMOBILITEIT_API = 'https://api.datadeelmobiliteit.nl';

export const SERVICE = 'Dashboard Deelmobiliteit';

/** One unrented vehicle in public space, as the open Available Vehicles API returns it. */
export interface SharedVehicle {
  system_id: string;
  vehicle_id?: string;
  lat: number;
  lon: number;
  is_reserved?: boolean;
  is_disabled?: boolean;
  form_factor?: string;
  propulsion_type?: string;
}

export interface VehiclesResponse {
  last_updated?: string;
  ttl?: number;
  data?: { vehicles?: SharedVehicle[] };
}

/*
 * The feed holds every shared vehicle in the country. Parsed as is, each one is
 * an object with eight properties and its own strings; here it becomes a few
 * typed columns plus lookup tables, about 20 bytes a vehicle.
 */
export interface VehicleSnapshot {
  updated: string | undefined;
  count: number;
  operators: string[];
  types: string[];
  propulsions: string[];
  lat: Float64Array;
  lon: Float64Array;
  operator: Uint16Array;
  type: Uint8Array;
  propulsion: Uint8Array;
  /** Bit 1: reserved, bit 2: disabled. */
  flags: Uint8Array;
}

export const RESERVED = 1;
export const DISABLED = 2;

function lookup(table: string[], index: Map<string, number>, value: string) {
  let i = index.get(value);
  if (i === undefined) {
    i = table.length;
    table.push(value);
    index.set(value, i);
  }
  return i;
}

export function toSnapshot(body: VehiclesResponse): VehicleSnapshot {
  const raw = (body.data?.vehicles ?? []).filter(
    (v) =>
      typeof v.system_id === 'string' &&
      Number.isFinite(v.lat) &&
      Number.isFinite(v.lon)
  );
  const n = raw.length;
  const snapshot: VehicleSnapshot = {
    updated: body.last_updated,
    count: n,
    operators: [],
    types: [],
    propulsions: [],
    lat: new Float64Array(n),
    lon: new Float64Array(n),
    operator: new Uint16Array(n),
    type: new Uint8Array(n),
    propulsion: new Uint8Array(n),
    flags: new Uint8Array(n)
  };
  const operators = new Map<string, number>();
  const types = new Map<string, number>();
  const propulsions = new Map<string, number>();
  raw.forEach((v, i) => {
    snapshot.lat[i] = v.lat;
    snapshot.lon[i] = v.lon;
    snapshot.operator[i] = lookup(snapshot.operators, operators, v.system_id);
    snapshot.type[i] = lookup(snapshot.types, types, v.form_factor ?? 'other');
    snapshot.propulsion[i] = lookup(
      snapshot.propulsions,
      propulsions,
      v.propulsion_type ?? 'unknown'
    );
    snapshot.flags[i] =
      (v.is_reserved ? RESERVED : 0) | (v.is_disabled ? DISABLED : 0);
  });
  return snapshot;
}

export interface VehiclesClientOptions {
  logger?: Logger;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function createVehiclesClient(
  options: VehiclesClientOptions = {}
): () => Promise<VehiclesResponse> {
  const get = createJsonClient(SERVICE, {
    baseUrl: options.baseUrl ?? DEELMOBILITEIT_API,
    // The open API has no published limit; the snapshot cache keeps us at a few calls a minute.
    rateLimit: { limit: 30, windowMs: 60_000, burst: 5, maxWaitMs: 8000 },
    // The response holds every shared vehicle in the country, several MB.
    timeoutMs: 20_000,
    retries: 1,
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {})
  });

  return () => get<VehiclesResponse>('/vehicles');
}

export interface VehicleProviderOptions {
  /** Shortest time between two downloads; the feed's own ttl only ever lengthens it. */
  minTtlMs?: number;
  logger?: Logger;
  now?: () => number;
}

const MAX_TTL_MS = 10 * 60_000;

/*
 * Keeps the latest nationwide snapshot in process memory rather than in the
 * shared cache: it is too large to round-trip through Redis on every call.
 * Nothing is fetched until a tool asks, concurrent callers share one request,
 * and a stale snapshot beats an error.
 */
export function createVehicleProvider(
  load: () => Promise<VehiclesResponse>,
  options: VehicleProviderOptions = {}
): () => Promise<VehicleSnapshot> {
  const { minTtlMs = 60_000, logger, now = Date.now } = options;
  let current: { snapshot: VehicleSnapshot; expires: number } | undefined;
  let pending: Promise<VehicleSnapshot> | undefined;

  const refresh = async () => {
    const started = now();
    const body = await load();
    const snapshot = toSnapshot(body);
    const ttl = Math.min(
      MAX_TTL_MS,
      Math.max(minTtlMs, (body.ttl ?? 0) * 1000)
    );
    logger?.debug(
      { vehicles: snapshot.count, ms: now() - started },
      'shared vehicles loaded'
    );
    current = { snapshot, expires: now() + ttl };
    return snapshot;
  };

  return () => {
    if (current && now() < current.expires) {
      return Promise.resolve(current.snapshot);
    }
    pending ??= refresh().finally(() => {
      pending = undefined;
    });
    if (current) {
      const stale = current.snapshot;
      return pending.catch(() => stale);
    }
    return pending;
  };
}
