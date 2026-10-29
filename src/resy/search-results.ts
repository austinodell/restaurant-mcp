/**
 * Normalize Resy restaurant-search payloads.
 *
 * Name search (`POST /3/venuesearch/search`) returns matches under `search.hits`.
 * Availability search (`GET /4/find`) ignores the name and returns an unfiltered
 * geo catalog under `results.venues`, where each entry wraps the venue in `.venue`.
 * Older responses used a flat `search.hits` list. Accept both.
 */

export interface ParsedResyVenue {
  id: number;
  name: string;
  location: string;
  neighborhood: string;
  cuisines: string[];
  priceRange: number;
  rating: number;
  imageUrl?: string;
}

const VENUE_RESULT_CAP = 25;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function unwrapVenue(item: unknown): Record<string, unknown> | null {
  if (!isRecord(item)) return null;
  if (isRecord(item.venue) && ('name' in item.venue || 'id' in item.venue)) {
    return item.venue;
  }
  return item;
}

function resyId(hit: Record<string, unknown>): number | null {
  const id = hit.id;
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  if (isRecord(id) && typeof id.resy === 'number' && Number.isFinite(id.resy)) return id.resy;
  if (typeof hit.venue_id === 'number' && Number.isFinite(hit.venue_id)) return hit.venue_id;
  return null;
}

function locationName(hit: Record<string, unknown>): string {
  const location = hit.location;
  if (typeof location === 'string') return location;
  if (isRecord(location) && typeof location.name === 'string') return location.name;
  if (typeof hit.locality === 'string') return hit.locality;
  return '';
}

function neighborhoodOf(hit: Record<string, unknown>): string {
  if (typeof hit.neighborhood === 'string') return hit.neighborhood;
  const location = hit.location;
  if (isRecord(location) && typeof location.neighborhood === 'string') return location.neighborhood;
  return '';
}

function cuisinesOf(hit: Record<string, unknown>): string[] {
  const raw = hit.cuisine ?? hit.type;
  if (Array.isArray(raw)) {
    return raw.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }
  if (typeof raw === 'string' && raw.length > 0) return [raw];
  return [];
}

function ratingOf(hit: Record<string, unknown>): number {
  const direct = finiteNumber(hit.rating);
  if (direct !== undefined) return direct;
  if (isRecord(hit.rating)) {
    const average = finiteNumber(hit.rating.average);
    if (average !== undefined) return average;
  }
  return 0;
}

function priceOf(hit: Record<string, unknown>): number {
  return finiteNumber(hit.price_range) ?? finiteNumber(hit.price_range_id) ?? 0;
}

function imageOf(hit: Record<string, unknown>): string | undefined {
  if (Array.isArray(hit.images)) {
    const url = hit.images.find((item) => typeof item === 'string' && item.length > 0);
    if (typeof url === 'string') return url;
  }
  const responsive = hit.responsive_images;
  if (isRecord(responsive) && isRecord(responsive.originals)) {
    for (const entry of Object.values(responsive.originals)) {
      if (isRecord(entry) && typeof entry.url === 'string' && entry.url.length > 0) return entry.url;
    }
  }
  return undefined;
}

function matchesQuery(hit: Record<string, unknown>, query: string): boolean {
  const parts = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return true;
  const haystack = [hit.name, neighborhoodOf(hit), locationName(hit), ...cuisinesOf(hit)]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join(' ')
    .toLowerCase();
  return parts.every((part) => haystack.includes(part));
}

function toVenue(hit: Record<string, unknown>): ParsedResyVenue | null {
  const id = resyId(hit);
  if (id === null || typeof hit.name !== 'string' || hit.name.length === 0) return null;
  const cuisines = cuisinesOf(hit);
  return {
    id,
    name: hit.name,
    location: locationName(hit),
    neighborhood: neighborhoodOf(hit),
    cuisines,
    priceRange: priceOf(hit),
    rating: ratingOf(hit),
    imageUrl: imageOf(hit),
  };
}

/**
 * Read restaurants from either Resy search shape.
 * `search.hits` is already ranked for the query. `results.venues` is the
 * unfiltered /4/find catalog, so it is matched against `query` and capped.
 */
export function parseResySearchBody(data: unknown, query = ''): ParsedResyVenue[] {
  if (!isRecord(data)) return [];

  const search = isRecord(data.search) ? data.search : null;
  const hits = asArray(search?.hits).map(unwrapVenue).filter((item): item is Record<string, unknown> => item !== null);
  if (hits.length > 0) {
    return hits.map(toVenue).filter((venue): venue is ParsedResyVenue => venue !== null);
  }

  const results = isRecord(data.results) ? data.results : null;
  const venues = asArray(results?.venues)
    .map(unwrapVenue)
    .filter((item): item is Record<string, unknown> => item !== null)
    .filter((item) => matchesQuery(item, query))
    .slice(0, VENUE_RESULT_CAP);

  return venues.map(toVenue).filter((venue): venue is ParsedResyVenue => venue !== null);
}
