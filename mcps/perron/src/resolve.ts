import { AmbiguousStation, StationNotFound } from './errors.ts';
import type { NsStationV3 } from './ns/types.ts';

export interface Station {
  code: string;
  uic: string;
  name: string;
  shortName: string | undefined;
  synonyms: string[];
  type: string | undefined;
  country: string | undefined;
  tracks: string[];
  accessible: boolean;
  travelAssistance: boolean;
  location: { lat: number; lng: number } | undefined;
}

export interface Match {
  station: Station;
  score: number;
}

const EXACT = 900;
// A runner-up this far behind the best match is not a real alternative.
const CLEAR_LEAD = 150;

const TYPE_WEIGHT: Record<string, number> = {
  MEGA_STATION: 8,
  INTERCITY_HUB_STATION: 7,
  EXPRESS_TRAIN_HUB_STATION: 6,
  INTERCITY_STATION: 5,
  EXPRESS_TRAIN_STATION: 4,
  LOCAL_TRAIN_HUB_STATION: 3,
  LOCAL_TRAIN_STATION: 2,
  OPTIONAL_STATION: 1
};

export function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Optimal string alignment distance: Levenshtein plus adjacent transpositions. */
export function editDistance(a: string, b: string, max = Infinity): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) =>
    Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i < rows; i++) {
    let rowMin = Infinity;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const row = d[i]!;
      const prev = d[i - 1]!;
      let value = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, d[i - 2]![j - 2]! + 1);
      }
      row[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > max) return max + 1;
  }
  return d[a.length]![b.length]!;
}

function allowedTypos(length: number): number {
  if (length <= 3) return 0;
  if (length <= 6) return 1;
  if (length <= 11) return 2;
  return 3;
}

export function scoreName(
  query: string,
  name: string,
  synonym: boolean
): number {
  if (!name) return 0;
  if (name === query) return synonym ? EXACT - 20 : EXACT;
  if (name.startsWith(query))
    return 700 - Math.min(50, name.length - query.length);

  const queryWords = query.split(' ');
  const nameWords = name.split(' ');
  if (queryWords.every((q) => nameWords.some((w) => w.startsWith(q)))) {
    return 600;
  }
  if (query.length >= 3 && name.includes(query)) return 500;

  const typos = allowedTypos(query.length);
  if (typos === 0) return 0;
  const whole = editDistance(query, name, typos);
  // Also compare against the name's head, so "utrect" finds "utrecht centraal".
  const head = editDistance(query, name.slice(0, query.length), typos);
  const best = Math.min(whole, head + (whole <= typos ? 0 : 1));
  return best <= typos ? 400 - best * 60 : 0;
}

interface Entry {
  station: Station;
  names: { text: string; synonym: boolean }[];
}

function toStation(raw: NsStationV3): Station {
  return {
    code: raw.id.code,
    uic: raw.id.uicCode,
    name: raw.names.long,
    shortName: raw.names.medium,
    synonyms: raw.names.synonyms ?? [],
    type: raw.stationType,
    country: raw.country,
    tracks: raw.tracks ?? [],
    accessible: raw.availableForAccessibleTravel ?? false,
    travelAssistance: raw.hasTravelAssistance ?? false,
    location: raw.location
  };
}

export class StationIndex {
  readonly size: number;
  private readonly entries: Entry[];
  private readonly byCode = new Map<string, Station>();
  private readonly byUic = new Map<string, Station>();

  constructor(raw: NsStationV3[]) {
    this.entries = raw.map((item) => {
      const station = toStation(item);
      this.byCode.set(station.code.toUpperCase(), station);
      this.byUic.set(station.uic, station);
      if (item.id.evaCode && !this.byUic.has(item.id.evaCode)) {
        this.byUic.set(item.id.evaCode, station);
      }
      const names = [
        { text: item.names.long, synonym: false },
        { text: item.names.medium ?? '', synonym: false },
        { text: item.names.short ?? '', synonym: false },
        ...station.synonyms.map((text) => ({ text, synonym: true }))
      ]
        .map((n) => ({ text: normalize(n.text), synonym: n.synonym }))
        .filter((n) => n.text);
      return { station, names };
    });
    this.size = this.entries.length;
  }

  byCodeOrUic(value: string): Station | undefined {
    const trimmed = value.trim();
    return this.byCode.get(trimmed.toUpperCase()) ?? this.byUic.get(trimmed);
  }

  search(query: string, limit = 10): Match[] {
    const direct = this.byCodeOrUic(query);
    const q = normalize(query);
    if (!q && !direct) return [];

    const matches: Match[] = [];
    for (const entry of this.entries) {
      let score = 0;
      if (direct === entry.station) score = 1000;
      else if (q) {
        for (const name of entry.names) {
          score = Math.max(score, scoreName(q, name.text, name.synonym));
        }
      }
      if (score > 0) {
        const type = TYPE_WEIGHT[entry.station.type ?? ''] ?? 0;
        const home = entry.station.country === 'NL' ? 2 : 0;
        matches.push({ station: entry.station, score: score + type + home });
      }
    }
    matches.sort(
      (a, b) =>
        b.score - a.score || a.station.name.localeCompare(b.station.name)
    );
    return matches.slice(0, limit);
  }

  /** One station for a code, UIC or name; throws when there is none or no clear winner. */
  resolve(query: string): Station {
    const matches = this.search(query, 6);
    const [best, second] = matches;
    if (!best) throw new StationNotFound(query);
    if (!second) return best.station;

    if (best.score >= EXACT) {
      const tied = matches.filter(
        (m) => m.score >= EXACT && best.score - m.score < 10
      );
      if (tied.length === 1) return best.station;
      throw new AmbiguousStation(query, tied.map(candidate));
    }
    if (best.score - second.score >= CLEAR_LEAD) return best.station;
    const close = matches.filter((m) => best.score - m.score < CLEAR_LEAD);
    throw new AmbiguousStation(query, close.slice(0, 5).map(candidate));
  }
}

function candidate(match: Match) {
  return { name: match.station.name, code: match.station.code };
}
