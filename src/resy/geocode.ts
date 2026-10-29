import { cache, CacheTTL } from '../services/cache.js';

export interface GeoPoint {
  lat: number;
  lng: number;
  label: string;
}

const USER_AGENT = 'restaurant-mcp/2.0 (https://github.com/austinodell/restaurant-mcp)';

/**
 * Geocode a free-form place with Nominatim. Results are cached in memory.
 * Returns null when the location cannot be resolved.
 */
export async function geocodeLocation(location: string): Promise<GeoPoint | null> {
  const query = location.trim();
  if (!query) return null;

  const cacheKey = `geo:${query.toLowerCase()}`;
  const cached = cache.get<GeoPoint>(cacheKey);
  if (cached) return cached;

  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');
  url.searchParams.set('limit', '1');

  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!response.ok) return null;

  const body = await response.json() as unknown;
  if (!Array.isArray(body) || body.length === 0) return null;
  const hit = body[0] as { lat?: string; lon?: string; display_name?: string };
  const lat = Number(hit.lat);
  const lng = Number(hit.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const point: GeoPoint = { lat, lng, label: hit.display_name || query };
  cache.set(cacheKey, point, CacheTTL.RESTAURANT_DETAILS);
  return point;
}

/** Resy venuesearch `geo.radius` is meters. A ZIP is tighter than a city name. */
export function searchRadiusMeters(location: string): number {
  return /\b\d{5}(?:-\d{4})?\b/.test(location) ? 20000 : 40000;
}
