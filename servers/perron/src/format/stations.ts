import type { Station } from '../resolve.ts';
import { compact } from './util.ts';

export function formatStation(s: Station) {
  return compact({
    name: s.name,
    code: s.code,
    uic: s.uic,
    type: s.type
      ?.toLowerCase()
      .replace(/_station$/, '')
      .replaceAll('_', '-'),
    country: s.country,
    tracks: s.tracks,
    accessible: s.accessible,
    travelAssistance: s.travelAssistance,
    synonyms: s.synonyms
  });
}
