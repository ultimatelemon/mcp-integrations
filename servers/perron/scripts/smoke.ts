/**
 * Calls every tool once against a running server, as an MCP client would.
 * Usage: node scripts/smoke.ts [url]   (default http://localhost:3000/mcp)
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const url = new URL(process.argv[2] ?? 'http://localhost:3000/mcp');
const client = new Client({ name: 'perron-smoke', version: '0.0.0' });
await client.connect(new StreamableHTTPClientTransport(url));

const { tools } = await client.listTools();
console.info(`tools: ${tools.map((t) => t.name).join(', ')}`);

const calls: [string, Record<string, unknown>][] = [
  ['search_stations', { query: 'den bosch' }],
  ['plan_trip', { from: 'Utrecht', to: 'Den Haag' }],
  ['trip_price', { from: 'Utrecht', to: 'Den Haag C', returnTrip: true }],
  ['departures', { station: 'Utrecht', limit: 5 }],
  ['arrivals', { station: 'Schiphol', limit: 5 }],
  ['disruptions', {}],
  ['station_facilities', { station: 'Utrecht' }],
  ['scooters_nearby', { locatie: 'station Rotterdam Centraal' }],
  ['nearest_zone', { locatie: 'Damrak 1 Amsterdam' }],
  ['ov_departures', { halte: 'Centraal Station', lijn: '52' }],
  ['plan_trip', { from: 'Ede', to: 'Zwolle' }]
];

const departures = await client.callTool({
  name: 'departures',
  arguments: { station: 'Utrecht', limit: 10 }
});
const board = departures.structuredContent as
  { departures?: { train?: string; type?: string }[] } | undefined;
const train = Number(
  board?.departures?.find((d) => d.type === 'Intercity')?.train ?? 3500
);
calls.push(['train_journey', { trainNumber: train }]);
calls.push(['train_composition', { trainNumber: train, station: 'Utrecht' }]);

for (const [name, args] of calls) {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { text: string }[];
  const size = JSON.stringify(result.structuredContent ?? {}).length;
  console.info(
    `\n=== ${name} ${JSON.stringify(args)} ${result.isError ? 'ERROR' : 'ok'} (${String(size)} B json)`
  );
  console.info(content[0]?.text);
}
await client.close();
