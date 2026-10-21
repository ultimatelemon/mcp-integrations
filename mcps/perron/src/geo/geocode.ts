import { NotFound } from '../errors.ts';
import { compact } from '../format/util.ts';
import type { DurableStore } from '../lib/store.ts';
import type { Logger } from '../lib/logger.ts';
import { editDistance, normalize, type StationIndex } from '../resolve.ts';
import type { Nominatim } from './nominatim.ts';
import { municipalityCode, parsePoint, type Pdok } from './pdok.ts';

/** Where a tool searched, returned with every answer so a wrong geocode is visible. */
export interface Place {
  query?: string;
  lat: number;
  lon: number;
  /** What the query was matched to: a station, a street, a place name. */
  name?: string;
  /** The nearest address to the point. */
  address?: string;
  street?: string;
  /** CBS code, e.g. `GM0363` for Amsterdam. */
  municipality?: string;
  source: 'ns' | 'pdok' | 'nominatim' | 'coordinates';
}

interface Address {
  address?: string;
  street?: string;
  municipality?: string;
  distanceM?: number;
}

export interface GeocoderDeps {
  pdok: Pdok;
  nominatim: Nominatim;
  stations: () => Promise<StationIndex>;
  store: DurableStore;
  logger: Logger;
}

const NOISE = new Set([
  'station',
  'ns',
  'de',
  'het',
  'een',
  'van',
  'bij',
  'aan',
  'in',
  'op',
  'nederland'
]);

/**
 * True when every meaningful word of the query appears in the name. PDOK
 * returns its best hit even when that is something else entirely (a street
 * for a station name); this is how such a hit is caught.
 */
export function namesMatch(query: string, name: string | undefined): boolean {
  if (!name) return false;
  const words = normalize(name).split(' ');
  return normalize(query)
    .split(' ')
    .filter((t) => t.length >= 3 && !NOISE.has(t))
    .every((t) =>
      words.some(
        (w) =>
          w.startsWith(t) ||
          (t.length >= 5 && editDistance(t, w.slice(0, t.length), 1) <= 1)
      )
    );
}

const round = (n: number) => Math.round(n * 1e6) / 1e6;

export class Geocoder {
  private readonly deps: GeocoderDeps;

  constructor(deps: GeocoderDeps) {
    this.deps = deps;
  }

  /** A place from `locatie`, or from lat/lon when no locatie is given. */
  async locate(input: {
    locatie?: string | undefined;
    lat?: number | undefined;
    lon?: number | undefined;
  }): Promise<Place> {
    if (input.locatie?.trim()) return this.search(input.locatie.trim());
    if (input.lat !== undefined && input.lon !== undefined) {
      return {
        lat: input.lat,
        lon: input.lon,
        ...(await this.address(input.lat, input.lon)),
        source: 'coordinates'
      };
    }
    throw new NotFound(
      'Pass a locatie (address, station or place), or lat and lon.'
    );
  }

  async search(query: string): Promise<Place> {
    const key = `geocode:v1:${normalize(query)}`;
    const cached = this.deps.store.get<Place>(key);
    if (cached) return { query, ...cached };

    const found = await this.lookup(query);
    // Addresses and stations do not move, so a hit is kept for good.
    this.deps.store.set(key, found);
    return { query, ...found };
  }

  /** Nearest address, street and municipality for a point; cached for good per ~10 cm. */
  async address(lat: number, lon: number): Promise<Address> {
    const key = `reverse:v1:${lat.toFixed(6)},${lon.toFixed(6)}`;
    const cached = this.deps.store.get<Address>(key);
    if (cached) return cached;
    const doc = await this.deps.pdok.reverse(lat, lon);
    const municipality = municipalityCode(doc?.gemeentecode);
    const result: Address = {
      ...(doc?.weergavenaam ? { address: doc.weergavenaam } : {}),
      ...(doc?.straatnaam ? { street: doc.straatnaam } : {}),
      ...(municipality ? { municipality } : {}),
      ...(doc?.afstand !== undefined
        ? { distanceM: Math.round(doc.afstand) }
        : {})
    };
    this.deps.store.set(key, result);
    return result;
  }

  private async lookup(query: string): Promise<Omit<Place, 'query'>> {
    const station = await this.station(query);
    if (station) {
      return {
        ...station,
        ...this.withoutDistance(await this.address(station.lat, station.lon)),
        source: 'ns'
      };
    }

    const doc = await this.deps.pdok.search(query);
    const point = parsePoint(doc?.centroide_ll);
    const pdok =
      doc && point
        ? {
            lat: round(point.lat),
            lon: round(point.lon),
            ...(doc.weergavenaam ? { name: doc.weergavenaam } : {})
          }
        : undefined;
    if (pdok && namesMatch(query, doc?.weergavenaam)) {
      return {
        ...pdok,
        ...this.withoutDistance(await this.address(pdok.lat, pdok.lon)),
        source: 'pdok'
      };
    }

    // PDOK knows addresses, not landmarks: "station Almere Muziekwijk" lands on a street.
    const osm = await this.deps.nominatim
      .search(query)
      .catch((error: unknown) => {
        this.deps.logger.warn({ err: String(error) }, 'nominatim failed');
        return undefined;
      });
    if (osm) {
      const lat = round(Number(osm.lat));
      const lon = round(Number(osm.lon));
      if (Number.isFinite(lat) && Number.isFinite(lon)) {
        return {
          lat,
          lon,
          ...(osm.display_name ? { name: osm.display_name } : {}),
          ...this.withoutDistance(await this.address(lat, lon)),
          source: 'nominatim'
        };
      }
    }
    if (pdok) {
      return {
        ...pdok,
        ...this.withoutDistance(await this.address(pdok.lat, pdok.lon)),
        source: 'pdok'
      };
    }
    throw new NotFound(
      `No location found for "${query}". Try a street and town.`
    );
  }

  /** NS knows where its stations are better than any geocoder. */
  private async station(
    query: string
  ): Promise<{ lat: number; lon: number; name: string } | undefined> {
    const q = normalize(query);
    const rest = q
      .replace(/\b(ns )?station\b/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    let index: StationIndex;
    try {
      index = await this.deps.stations();
    } catch {
      return undefined;
    }
    let match;
    if (rest !== q && rest) {
      try {
        match = index.resolve(rest);
      } catch {
        return undefined;
      }
    } else {
      // Without the word "station", only an exact station name counts: "Utrecht" is a city too.
      const best = index.search(query, 1)[0]?.station;
      if (best && normalize(best.name) === q) match = best;
    }
    if (!match?.location || match.country !== 'NL') return undefined;
    return {
      lat: round(match.location.lat),
      lon: round(match.location.lng),
      name: `${match.name} (station)`
    };
  }

  private withoutDistance(address: Address): Omit<Address, 'distanceM'> {
    return compact({
      address: address.address,
      street: address.street,
      municipality: address.municipality
    });
  }
}
