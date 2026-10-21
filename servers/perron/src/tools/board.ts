import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Deps } from '../context.ts';
import { TTL } from '../context.ts';
import { formatBoardEntry, summarizeBoard } from '../format/board.ts';
import { getStationBoard, type BoardKind } from '../ns/reisinformatie.ts';
import { station } from './schema.ts';
import { ok, READ_ONLY, run } from './result.ts';

const DESCRIPTIONS: Record<BoardKind, string> = {
  departures:
    'Live departure board of a station: next trains with delays, destinations, tracks and track changes, cancellations and notices. Use for "when does the next train to X leave" or "which track".',
  arrivals:
    'Live arrival board of a station: incoming trains with origins, delays, tracks and cancellations. Use when picking someone up or checking if a train has arrived.'
};

function registerBoard(server: McpServer, deps: Deps, kind: BoardKind) {
  server.registerTool(
    kind,
    {
      title: kind === 'departures' ? 'Departures' : 'Arrivals',
      description: DESCRIPTIONS[kind],
      inputSchema: {
        station: station('Station'),
        limit: z.number().int().min(1).max(40).optional().describe('Default 15')
      },
      annotations: READ_ONLY
    },
    (input) =>
      run(deps.logger, async () => {
        const index = await deps.stations();
        const s = index.resolve(input.station);
        const limit = input.limit ?? 15;
        const raw = await deps.cache.wrap(
          `${kind}:${s.code}:${String(limit)}`,
          TTL.live,
          () => getStationBoard(deps.ns, kind, s.code, limit)
        );
        const now = deps.now();
        const entries = raw.map((e) => formatBoardEntry(e, kind, now));
        return ok(summarizeBoard(kind, s.name, entries), {
          station: s.name,
          code: s.code,
          [kind]: entries
        });
      })
  );
}

export function registerDepartures(server: McpServer, deps: Deps) {
  registerBoard(server, deps, 'departures');
}

export function registerArrivals(server: McpServer, deps: Deps) {
  registerBoard(server, deps, 'arrivals');
}
