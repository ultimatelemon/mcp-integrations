import type { NsLift, NsOpeningHours, NsPlaceGroup } from '../ns/types.ts';
import { compact } from './util.ts';

const SEPARATE = new Set(['Lift', 'OV-fiets']);

function hoursToday(
  hours: NsOpeningHours[] | undefined,
  isoWeekday: number
): string | undefined {
  const today = hours?.find((h) => h.dayOfWeek === isoWeekday);
  if (!today?.startTime || !today.endTime) return undefined;
  if (today.startTime === '00:00' && today.endTime === '24:00') return '24h';
  return `${today.startTime}-${today.endTime}`;
}

export function formatOvFiets(groups: NsPlaceGroup[]) {
  return groups
    .flatMap((g) => g.locations ?? [])
    .map((l) => {
      const available = Number(l.extra?.['rentalBikes']);
      return compact({
        name: l.description ?? l.name,
        available: Number.isFinite(available) ? available : undefined,
        staffed: l.extra?.['serviceType'] === 'Bemenst' ? true : undefined,
        open: l.open === 'No' ? 'closed' : undefined,
        address: [l.street?.trim(), l.houseNumber].filter(Boolean).join(' ')
      });
    });
}

/** Out-of-order lifts first: that is what a traveller with luggage or a wheelchair needs. */
export function formatLifts(lifts: NsLift[]) {
  const out = lifts.filter((l) => l.open !== 'Yes');
  return {
    total: lifts.length,
    outOfOrder: out.map((l) =>
      compact({ name: l.name, platform: l.platform, status: l.statusLabel })
    ),
    available: lifts.length - out.length
  };
}

export function formatFacilities(groups: NsPlaceGroup[], isoWeekday: number) {
  const facilities = [];
  const shops: string[] = [];
  for (const group of groups) {
    if (!group.name || SEPARATE.has(group.name)) continue;
    const locations = group.locations ?? [];
    const first = locations[0];
    const count = locations.length > 1 ? locations.length : undefined;
    const hours = hoursToday(first?.openingHours, isoWeekday);
    const closedNow = first?.open === 'No';
    if (group.type === 'station-retail') {
      shops.push(
        [
          group.name + (count ? ` (${String(count)}x)` : ''),
          hours,
          closedNow ? '(closed now)' : ''
        ]
          .filter(Boolean)
          .join(' ')
      );
      continue;
    }
    facilities.push(
      compact({
        name: group.name,
        where: first?.description?.trim(),
        count,
        hoursToday: hours,
        closedNow
      })
    );
  }
  return { facilities, shops };
}
