import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Deps } from '../context.ts';
import { TTL } from '../context.ts';
import {
  formatComposition,
  summarizeComposition
} from '../format/composition.ts';
import { getPrognose, getTrainInfo } from '../ns/virtualTrain.ts';
import { station, trainNumber } from './schema.ts';
import { ok, READ_ONLY, run } from './result.ts';

export function registerTrainComposition(server: McpServer, deps: Deps) {
  server.registerTool(
    'train_composition',
    {
      title: 'Train composition and crowding',
      description:
        'Rolling stock of one train: type, units, coaches, length, facilities per unit (quiet zone, toilet, bicycles, wifi), first-class seats, where units split off, whether it runs shortened, and expected crowding per station. Pass a station for the composition as it calls there.',
      inputSchema: {
        trainNumber,
        station: station('Station where you board').optional()
      },
      annotations: READ_ONLY
    },
    (input) =>
      run(deps.logger, async () => {
        const index = await deps.stations();
        const s = input.station ? index.resolve(input.station) : undefined;
        const key = `${String(input.trainNumber)}:${s?.code ?? '-'}`;
        const [info, prognose] = await Promise.all([
          deps.cache.wrap(`composition:${key}`, TTL.live, () =>
            getTrainInfo(deps.ns, input.trainNumber, s?.code)
          ),
          deps.cache
            .wrap(`prognose:${String(input.trainNumber)}`, TTL.live, () =>
              getPrognose(deps.ns, input.trainNumber)
            )
            // Crowding is a bonus; the composition is still useful without it.
            .catch(() => undefined)
        ]);
        const result = formatComposition(info, prognose, index);
        return ok(summarizeComposition(result), result);
      })
  );
}
