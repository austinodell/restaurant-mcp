/**
 * Tock availability via the consumer calendar API.
 * exploretock.com HTML and search are often behind a Cloudflare challenge.
 * A slug resolves from an unchallenged page, or from a venue saved in KV.
 * Booking stays a link. Checkout is not automated.
 */

import { BasePlatformClient } from './base.js';
import { getEnv } from '../env.js';
import type {
  PlatformName,
  Restaurant,
  RestaurantDetails,
  TimeSlot,
  ReservationParams,
  ReservationResult,
  SearchQuery,
  PriceRange,
} from '../types/restaurant.js';

const ORIGIN = 'https://www.exploretock.com';
const CALENDAR_URL = `${ORIGIN}/api/consumer/calendar/full/v2`;

interface SavedVenue {
  businessId: string;
  name?: string;
  businessGroupId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function challenged(status: number, text: string): boolean {
  if (status === 403 || status === 503) return true;
  return /just a moment|cf-mitigated|challenge-platform|attention required|cdn-cgi\/challenge/i.test(text.slice(0, 2500));
}

export function businessFromTockHtml(html: string, slug: string): SavedVenue | null {
  const pattern = /"id":(\d+),"name":"((?:\\.|[^"\\])*)","timeZone":"[^"]*","locale":"[^"]*","currencyCode":"[^"]*","domainName":"([^"]+)"/g;
  for (const match of html.matchAll(pattern)) {
    if (match[3] === slug) {
      return { businessId: match[1], name: match[2].replace(/\\u002F/g, '/') };
    }
  }
  return null;
}

export function slotsFromTockCalendar(data: unknown, date: string): TimeSlot[] {
  const slots: TimeSlot[] = [];
  const seen = new Set<string>();

  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    if ('weekday' in node || 'serviceType' in node) {
      for (const value of Object.values(node)) visit(value);
      return;
    }

    const time = stringField(node, ['time', 'startTime', 'start_time', 'localTime', 'displayTime']);
    const looksLikeSlot = time && (
      'available' in node || 'isAvailable' in node || 'ticketTypeId' in node || 'offeringId' in node || 'id' in node
    );
    if (looksLikeSlot && time && isOpen(node)) {
      const normalized = normalizeTime(time);
      const slotDate = stringField(node, ['date', 'serviceDate']) || date;
      if (!slotDate || slotDate === date) {
        const key = `${normalized}`;
        if (!seen.has(key)) {
          seen.add(key);
          slots.push({
            slotId: stringField(node, ['id', 'ticketTypeId', 'offeringId']) || `${date}-${normalized}`,
            platform: 'tock',
            time: normalized,
            type: stringField(node, ['type', 'name', 'experienceName']) || 'reservation',
          });
        }
      }
    }

    for (const value of Object.values(node)) visit(value);
  };

  visit(data);
  return slots.sort((a, b) => a.time.localeCompare(b.time));
}

function stringField(record: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}

function isOpen(record: Record<string, unknown>): boolean {
  if (record.available === false || record.isAvailable === false || record.soldOut === true) return false;
  const status = typeof record.status === 'string' ? record.status.toUpperCase() : '';
  return status !== 'SOLD_OUT' && status !== 'UNAVAILABLE';
}

