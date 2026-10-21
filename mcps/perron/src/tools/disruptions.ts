import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../context.ts';
import { TTL } from '../context.ts';
import {
  formatDisruption,
  summarizeDisruptions
} from '../format/disruptions.ts';
import {
  getDisruption,
  listDisruptions,
  stationDisruptions
} from '../ns/disruptions.ts';
import { station } from './schema.ts';
import { ok, READ_ONLY, run } from './result.ts';

const TYPES = ['disruption', 'maintenance', 'calamity'] as const;

export function registerDisruptions(server: McpServer, deps: Deps) {
  server.registerTool(
    'disruptions',
    {
      title: 'Disruptions and engineering works',
      description:
        'Current train disruptions, engineering works and calamities in the Netherlands, optionally for one station. Pass type and id to get full details (cause, advice, alternative transport) of one item from an earlier list.',
      inputSchema: {
        station: station('Only items affecting this station').optional(),
        type: z
          .enum(TYPES)
          .optional()
          .describe('Filter by kind; required together with id'),
        activeOnly: z
          .boolean()
          .optional()
          .describe(
            'Only items in effect right now; default true. Ignored with station.'
          ),
        id: z
          .string()
          .optional()
          .describe('Disruption id from a previous result')
      },
      annotations: READ_ONLY
    },
    (input) =>
      run(deps.logger, async () => {
        const now = deps.now();
        if (input.id) {
          const type = input.type ?? 'disruption';
          const item = await deps.cache.wrap(
            `disruption:${type}:${input.id}`,
            TTL.disruptions,
            () => getDisruption(deps.ns, type, input.id!)
          );
          const formatted = formatDisruption(item, now, true);
          return ok(
            summarizeDisruptions(`id ${input.id}`, [formatted]),
            formatted
          );
        }

        if (input.station) {
          const s = (await deps.stations()).resolve(input.station);
          const raw = await deps.cache.wrap(
            `disruptions:station:${s.code}`,
            TTL.disruptions,
            () => stationDisruptions(deps.ns, s.code)
          );
          const items = raw
            .filter((d) => !input.type || d.type.toLowerCase() === input.type)
            .map((d) => formatDisruption(d, now, false));
          return ok(summarizeDisruptions(s.name, items), {
            station: s.name,
            items
          });
        }

        const activeOnly = input.activeOnly ?? true;
        const raw = await deps.cache.wrap(
          `disruptions:${String(activeOnly)}:${input.type ?? 'all'}`,
          TTL.disruptions,
          () => listDisruptions(deps.ns, { activeOnly, type: input.type })
        );
        const items = raw.map((d) => formatDisruption(d, now, false));
        return ok(summarizeDisruptions('the Netherlands', items), { items });
      })
  );
}
