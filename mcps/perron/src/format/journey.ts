import type { NsArrivalOrDeparture, NsJourney } from '../ns/types.ts';
import { delayMinutes, formatTime } from './time.ts';
import { compact, crowd, positiveDelay } from './util.ts';

function event(e: NsArrivalOrDeparture | undefined, now: Date) {
  if (!e) return {};
  const delay =
    e.delayInSeconds !== undefined
      ? Math.round(e.delayInSeconds / 60)
      : delayMinutes(e.plannedTime, e.actualTime);
  return { time: formatTime(e.plannedTime, now), delay };
}

export function formatJourney(journey: NsJourney, now: Date, all: boolean) {
  const stops = (journey.stops ?? []).filter(
    (s) => all || s.status !== 'PASSING'
  );
  const first = journey.stops?.find((s) => s.departures?.[0]?.product)
    ?.departures?.[0]?.product;
  const stock = journey.stops?.find((s) => s.actualStock ?? s.plannedStock);
  const stockInfo = stock?.actualStock ?? stock?.plannedStock;

  return compact({
    train: first?.number ?? journey.productNumbers?.[0],
    type: first?.longCategoryName,
    operator: first?.operatorName,
    destination: journey.stops?.at(-1)?.stop.name,
    rollingStock: stockInfo?.trainType,
    seats: stockInfo?.numberOfSeats,
    stops: stops.map((s) => {
      const arr = s.arrivals?.[0];
      const dep = s.departures?.[0];
      const a = event(arr, now);
      const d = event(dep, now);
      const e = dep ?? arr;
      const plannedTrack = e?.plannedTrack;
      const actualTrack = e?.actualTrack;
      const trackChanged =
        !!plannedTrack && !!actualTrack && plannedTrack !== actualTrack;
      return compact({
        station: s.stop.name,
        arrival: a.time,
        departure: d.time,
        delayMin: positiveDelay(d.delay ?? a.delay),
        track: actualTrack ?? plannedTrack,
        plannedTrack: trackChanged ? plannedTrack : undefined,
        trackChanged,
        cancelled: (arr?.cancelled ?? false) || (dep?.cancelled ?? false),
        passing: s.status === 'PASSING',
        crowd: crowd(dep?.crowdForecast ?? arr?.crowdForecast)
      });
    })
  });
}

export function summarizeJourney(j: ReturnType<typeof formatJourney>): string {
  const stops = j.stops ?? [];
  const head = `${j.type ?? 'Train'} ${j.train ?? ''} to ${j.destination ?? '?'}`;
  const lines = stops.map((s) => {
    const time = s.departure ?? s.arrival ?? '';
    return `${time} ${s.station ?? ''}${s.track ? ` (${s.track})` : ''}${s.delayMin ? ` +${String(s.delayMin)}` : ''}${s.cancelled ? ' CANCELLED' : ''}`;
  });
  return [head, ...lines].join('\n');
}