function normalizeTime(time: string): string {
  const iso = time.match(/T(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const clock = time.match(/^(\d{1,2}):(\d{2})/);
  if (clock && !/[AP]M/i.test(time)) {
    return `${clock[1].padStart(2, '0')}:${clock[2]}`;
  }
  const twelve = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (twelve) {
    let hour = Number(twelve[1]);
    const period = twelve[3].toUpperCase();
    if (period === 'PM' && hour < 12) hour += 12;
    if (period === 'AM' && hour === 12) hour = 0;
    return `${String(hour).padStart(2, '0')}:${twelve[2]}`;
  }
  return time;
}

async function readText(response: Response): Promise<string> {
  return response.text();
}

export class TockPlatformClient extends BasePlatformClient {
  readonly name: PlatformName = 'tock';

  async search(query: SearchQuery): Promise<Restaurant[]> {
    const needle = query.query.trim().toLowerCase();
    if (!needle) return [];
    const saved = await this.listSaved();
    return saved
      .filter((venue) => {
        const hay = `${venue.slug} ${venue.name || ''}`.toLowerCase();
        return hay.includes(needle);
      })
      .map((venue) => this.toRestaurant(venue));
  }

  async getDetails(id: string | number): Promise<RestaurantDetails | null> {
    const venue = await this.resolve(this.extractId(String(id)));
    if (!venue) return null;
    return {
      id: this.createId(venue.slug),
      platformIds: { tock: venue.slug },
      name: venue.name || venue.slug,
      cuisines: [],
      priceRange: 2 as PriceRange,
      rating: 0,
      reviewCount: 0,
      address: { street: '', city: '', state: '', zip: '' },
      acceptsOnlineReservations: true,
      reservationPlatforms: [this.name],
      bookingUrls: { tock: this.buildBookingUrl(venue.slug) },
      images: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  async getAvailability(id: string | number, date: string, partySize: number): Promise<TimeSlot[]> {
    const key = this.extractId(String(id));
    const venue = await this.resolve(key);
    if (!venue) {
      throw new Error(
        `Tock could not resolve "${key}" to a business id. exploretock.com often answers with a Cloudflare challenge, and there is no public search. Save it with add_tock_venue (slug + business_id), or pass the numeric business id.`
      );
    }

    const scope = {
      businessId: venue.businessId,
      site: 'EXPLORETOCK',
      ...(venue.businessGroupId ? { businessGroupId: venue.businessGroupId } : {}),
    };
    const response = await fetch(CALENDAR_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Origin: ORIGIN,
        Referer: `${ORIGIN}/${venue.slug}`,
        'User-Agent': 'restaurant-mcp/2.0',
        'x-tock-scope': JSON.stringify(scope),
      },
      body: JSON.stringify({
        businessId: Number(venue.businessId) || venue.businessId,
        date,
        partySize,
      }),
    });
    const text = await readText(response);
    if (challenged(response.status, text)) {
      throw new Error('Tock blocked this request from Cloudflare (HTTP challenge). Availability could not be read from this network.');
    }
    if (!response.ok) {
      throw new Error(`Tock calendar returned HTTP ${response.status}.`);
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error('Tock calendar returned a non-JSON response.');
    }
    const slots = slotsFromTockCalendar(body, date);
    return slots.map((slot) => ({
      ...slot,
      bookingUrl: this.buildBookingUrl(venue.slug, date, partySize),
    }));
  }

  async makeReservation(params: ReservationParams): Promise<ReservationResult> {
    const slug = this.extractId(params.restaurantId);
    const venue = await this.resolve(slug);
    return {
      success: true,
      platform: this.name,
      bookingUrl: this.buildBookingUrl(venue?.slug || slug, params.date, params.partySize),
      confirmationDetails: 'Finish this Tock reservation on exploretock.com. Checkout is not completed here.',
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async isAuthenticated(): Promise<boolean> {
    return true;
  }

  buildBookingUrl(venueId: string, date?: string, partySize?: number): string {
    const url = new URL(`/${venueId}`, ORIGIN);
    if (date) url.searchParams.set('date', date);
    if (partySize) url.searchParams.set('size', String(partySize));
    return url.toString();
  }

  async saveVenue(slug: string, businessId: string, name?: string): Promise<SavedVenue & { slug: string }> {
    const cleanSlug = slug.trim().toLowerCase().replace(/^tock-/, '').replace(/[^a-z0-9-]/g, '');
    const cleanId = businessId.trim();
    if (!cleanSlug || !cleanId) throw new Error('slug and business_id are required');
    const saved: SavedVenue = { businessId: cleanId, name: name?.trim() || cleanSlug };
    await getEnv().CREDS.put(kvKey(cleanSlug), JSON.stringify(saved));
    return { slug: cleanSlug, ...saved };
  }

  private async resolve(idOrSlug: string): Promise<(SavedVenue & { slug: string }) | null> {
    const raw = idOrSlug.trim();
    if (/^\d+$/.test(raw)) return { slug: raw, businessId: raw };

    const explicit = raw.match(/^([a-z0-9-]+):(\d+)$/i);
    if (explicit) return { slug: explicit[1].toLowerCase(), businessId: explicit[2] };

    const slug = raw.toLowerCase();
    const stored = await this.readSaved(slug);
    if (stored) return { slug, ...stored };

    try {
      const response = await fetch(`${ORIGIN}/${encodeURIComponent(slug)}`, {
        headers: { Accept: 'text/html', 'User-Agent': 'restaurant-mcp/2.0' },
      });
      const html = await response.text();
      if (!challenged(response.status, html)) {
        const parsed = businessFromTockHtml(html, slug);
        if (parsed) return { slug, ...parsed };
      }
    } catch {
      // Resolution falls through to the KV / numeric-id path.
    }
    return null;
  }

  private async readSaved(slug: string): Promise<SavedVenue | null> {
    try {
      const raw = await getEnv().CREDS.get(kvKey(slug));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as SavedVenue;
      if (!parsed?.businessId) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  private async listSaved(): Promise<Array<SavedVenue & { slug: string }>> {
    try {
      const listed = await getEnv().CREDS.list({ prefix: 'tock:venue:' });
      const venues: Array<SavedVenue & { slug: string }> = [];
      for (const key of listed.keys) {
        const slug = key.name.slice('tock:venue:'.length);
        const saved = await this.readSaved(slug);
        if (saved) venues.push({ slug, ...saved });
      }
      return venues;
    } catch {
      return [];
    }
  }

  private toRestaurant(venue: SavedVenue & { slug: string }): Restaurant {
    return {
      id: this.createId(venue.slug),
      platform: this.name,
      platformId: venue.slug,
      name: venue.name || venue.slug,
      location: '',
      cuisine: '',
      priceRange: 0,
      rating: 0,
      bookingUrl: this.buildBookingUrl(venue.slug),
    };
  }
}

function kvKey(slug: string): string {
  return `tock:venue:${slug}`;
}

export const tockClient = new TockPlatformClient();
