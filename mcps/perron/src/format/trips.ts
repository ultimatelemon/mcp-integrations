import type {
  NsLeg,
  NsLegStop,
  NsNote,
  NsTrip,
  NsTripStop,
  NsTripsResponse
} from '../ns/types.ts';
import { delayMinutes, formatTime } from './time.ts';
import { compact, crowd, euros, positiveDelay, unique } from './util.ts';

export type TripStatus =
  | 'normal'
  | 'delayed'
  | 'cancelled'
  | 'alternative-transport'
  | 'transfer-not-possible'
  | 'disruption'
  | 'maintenance'
  | 'uncertain'
  | 'other';

const STATUS: Record<string, TripStatus> = {
  NORMAL: 'normal',
  CANCELLED: 'cancelled',
  ALTERNATIVE_TRANSPORT: 'alternative-transport',
  REPLACEMENT: 'alternative-transport',
  CHANGE_NOT_POSSIBLE: 'transfer-not-possible',
  DISRUPTION: 'disruption',
  MAINTENANCE: 'maintenance',
  UNCERTAIN: 'uncertain'
};

// Product attributes NS also shows in the leg header; repeating them is noise.
const SKIP_NOTE_KEYS = new Set([
  'PRODUCT_NAME',
  'PRODUCT_DIRECTION',
  'PRODUCT_INTERMEDIATE_STOPS'
]);

export function stopPoint(stop: NsTripStop, now: Date) {
  const trackChanged =
    !!stop.plannedTrack &&
    !!stop.actualTrack &&
    stop.plannedTrack !== stop.actualTrack;
  const delay = delayMinutes(stop.plannedDateTime, stop.actualDateTime);
  return compact({
    station: stop.name,
    code: stop.stationCode,
    time: formatTime(stop.plannedDateTime, now),
    actualTime: delay ? formatTime(stop.actualDateTime, now) : undefined,
    delayMin: positiveDelay(delay),
    track: stop.actualTrack ?? stop.plannedTrack,
    plannedTrack: trackChanged ? stop.plannedTrack : undefined,
    trackChanged,
    cancelled: stop.cancelled
  });
}

function noteTexts(notes: NsNote[] | undefined): string[] {
  return (notes ?? [])
    .filter(
      (note) =>
        note.isPresentationRequired &&
        note.value &&
        !SKIP_NOTE_KEYS.has(note.key ?? '')
    )
    .map((note) => note.value!);
}

function legMessages(leg: NsLeg): string[] {
  return unique([
    ...(leg.messages ?? []).map((m) => m.head ?? m.text ?? '').filter(Boolean),
    ...noteTexts(leg.notes),
    ...noteTexts(leg.origin.notes),
    ...noteTexts(leg.destination.notes),
    ...(leg.transferMessages ?? []).map((m) => m.message ?? '').filter(Boolean)
  ]);
}

/** Calling points between a leg's origin and destination; passing stations are left out. */
function intermediateStops(leg: NsLeg, now: Date) {
  return (leg.stops ?? [])
    .slice(1, -1)
    .filter((s: NsLegStop) => !s.passing)
    .map((s) => {
      const planned = s.plannedDepartureDateTime ?? s.plannedArrivalDateTime;
      const actual = s.actualDepartureDateTime ?? s.actualArrivalDateTime;
      const delay = delayMinutes(planned, actual);
      const plannedTrack = s.plannedDepartureTrack ?? s.plannedArrivalTrack;
      const actualTrack = s.actualDepartureTrack ?? s.actualArrivalTrack;
      const trackChanged =
        !!plannedTrack && !!actualTrack && plannedTrack !== actualTrack;
      return compact({
        station: s.name,
        time: formatTime(planned, now),
        delayMin: positiveDelay(delay),
        track: actualTrack ?? plannedTrack,
        plannedTrack: trackChanged ? plannedTrack : undefined,
        trackChanged,
        cancelled: s.cancelled
      });
    });
}

