import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStationProvider, type Deps } from '../src/context.ts';
import { createCache } from '../src/lib/cache.ts';
import { silentLogger } from '../src/lib/logger.ts';
import {
  startMcpHttpServer,
  type McpHttpServer
} from '@ultimatelemon-eu/mcp-http';
import {
  createVehicleProvider,
  createVehiclesClient
} from '../src/deelmobiliteit/client.ts';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServiceAreaClient } from '../src/deelmobiliteit/serviceAreas.ts';
import { Geocoder } from '../src/geo/geocode.ts';
import { createNominatim } from '../src/geo/nominatim.ts';
import { createPdok } from '../src/geo/pdok.ts';
import { memoryDurableStore } from '../src/lib/store.ts';
import { createNsClient } from '../src/ns/client.ts';
import { OvService } from '../src/ov/service.ts';
import { createPerronServer } from '../src/server.ts';
import { gvbFeed, gvbRealtime, zipOf } from './gtfs.ts';
import { FIXTURE_NOW, fixture } from './helpers.ts';

const ROUTES: [RegExp, string][] = [
  [/\/nsapp-stations\/v3$/, 'stations'],
  [/\/api\/v3\/trips$/, 'trips'],
  [/\/api\/v3\/trips\/trip$/, 'trip-single'],
  [/\/api\/v2\/price$/, 'price'],
  [/\/api\/v2\/departures$/, 'departures'],
  [/\/api\/v2\/arrivals$/, 'arrivals'],
  [/\/api\/v2\/journey$/, 'journey'],
  [/\/disruptions\/v3(\/station\/\w+)?$/, 'disruptions'],
  [/\/virtual-train-api\/v1\/trein\//, 'virtual-train'],
  [/\/virtual-train-api\/v1\/prognose\//, 'virtual-train-prognose'],
  [/\/places-api\/v2\/places$/, 'places'],
  [/\/places-api\/v2\/ovfiets$/, 'ovfiets'],
  [/\/places-api\/v1\/stationfacility\/lifts$/, 'lifts'],
  [/^\/vehicles$/, 'vehicles']
];

const requests: { url: URL; key: string | null; agent: string | null }[] = [];

// A service area west of Utrecht Centraal (5.1103), ending 300 m away at 5.1059.
const SERVICE_AREA = [
  {
    municipality: 'GM0344',
    operator: 'check',
    geometries: {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'MultiPolygon',
            coordinates: [
              [
                [
                  [5.09, 52.08],
                  [5.1059, 52.08],
                  [5.1059, 52.1],
                  [5.09, 52.1],
                  [5.09, 52.08]
                ]
              ]
            ]
          }
        }
      ]
    }
  }
];

let gtfsZip: Buffer;

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

function fakeOther(url: URL) {
  switch (url.host) {
    case 'pdok.test':
      return json({
        response: {
          docs: [
            url.pathname.endsWith('/reverse')
              ? {
                  weergavenaam: `Westplein 1, 3523GZ Utrecht (${url.searchParams.get('lon') ?? ''})`,
                  straatnaam: 'Westplein',
                  gemeentecode: '0344',
                  afstand: 20
                }
              : {
                  weergavenaam: 'Vredenburg, Utrecht',
                  centroide_ll: 'POINT(5.11365 52.09246)',
                  gemeentecode: '0344'
                }
          ]
        }
      });
    case 'nominatim.test':
      return json([]);
    case 'mds.test':
      return json(
        url.searchParams.get('municipalities') === 'GM0344' ? SERVICE_AREA : []
      );
    case 'gtfs.test':
      return Promise.resolve(
        new Response(
          new Uint8Array(
            url.pathname.endsWith('.zip') ? gtfsZip : gvbRealtime()
          ),
          { status: 200 }
        )
      );
    default:
      return undefined;
  }
}

const fakeFetch = ((input: URL, init?: RequestInit) => {
  const url = new URL(input);
  const headers = new Headers(init?.headers);
  requests.push({
    url,
    key: headers.get('ocp-apim-subscription-key'),
    agent: headers.get('user-agent')
  });
  const other = fakeOther(url);
  if (other) return other;
  const route = ROUTES.find(([pattern]) => pattern.test(url.pathname));
  if (!route) {
    return Promise.resolve(
      new Response('{"message":"not found"}', { status: 404 })
    );
  }
  return Promise.resolve(
    new Response(JSON.stringify(fixture(route[1])), { status: 200 })
  );
}) as typeof fetch;

let http: McpHttpServer;
let client: Client;
let ov: OvService | undefined;
const dataDir = mkdtempSync(join(tmpdir(), 'perron-server-'));

