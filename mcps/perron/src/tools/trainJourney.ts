import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../context.ts';
import { TTL } from '../context.ts';
import { NotFound } from '../errors.ts';
import { formatJourney, summarizeJourney } from '../format/journey.ts';
import { toNsDateTime } from '../format/time.ts';
import { getJourney } from '../ns/reisinformatie.ts';
import { dateTime, trainNumber } from './schema.ts';
import { ok, READ_ONLY, run } from './result.ts';

export function registerTrainJourney(server: McpServer, deps: Deps) {
  server.registerTool(
    'train_journey',
    {
      title: 'Train route and stops',
      description:
        'All stops of one train by train number, with times, tracks, delays and crowding per stop. Use to see where a train stops, when it reaches a station, or how late it runs.',
      inputSchema: {
        trainNumber,
        dateTime,
        includePassing: z
          .boolean()
          .optional()
          .describe('Also list stations the train passes without stopping')
      },
      annotations: READ_ONLY
    },
    (input) =>
      run(deps.logger, async () => {
        const at = toNsDateTime(input.dateTime);
        const journey = await deps.cache.wrap(
          `journey:${String(input.trainNumber)}:${at ?? 'now'}`,
          TTL.live,
          () => getJourney(deps.ns, input.trainNumber, at)
        );
        if (!journey.stops?.length) {
          throw new NotFound(
            `No journey found for train ${String(input.trainNumber)}.`
          );
        }
        const result = formatJourney(
          journey,
          deps.now(),
          input.includePassing ?? false
        );
        return ok(summarizeJourney(result), result);
      })
  );
}