function formatLeg(leg: NsLeg, now: Date, withStops: boolean) {
  const product = leg.product;
  const isTransit = (leg.travelType ?? 'PUBLIC_TRANSIT') === 'PUBLIC_TRANSIT';
  return compact({
    mode: isTransit ? undefined : leg.travelType?.toLowerCase(),
    operator: product?.operatorName,
    type: product?.longCategoryName ?? product?.shortCategoryName,
    train: product?.number,
    direction: leg.direction,
    from: stopPoint(leg.origin, now),
    to: stopPoint(leg.destination, now),
    crowd: crowd(leg.crowdForecast),
    cancelled: leg.cancelled,
    partCancelled: leg.partCancelled,
    alternativeTransport: leg.alternativeTransport,
    shorterTrain: leg.shorterStock,
    transferNotPossible: leg.changePossible === false ? true : undefined,
    messages: legMessages(leg),
    stops: withStops ? intermediateStops(leg, now) : undefined
  });
}

export function tripStatus(trip: NsTrip): TripStatus {
  const legs = trip.legs;
  if (trip.status === 'CANCELLED' || legs.some((l) => l.cancelled)) {
    return 'cancelled';
  }
  const mapped = STATUS[trip.status ?? 'NORMAL'] ?? 'other';
  if (mapped !== 'normal') return mapped;
  if (legs.some((l) => l.alternativeTransport)) return 'alternative-transport';
  const first = legs[0]?.origin;
  const last = legs.at(-1)?.destination;
  const delays = [
    delayMinutes(first?.plannedDateTime, first?.actualDateTime),
    delayMinutes(last?.plannedDateTime, last?.actualDateTime)
  ];
  return delays.some((d) => d !== undefined && d > 0) ? 'delayed' : 'normal';
}

export function formatTrip(trip: NsTrip, now: Date, withStops = false) {
  const first = trip.legs[0]?.origin;
  const last = trip.legs.at(-1)?.destination;
  const depDelay = delayMinutes(first?.plannedDateTime, first?.actualDateTime);
  const arrDelay = delayMinutes(last?.plannedDateTime, last?.actualDateTime);
  const fare = trip.productFare;
  return compact({
    departure: formatTime(first?.plannedDateTime, now),
    actualDeparture: depDelay
      ? formatTime(first?.actualDateTime, now)
      : undefined,
    arrival: formatTime(last?.plannedDateTime, now),
    actualArrival: arrDelay ? formatTime(last?.actualDateTime, now) : undefined,
    delayMin: positiveDelay(arrDelay ?? depDelay),
    durationMin: trip.actualDurationInMinutes ?? trip.plannedDurationInMinutes,
    transfers: trip.transfers ?? 0,
    status: tripStatus(trip),
    crowd: crowd(trip.crowdForecast),
    priceEur: fare?.priceInCents ? euros(fare.priceInCents) : undefined,
    priceClass: fare?.travelClass === 'FIRST_CLASS' ? 1 : undefined,
    messages: unique(
      (trip.messages ?? []).map((m) => m.head ?? m.text ?? '').filter(Boolean)
    ),
    legs: trip.legs.map((leg) => formatLeg(leg, now, withStops))
  });
}

export type FormattedTrip = ReturnType<typeof formatTrip>;

export function formatTrips(
  response: NsTripsResponse,
  now: Date,
  maxOptions: number
) {
  const trips = (response.trips ?? []).slice(0, maxOptions);
  return trips.map((trip) => formatTrip(trip, now));
}

export function summarizeTrips(
  from: string,
  to: string,
  options: FormattedTrip[]
): string {
  if (options.length === 0) return `No trips found from ${from} to ${to}.`;
  const lines = options.map((o) => {
    const legs = (o.legs ?? [])
      .map((l) => [l.type, l.train].filter(Boolean).join(' '))
      .filter(Boolean)
      .join(' + ');
    const flags = o.status && o.status !== 'normal' ? ` [${o.status}]` : '';
    return `${o.departure ?? '?'} → ${o.arrival ?? '?'} (${String(o.durationMin ?? '?')} min, ${String(o.transfers ?? 0)}x transfer) ${legs}${flags}`;
  });
  return [`Trips ${from} → ${to}:`, ...lines].join('\n');
}
