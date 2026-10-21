/**
 * Calls every NS endpoint perron uses once and writes the raw responses to
 * fixtures/. Run with `npm run probe`; needs NS_API_KEY.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { createNsClient } from '../src/ns/client.ts';

const key = process.env['NS_API_KEY'];
if (!key) {
  console.error('NS_API_KEY is not set');
  process.exit(1);
}
const ns = createNsClient({ apiKey: key });
const only = process.argv.slice(2);

async function save(name: string, call: () => Promise<unknown>) {
  if (only.length > 0 && !only.includes(name)) return undefined;
  try {
    const body = await call();
    await writeFile(`fixtures/${name}.json`, JSON.stringify(body, null, 2));
    console.info(`ok   ${name}`);
    return body;
  } catch (error) {
    console.error(`fail ${name}: ${String(error)}`);
    return undefined;
  }
}

await mkdir('fixtures', { recursive: true });

await save('stations-v3', () => ns.get('/nsapp-stations/v3'));

const trips = (await save('trips', () =>
  ns.get('/reisinformatie-api/api/v3/trips', {
    fromStation: 'UT',
    toStation: 'GVC',
    viaStation: undefined
  })
)) as { trips?: { ctxRecon?: string; routeId?: string }[] } | undefined;
await save('trips-international', () =>
  ns.get('/reisinformatie-api/api/v3/trips', {
    fromStation: 'ASD',
    toStation: 'BD'
  })
);
const ctx = trips?.trips?.[0]?.ctxRecon;
if (ctx) {
  await save('trip-single', () =>
    ns.get('/reisinformatie-api/api/v3/trips/trip', { ctxRecon: ctx })
  );
}
await save('price', () =>
  ns.get('/reisinformatie-api/api/v2/price', {
    fromStation: 'UT',
    toStation: 'GVC'
  })
);
await save('price-return-first', () =>
  ns.get('/reisinformatie-api/api/v2/price', {
    fromStation: 'UT',
    toStation: 'GVC',
    travelClass: 1,
    travelType: 'return',
    adults: 2,
    children: 1
  })
);
const departures = (await save('departures', () =>
  ns.get('/reisinformatie-api/api/v2/departures', {
    station: 'UT',
    maxJourneys: 15
  })
)) as
  | {
      payload?: {
        departures?: { product?: { number?: string; categoryCode?: string } }[];
      };
    }
  | undefined;
await save('arrivals', () =>
  ns.get('/reisinformatie-api/api/v2/arrivals', {
    station: 'UT',
    maxJourneys: 15
  })
);
// A domestic train: international ones carry no times abroad and no rolling-stock data.
const trainNumber =
  departures?.payload?.departures?.find((d) =>
    ['IC', 'SPR'].includes(d.product?.categoryCode ?? '')
  )?.product?.number ?? '3500';
await save('journey', () =>
  ns.get('/reisinformatie-api/api/v2/journey', { train: trainNumber })
);
await save('disruptions', () => ns.get('/disruptions/v3', { isActive: true }));
await save('disruptions-station', () => ns.get('/disruptions/v3/station/UT'));
await save('virtual-train', () =>
  ns.get(`/virtual-train-api/v1/trein/${trainNumber}/UT`, {
    features: 'zitplaats,platformitems,drukte'
  })
);
await save('virtual-train-prognose', () =>
  ns.get(`/virtual-train-api/v1/prognose/${trainNumber}`)
);
await save('virtual-train-ingekort', () =>
  ns.get('/virtual-train-api/v2/ingekort')
);
await save('places', () =>
  ns.get('/places-api/v2/places', { station_code: 'UT', details: true })
);
await save('ovfiets', () =>
  ns.get('/places-api/v2/ovfiets', { station_code: 'UT' })
);
await save('lifts', () =>
  ns.get('/places-api/v1/stationfacility/lifts', { stationCode: 'UT' })
);
console.info(`train used for journey/composition: ${trainNumber}`);