beforeAll(async () => {
  gtfsZip = await zipOf(gvbFeed());
  const ns = createNsClient({ apiKey: 'test-key', fetch: fakeFetch });
  const cache = createCache();
  const stations = createStationProvider(ns, cache);
  ov = new OvService({
    dataDir,
    gtfsUrl: 'https://gtfs.test/gtfs-nl.zip',
    realtimeUrl: 'https://gtfs.test/tripUpdates.pb',
    agency: 'GVB',
    lines: [],
    logger: silentLogger,
    fetch: fakeFetch,
    now: () => FIXTURE_NOW
  });
  await ov.ensureFresh();
  const deps: Deps = {
    ns,
    cache,
    stations,
    geocoder: new Geocoder({
      pdok: createPdok({ fetch: fakeFetch, baseUrl: 'https://pdok.test' }),
      nominatim: createNominatim({
        userAgent: 'perron-test',
        fetch: fakeFetch,
        baseUrl: 'https://nominatim.test'
      }),
      stations,
      store: memoryDurableStore(),
      logger: silentLogger
    }),
    serviceAreas: createServiceAreaClient({
      fetch: fakeFetch,
      baseUrl: 'https://mds.test'
    }),
    ov,
    vehicles: createVehicleProvider(
      createVehiclesClient({
        fetch: fakeFetch,
        baseUrl: 'https://deelmobiliteit.test'
      })
    ),
    now: () => FIXTURE_NOW,
    logger: silentLogger
  };
  http = await startMcpHttpServer({
    createMcpServer: () => createPerronServer(deps),
    port: 0,
    host: '127.0.0.1',
    basePath: '/ns'
  });
  client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(http.url)));
});

afterAll(async () => {
  await client.close();
  await http.close();
  ov?.timetable?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError ?? false,
    text: (result.content as { text: string }[])[0]?.text ?? '',
    data: result.structuredContent as Record<string, unknown>
  };
}

