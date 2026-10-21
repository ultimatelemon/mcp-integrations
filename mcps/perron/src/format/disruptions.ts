import type { NsDisruption } from '../ns/types.ts';
import { formatTime } from './time.ts';
import { compact, unique } from './util.ts';

function sections(d: NsDisruption): string[] {
  return unique(
    (d.publicationSections ?? [])
      .map((p) => {
        const stations = p.section?.stations ?? [];
        const first = stations[0]?.name;
        const last = stations.at(-1)?.name;
        if (!first) return '';
        return last && last !== first ? `${first} - ${last}` : first;
      })
      .filter(Boolean)
  );
}

function stationCodes(d: NsDisruption): string[] {
  return unique(
    (d.publicationSections ?? []).flatMap((p) =>
      (p.section?.stations ?? []).map((s) => s.stationCode ?? '')
    )
  ).filter(Boolean);
}

function current(d: NsDisruption) {
  return d.timespans?.[0];
}

export function formatDisruption(d: NsDisruption, now: Date, detail: boolean) {
  if (d.type === 'CALAMITY') {
    return compact({
      id: d.id,
      type: 'calamity',
      title: d.title,
      description: d.description,
      priority: d.priority,
      updated: formatTime(d.lastUpdated, now),
      nextUpdate: formatTime(d.expectedNextUpdate, now),
      url: d.url
    });
  }
  const span = current(d);
  const alternative = (d.alternativeTransportTimespans ?? []).flatMap((t) =>
    (t.alternativeTransport?.location ?? []).map((l) =>
      [l.station?.name, l.description].filter(Boolean).join(': ')
    )
  );
  return compact({
    id: d.id,
    type: d.type.toLowerCase(),
    title: d.title,
    active: d.isActive,
    phase: d.phase?.label,
    start: formatTime(d.start, now),
    end: formatTime(d.end, now),
    expected: d.expectedDuration?.description,
    routes: sections(d),
    cause: span?.cause?.label,
    situation: span?.situation?.label,
    consequence: d.publicationSections?.[0]?.consequence?.description,
    extraTravelTime:
      d.summaryAdditionalTravelTime?.shortLabel ??
      span?.additionalTravelTime?.shortLabel,
    alternativeTransport: span?.alternativeTransport?.shortLabel,
    ...(detail
      ? {
          period: span?.period ?? d.period ?? undefined,
          advice: span?.advices,
          alternativeTransportStops: unique(alternative),
          stations: stationCodes(d),
          laterPhases: (d.timespans ?? []).slice(1).map((t) =>
            compact({
              start: formatTime(t.start, now),
              end: formatTime(t.end, now),
              situation: t.situation?.label
            })
          )
        }
      : {})
  });
}

export type FormattedDisruption = ReturnType<typeof formatDisruption>;

export function summarizeDisruptions(
  scope: string,
  items: FormattedDisruption[]
): string {
  if (items.length === 0) return `No disruptions or maintenance for ${scope}.`;
  const lines = items.map((d) => {
    const when =
      'start' in d ? [d.start, d.end].filter(Boolean).join(' - ') : '';
    return `[${d.type ?? ''}] ${d.title ?? ''}${when ? ` (${when})` : ''}${'cause' in d && d.cause ? `, cause: ${d.cause}` : ''}`;
  });
  return [`${String(items.length)} item(s) for ${scope}:`, ...lines].join('\n');
}
