import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../context.ts';
import { formatStation } from '../format/stations.ts';
import { ok, READ_ONLY, run } from './result.ts';

export function registerSearchStations(server: McpServer, deps: Deps) {
  server.registerTool(
    'search_stations',
    {
      title: 'Search stations',
      description:
        'Find NS stations by name, synonym, NS code or UIC code, tolerating typos. Use it to look up a station code or check tracks and accessibility. Other tools accept station names directly, so this is only needed when a name was ambiguous.',
      inputSchema: {
        query: z.string().min(1).describe('Name, part of a name, or code'),
        limit: z.number().int().min(1).max(25).optional().describe('Default 8')
      },
      annotations: READ_ONLY
    },
    ({ query, limit }) =>
      run(deps.logger, async () => {
        const index = await deps.stations();
        const stations = index
          .search(query, limit ?? 8)
          .map((m) => formatStation(m.station));
        const summary =
          stations.length === 0
            ? `No stations match "${query}".`
            : stations
                .map((s) => `${s.name ?? ''} (${s.code ?? ''})`)
                .join(', ');
        return ok(summary, { stations });
      })
  );
}
