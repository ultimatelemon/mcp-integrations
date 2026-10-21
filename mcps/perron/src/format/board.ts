import type { NsBoardEntry } from '../ns/types.ts';
import type { BoardKind } from '../ns/reisinformatie.ts';
import { delayMinutes, formatTime } from './time.ts';
import { compact, positiveDelay, unique } from './util.ts';

export function formatBoardEntry(
  entry: NsBoardEntry,
  kind: BoardKind,
  now: Date
) {
  const delay = delayMinutes(entry.plannedDateTime, entry.actualDateTime);
  const trackChanged =
    !!entry.plannedTrack &&
    !!entry.actualTrack &&
    entry.plannedTrack !== entry.actualTrack;
  const product = entry.product;
  return compact({
    time: formatTime(entry.plannedDateTime, now),
    actualTime: delay ? formatTime(entry.actualDateTime, now) : undefined,
    delayMin: positiveDelay(delay),
    ...(kind === 'departures'
      ? { direction: entry.direction }
      : { origin: entry.origin }),
    via:
      kind === 'departures'
        ? (entry.routeStations ?? [])
            .map((s) => s.mediumName ?? '')
            .filter(Boolean)
            .slice(0, 4)
        : undefined,
    type: product?.longCategoryName ?? entry.trainCategory,
    train: product?.number,
    operator:
      product?.operatorName && product.operatorName !== 'NS'
        ? product.operatorName
        : undefined,
    track: entry.actualTrack ?? entry.plannedTrack,
    plannedTrack: trackChanged ? entry.plannedTrack : undefined,
    trackChanged,
    cancelled: entry.cancelled,
    messages: unique(
      (entry.messages ?? []).map((m) => m.message ?? '').filter(Boolean)
    )
  });
}

export type BoardEntry = ReturnType<typeof formatBoardEntry>;

export function summarizeBoard(
  kind: BoardKind,
  station: string,
  entries: BoardEntry[]
): string {
  if (entries.length === 0) return `No ${kind} found for ${station}.`;
  const lines = entries.map((e) => {
    const place =
      'direction' in e ? e.direction : 'origin' in e ? e.origin : '';
    const parts = [
      e.time,
      e.delayMin ? `+${String(e.delayMin)}` : '',
      `${e.type ?? ''} ${e.train ?? ''}`.trim(),
      kind === 'departures' ? `to ${place ?? '?'}` : `from ${place ?? '?'}`,
      e.track ? `track ${e.track}${e.trackChanged ? ' (changed)' : ''}` : '',
      e.cancelled ? 'CANCELLED' : ''
    ];
    return parts.filter(Boolean).join(' ');
  });
  return [
    `${kind === 'departures' ? 'Departures' : 'Arrivals'} ${station}:`,
    ...lines
  ].join('\n');
}
