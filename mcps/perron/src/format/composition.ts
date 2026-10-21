import type { NsPrognose, NsTrainInfo } from '../ns/types.ts';
import type { StationIndex } from '../resolve.ts';
import { compact, crowd } from './util.ts';

const FACILITY: Record<string, string> = {
  WIFI: 'wifi',
  TOILET: 'toilet',
  STILTE: 'quiet-zone',
  FIETS: 'bicycles',
  STROOM: 'power-sockets',
  TOEGANKELIJK: 'accessible',
  BISTRO: 'bistro',
  STILTECOUPE: 'quiet-zone'
};

const CROWD_PREFIX = 'Crowdforecast.Classification.';

export function formatComposition(
  info: NsTrainInfo,
  prognose: NsPrognose | undefined,
  stations: StationIndex
) {
  const name = (code: string | undefined) =>
    code ? (stations.byCodeOrUic(code)?.name ?? code) : undefined;
  const parts = info.materieeldelen ?? [];

  return compact({
    train: info.ritnummer,
    station: name(info.station),
    track: info.spoor,
    operator: info.vervoerder,
    rollingStock: info.type,
    parts: parts.length,
    coaches: info.lengte,
    lengthM: info.lengteInMeters,
    shortened: info.ingekort,
    // Listed in platform order; NS draws the train with this side leading.
    leadingSide: info.rijrichting?.toLowerCase(),
    units: parts.map((p) => {
      const coachCrowd = (p.bakken ?? [])
        .map((b) => crowd(b.drukte?.replace(CROWD_PREFIX, '')))
        .filter((c): c is string => !!c);
      return compact({
        type: p.type,
        number: p.materieelnummer,
        coaches: p.bakken?.length,
        destination: name(p.eindbestemming),
        facilities: (p.faciliteiten ?? []).map(
          (f) => FACILITY[f] ?? f.toLowerCase()
        ),
        firstClassSeats: p.zitplaatsen?.zitplaatsEersteKlas,
        secondClassSeats: p.zitplaatsen?.zitplaatsTweedeKlas,
        bikeSpots: p.zitplaatsen?.fietsplekken,
        coachCrowd: coachCrowd.length > 0 ? coachCrowd : undefined
      });
    }),
    crowdByStation: (prognose?.prognoses ?? [])
      .map((p) =>
        compact({
          station: name(p.stationUic),
          crowd: crowd(p.classification)
        })
      )
      .filter((p) => p.crowd)
  });
}

export function summarizeComposition(
  c: ReturnType<typeof formatComposition>
): string {
  const units = (c.units ?? [])
    .map(
      (u) =>
        `${u.type ?? '?'}${u.destination ? ` to ${u.destination}` : ''}${u.firstClassSeats ? `, 1st class ${String(u.firstClassSeats)} seats` : ''}`
    )
    .join('; ');
  return [
    `Train ${String(c.train ?? '')} at ${c.station ?? '?'}${c.track ? ` track ${c.track}` : ''}: ${c.rollingStock ?? '?'}, ${String(c.parts ?? 0)} unit(s), ${String(c.coaches ?? '?')} coaches${c.lengthM ? `, ${String(c.lengthM)} m` : ''}${c.shortened ? ', SHORTENED' : ''}.`,
    units
  ]
    .filter(Boolean)
    .join('\n');
}
