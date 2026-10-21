/**
 * Checks scooters_nearby, nearest_zone and ov_departures against a running
 * server with live data, using places measured by hand on 6 October 2026.
 * Usage: node scripts/check-last-mile.ts [url]   (default http://localhost:3000/mcp)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.argv[2] ?? 'http://localhost:3000/mcp');
const client = new Client({ name: 'perron-last-mile', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(url));

let failures = 0;
function check(label: string, pass: boolean, detail: string) {
  if (!pass) failures++;
  console.info(`${pass ? 'ok  ' : 'FAIL'} ${label}: ${detail}`);
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { text: string }[])[0]?.text ?? '';
  if (result.isError) throw new Error(text);
  return result.structuredContent as Record<string, unknown>;
}

const zones: [string, number, number, number, string][] = [
  ['Station Almere Muziekwijk', 52.36756, 5.19034, 375, 'Cellostraat'],
  ['Pont Buiksloterweg Noord', 52.38272, 4.90324, 10, 'Buiksloterweg'],
  ['Amsterdam Centraal', 52.3789, 4.90058, 330, 'De Ruijterkade'],
  ['Amstel', 52.34647, 4.91756, 110, 'Amstelplein']
];
for (const [label, lat, lon, metres, street] of zones) {
  try {
    const zone = await call('nearest_zone', { lat, lon });
    const point = zone['nearest_point'] as { street?: string } | undefined;
    const distance = Number(zone['distance_m']);
    check(
      `zone ${label}`,
      zone['in_zone'] === false &&
        Math.abs(distance - metres) <= Math.max(25, metres * 0.15) &&
        point?.street === street,
      `in_zone=${String(zone['in_zone'])}, ${String(distance)} m (expected ~${String(metres)}), ${point?.street ?? '?'} (expected ${street})`
    );
  } catch (error) {
    check(`zone ${label}`, false, String(error));
  }
}

try {
  const place = await call('scooters_nearby', {
    locatie: 'station Almere Muziekwijk'
  });
  const location = place['location'] as {
    lat: number;
    lon: number;
    source: string;
  };
  check(
    'geocode station Almere Muziekwijk',
    Math.abs(location.lat - 52.36756) < 0.002 &&
      Math.abs(location.lon - 5.19034) < 0.003,
    `${String(location.lat)}, ${String(location.lon)} via ${location.source}; ${String(place['count'])} Check scooters within 500 m`
  );
} catch (error) {
  check('geocode station Almere Muziekwijk', false, String(error));
}

const ov: [string, Record<string, unknown>, boolean][] = [
  [
    'metro 52 Centraal Station → Noord',
    { halte: 'Centraal Station', lijn: '52', richting: 'Noord' },
    true
  ],
  ['pont F3 Centraal Station', { halte: 'Centraal Station', lijn: 'F3' }, false]
];
for (const [label, args, realtime] of ov) {
  try {
    const board = await call('ov_departures', args);
    const departures = board['departures'] as {
      planned: string;
      realtime: boolean;
    }[];
    check(
      label,
      departures.length > 0 &&
        departures.some((d) => d.realtime === realtime) &&
        departures.every((d) =>
          /^(\d{4}-\d{2}-\d{2} )?\d{2}:\d{2}$/.test(d.planned)
        ),
      `${String(board['stop'])}: ${departures.map((d) => `${d.planned}${d.realtime ? '*' : ''}`).join(' ')}`
    );
  } catch (error) {
    check(label, false, String(error));
  }
}

await client.close();
process.exit(failures > 0 ? 1 : 0);
