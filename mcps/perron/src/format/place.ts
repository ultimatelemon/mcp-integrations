import type { Place } from '../geo/geocode.ts';
import { compact } from './util.ts';

/** The location a tool used, so a wrong geocode shows up in the answer. */
export function formatPlace(place: Place) {
  return compact({
    query: place.query,
    lat: place.lat,
    lon: place.lon,
    name: place.name,
    address: place.address,
    street: place.street,
    municipality: place.municipality,
    source: place.source
  });
}

export function placeLabel(place: Place): string {
  const name =
    place.name ?? place.address ?? `${String(place.lat)},${String(place.lon)}`;
  return `${name} (${String(place.lat)}, ${String(place.lon)}, via ${place.source})`;
}
