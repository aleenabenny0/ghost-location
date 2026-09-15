// Amtrak GTFS stops.txt, retrieved 2026-09-15:
// https://content.amtrak.com/content/gtfs/GTFS.zip
export const CARY_STATION = Object.freeze({
  id: 'amtrak-CYN', label: 'Cary, NC (CYN) · Amtrak',
  latitude: 35.788294, longitude: -78.782246,
});

export function stationMatches(query) {
  const normalized = query.trim().toLowerCase().replace(/[,.()]/g, '').replace(/\s+/g, ' ');
  return ['cyn', 'cary', 'cary nc', 'cary station', 'cary amtrak', 'cary north carolina'].includes(normalized)
    ? [{ ...CARY_STATION }] : [];
}