describe('perron over Streamable HTTP', () => {
  it('serves the mount path from BASE_PATH', () => {
    expect(http.url).toMatch(/\/ns\/mcp$/);
  });

  it('answers /healthz', async () => {
    const res = await fetch(http.url.replace(/\/mcp$/, '/healthz'));
    expect(res.status).toBe(200);
  });

  it('rejects GET on /mcp in stateless mode', async () => {
    const res = await fetch(http.url);
    expect(res.status).toBe(405);
  });

  it('announces a title and an inline SVG icon', () => {
    const info = client.getServerVersion();
    expect(info).toMatchObject({ name: 'perron', title: 'Perron' });
    expect(info?.icons?.[0]?.src).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it('lists the thirteen tools with descriptions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'arrivals',
      'departures',
      'disruptions',
      'nearest_zone',
      'ov_departures',
      'plan_trip',
      'scooters_nearby',
      'search_stations',
      'station_facilities',
      'train_composition',
      'train_journey',
      'trip_details',
      'trip_price'
    ]);
    for (const tool of tools) {
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });

  it('plans a trip by station names and resolves them to UIC codes', async () => {
    const result = await call('plan_trip', { from: 'Utrecht', to: 'Den Haag' });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      from: 'Utrecht Centraal',
      to: 'Den Haag Centraal'
    });
    expect((result.data['options'] as unknown[]).length).toBe(4);
    const tripRequest = requests.find((r) =>
      r.url.pathname.endsWith('/v3/trips')
    );
    expect(tripRequest?.url.searchParams.get('originUicCode')).toBe('8400621');
    expect(tripRequest?.url.searchParams.get('destinationUicCode')).toBe(
      '8400282'
    );
  });

  it('hands out tripIds instead of ctxRecon and resolves them in trip_details', async () => {
    const planned = await call('plan_trip', {
      from: 'UT',
      to: 'GVC',
      maxOptions: 2
    });
    const options = planned.data['options'] as { tripId?: string }[];
    expect(JSON.stringify(planned.data)).not.toContain('ctxRecon');
    const tripId = options[0]?.tripId;
    expect(tripId).toMatch(/^[\w-]{10}$/);

    const details = await call('trip_details', { tripId });
    expect(details.isError).toBe(false);
    expect(details.data).toMatchObject({ tripId });
    const detailRequest = requests.find((r) =>
      r.url.pathname.endsWith('/v3/trips/trip')
    );
    expect(detailRequest?.url.searchParams.get('ctxRecon')).toMatch(/^arnu\|/);
  });

  it('reports an unknown tripId as a readable error', async () => {
    const result = await call('trip_details', { tripId: 'doesnotexi' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Run plan_trip again');
  });

  it('finds Check scooters near a station and says where it looked', async () => {
    const result = await call('scooters_nearby', {
      locatie: 'station Utrecht Centraal'
    });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      location: {
        query: 'station Utrecht Centraal',
        name: 'Utrecht Centraal (station)',
        source: 'ns',
        municipality: 'GM0344'
      },
      operator: 'check',
      count: 2,
      updated: '08:59'
    });
    expect(result.data['nearest_m']).toBeLessThan(100);
    expect(result.text).toMatch(
      /^2 check moped within 500 m of Utrecht Centraal/
    );
  });

  it('counts every operator with operator "all"', async () => {
    const result = await call('scooters_nearby', {
      lat: 52.08889,
      lon: 5.11028,
      operator: 'all'
    });
    expect(result.data).toMatchObject({
      count: 4,
      by_operator: { check: 2, felyx: 1, gosharing: 1 },
      location: { source: 'coordinates', street: 'Westplein' }
    });
  });

  it('names the operators in the feed when the asked one is unknown', async () => {
    const result = await call('scooters_nearby', {
      lat: 52.09,
      lon: 5.11,
      operator: 'nope'
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('check, cykl, felyx');
  });

  it('asks for a place when none is given', async () => {
    const result = await call('scooters_nearby', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('locatie');
  });

  it('tells how far the nearest parking zone is, and on which street', async () => {
    const result = await call('nearest_zone', {
      locatie: 'Vredenburg Utrecht'
    });
    expect(result.isError).toBe(false);
    expect(result.data).toMatchObject({
      location: { source: 'pdok', municipality: 'GM0344' },
      operator: 'check',
      in_zone: false,
      nearest_point: { street: 'Westplein' }
    });
    const point = result.data['nearest_point'] as { lon: number };
    expect(point.lon).toBeLessThan(5.1059);
    expect(result.data['distance_m']).toBeGreaterThan(500);
    expect(result.data['distance_m']).toBeLessThan(560);
    const mds = requests.find((r) => r.url.host === 'mds.test');
    expect(mds?.url.searchParams.get('operators')).toBe('check');
  });

  it('says when a place is inside the zone', async () => {
    const result = await call('nearest_zone', { lat: 52.09, lon: 5.1 });
    expect(result.data).toMatchObject({ in_zone: true });
  });

  it('lists metro departures with realtime and ferries without', async () => {
    const metro = await call('ov_departures', {
      halte: 'Centraal Station',
      lijn: '52',
      richting: 'Station Zuid',
      aantal: 2
    });
    expect(metro.isError).toBe(false);
    expect(metro.data).toMatchObject({
      stop: 'Centraal Station',
      lines: ['52'],
      departures: [
        {
          planned: '09:08',
          expected: '09:08',
          realtime: false,
          cancelled: false
        },
        { planned: '09:18', expected: '09:20', delay_min: 2, realtime: true }
      ]
    });

    const ferry = await call('ov_departures', {
      halte: 'Centraal Station',
      lijn: 'F3',
      na: '09:05',
      aantal: 1
    });
    expect(ferry.data).toMatchObject({
      after: '09:05',
      departures: [{ line: 'F3', planned: '09:06', realtime: false }]
    });
    expect(ferry.text).toContain('(timetable)');
  });

  it('rejects an unreadable time', async () => {
    const result = await call('ov_departures', {
      halte: 'Noord',
      na: 'straks'
    });
    expect(result.isError).toBe(true);
  });

  it('sends the subscription key on every NS call and nowhere else', () => {
    const ns = requests.filter((r) => r.url.host === 'gateway.apiportal.ns.nl');
    expect(ns.length).toBeGreaterThan(0);
    expect(ns.every((r) => r.key === 'test-key')).toBe(true);
    expect(
      requests
        .filter((r) => r.url.host !== 'gateway.apiportal.ns.nl')
        .every((r) => r.key === null)
    ).toBe(true);
    expect(requests.every((r) => !r.url.toString().includes('test-key'))).toBe(
      true
    );
  });

  it('returns an ambiguous-station error with candidates', async () => {
    const result = await call('departures', { station: 'Ede' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('ED');
    expect(result.text).toContain('EDC');
    expect(result.text).not.toMatch(/at .*\.ts:\d+/);
  });

  it('turns an upstream 404 into a readable error', async () => {
    const result = await call('disruptions', { type: 'calamity', id: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.text).toBe('NS has no data for this request.');
  });

  it.each([
    ['search_stations', { query: 'den bosch' }],
    ['trip_price', { from: 'UT', to: 'GVC' }],
    ['departures', { station: 'UT', limit: 5 }],
    ['arrivals', { station: 'UT' }],
    ['train_journey', { trainNumber: 3529 }],
    ['disruptions', {}],
    ['disruptions', { station: 'Utrecht' }],
    ['train_composition', { trainNumber: 3529, station: 'UT' }],
    ['station_facilities', { station: 'UT', include: ['lifts', 'ovfiets'] }]
  ])('%s %j works', async (name, args) => {
    const result = await call(name, args);
    expect(result.isError).toBe(false);
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.data).toBeTypeOf('object');
  });
});
