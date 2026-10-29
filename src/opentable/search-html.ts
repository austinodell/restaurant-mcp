export interface OpenTableHit {
  id: number;
  name: string;
  location: string;
  cuisine: string;
  priceRange: number;
  rating: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function restaurantId(record: Record<string, unknown>): number | undefined {
  return asNumber(record.restaurantId)
    ?? asNumber(record.restaurant_id)
    ?? asNumber(record.rid)
    ?? asNumber(isRecord(record.restaurant) ? record.restaurant.restaurantId : undefined);
}

function priceOf(record: Record<string, unknown>): number {
  const value = asNumber(record.priceBand) ?? asNumber(record.price) ?? asNumber(record.priceRange);
  if (value === undefined) return 0;
  return Math.max(0, Math.min(4, Math.round(value)));
}

function locationOf(record: Record<string, unknown>): string {
  const parts = [record.neighborhood, record.address, record.city, record.state, record.metro, record.location]
    .map((part) => typeof part === 'string' ? part.trim() : '')
    .filter(Boolean);
  return [...new Set(parts)].join(', ');
}

function walk(node: unknown, out: Map<number, OpenTableHit>): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, out);
    return;
  }
  if (!isRecord(node)) return;

  const id = restaurantId(node);
  const name = typeof node.name === 'string' ? node.name.trim() : '';
  if (id && name && !out.has(id)) {
    const cuisine = typeof node.cuisine === 'string'
      ? node.cuisine
      : Array.isArray(node.cuisines)
        ? node.cuisines.filter((item): item is string => typeof item === 'string').join(', ')
        : '';
    out.set(id, {
      id,
      name,
      location: locationOf(node),
      cuisine,
      priceRange: priceOf(node),
      rating: asNumber(node.rating) ?? asNumber(node.reviewScore) ?? 0,
    });
  }

  for (const value of Object.values(node)) walk(value, out);
}

function extractJson(html: string, marker: string): unknown | null {
  const start = html.indexOf(marker);
  if (start < 0) return null;
  const brace = html.indexOf('{', start);
  if (brace < 0) return null;
  let depth = 0;
  for (let i = brace; i < html.length; i++) {
    const char = html[i];
    if (char === '{') depth++;
    else if (char === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(brace, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

export function openTableBlocked(status: number, html: string): boolean {
  if (status === 401 || status === 403 || status === 429 || status === 503) return true;
  const head = html.slice(0, 4000);
  const challenged = /just a moment|cf-mitigated|challenge-platform|attention required|cdn-cgi\/challenge/i.test(head);
  const hasResults = html.includes('__NEXT_DATA__') || html.includes('__INITIAL_STATE__') || /"restaurantId"/.test(html);
  return challenged && !hasResults;
}

/** Pull restaurant ids and names out of OpenTable's search HTML. */
export function parseOpenTableSearchHtml(html: string): OpenTableHit[] {
  const found = new Map<number, OpenTableHit>();
  const next = extractJson(html, '__NEXT_DATA__');
  const initial = extractJson(html, '__INITIAL_STATE__');
  if (next) walk(next, found);
  if (initial) walk(initial, found);
  if (found.size === 0) walkSafeRegex(html, found);
  return [...found.values()];
}

function walkSafeRegex(html: string, out: Map<number, OpenTableHit>): void {
  const pattern = /"restaurantId"\s*:\s*(\d{3,})[\s\S]{0,400}?"name"\s*:\s*"([^"\\]{2,120})"/g;
  for (const match of html.matchAll(pattern)) {
    const id = Number(match[1]);
    const name = match[2];
    if (!out.has(id)) {
      out.set(id, { id, name, location: '', cuisine: '', priceRange: 0, rating: 0 });
    }
  }
}
