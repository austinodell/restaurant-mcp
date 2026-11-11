/**
 * Tock availability via the consumer calendar API.
 * exploretock.com HTML and search are often behind a Cloudflare challenge.
 * A slug resolves from an unchallenged page, or from a venue saved in KV.
 * Booking stays a link. Checkout is not automated.
 */

import { BasePlatformClient } from './base.js';
import { getEnv } from '../env.js';
import { bootstrapFromHtml, decodeCalendar, type TockBootstrap } from '../tock/calendar.js';
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
  return /<title>\s*Just a moment|_cf_chl_opt/i.test(text);
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

function findDomainName(node: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findDomainName(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  if (typeof node.domainName === 'string' && /^[a-z0-9-]+$/i.test(node.domainName)) return node.domainName;
  for (const value of Object.values(node)) {
    const found = findDomainName(value, depth + 1);
    if (found) return found;
  }
  return null;
}

export function slotsFromTockCalendar(data: unknown, date: string): TimeSlot[] {
  const structured = slotsFromTicketGroups(data, date);
  if (structured.length > 0) return structured;

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

function slotsFromTicketGroups(data: unknown, date: string): TimeSlot[] {
  const result = isRecord(data) && isRecord(data.result) ? data.result : data;
  const byDay = isRecord(result) ? result.ticketGroupByBusinessDay : undefined;
  if (!isRecord(byDay) || !isRecord(byDay[date])) return [];
  const slots: TimeSlot[] = [];
  const seen = new Set<string>();
  const visit = (node: unknown) => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isRecord(node)) return;
    if (typeof node.time === 'string' && (typeof node.availableTickets === 'number' || typeof node.numTickets === 'number')) {
      const open = node.availableTickets !== 0 && node.soldOut !== true;
      if (open && !seen.has(node.time)) {
        seen.add(node.time);
        slots.push({
          slotId: `${date}-${node.time}`,
          platform: 'tock',
          time: normalizeTime(node.time),
          type: typeof node.name === 'string' ? node.name : 'reservation',
        });
      }
      return;
    }
    for (const value of Object.values(node)) visit(value);
  };
  visit(byDay[date]);
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

    // Bootstrap each request: anonymous JWTs are never persisted in KV or logs.
    let bootstrap: TockBootstrap = venue.bootstrap || { businessId: venue.businessId };
    let bootstrapError: string | undefined;
    if (!venue.bootstrap && !/^\d+$/.test(venue.slug)) {
      try { bootstrap = await this.bootstrap(venue.slug); }
      catch (error) { bootstrapError = error instanceof Error ? error.message : 'bootstrap failed'; }
    }
    const headers: Record<string, string> = {
      Accept: 'application/octet-stream',
      'Content-Type': 'application/octet-stream',
      'X-Tock-Stream-Format': 'proto2',
      'X-Tock-Scope': JSON.stringify({ businessId: bootstrap.businessId }),
      'X-Tock-Path': `/${venue.slug}`,
      Origin: ORIGIN,
      Referer: `${ORIGIN}/${venue.slug}`,
    };
    if (bootstrap.jwt) headers['X-Tock-Authorization'] = bootstrap.jwt;
    if (bootstrap.build) headers['X-Tock-Build-Number'] = bootstrap.build;
    let response: Response;
    try {
      response = await fetch(CALENDAR_URL, { method: 'POST', headers,
        body: new Uint8Array(0), signal: AbortSignal.timeout(12000) });
    } catch { throw new Error('Tock calendar request failed or timed out.'); }
    if (response.headers.get('cf-mitigated') === 'challenge') {
      throw new Error('Tock blocked the Worker with a Cloudflare challenge; availability is unknown.');
    }
    if (!response.ok) {
      throw new Error(`Tock calendar returned HTTP ${response.status}.${bootstrapError ? ` Venue bootstrap: ${bootstrapError}` : ''}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('text/html') || challenged(response.status, new TextDecoder().decode(bytes.slice(0, 4096)))) {
      throw new Error('Tock returned an HTML page instead of a protobuf calendar; availability is unknown.');
    }
    const seen = new Set<string>();
    return decodeCalendar(bytes)
      .filter(slot => slot.date === date && slot.available >= partySize &&
        (!slot.minParty || partySize >= slot.minParty) && (!slot.maxParty || partySize <= slot.maxParty))
      .flatMap(slot => (slot.experienceIds.length ? slot.experienceIds : ['unknown']).map(experienceId => ({
        slotId: `${date}-${slot.time}-${experienceId}`,
        platform: this.name,
        time: slot.time,
        type: `experience-${experienceId}`,
        bookingUrl: this.buildBookingUrl(venue.slug, date, partySize),
      })))
      .filter(slot => { if (seen.has(slot.slotId)) return false; seen.add(slot.slotId); return true; })
      .sort((a, b) => a.time.localeCompare(b.time));
  }

  async makeReservation(params: ReservationParams): Promise<ReservationResult> {
    const slug = this.extractId(params.restaurantId);
    return {
      success: false,
      error: 'Tock checkout must be completed on exploretock.com; no reservation has been made.',
      platform: this.name,
      bookingUrl: this.buildBookingUrl(slug, params.date, params.partySize),
      confirmationDetails: 'Finish this Tock reservation on exploretock.com. Checkout is not completed here.',
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async isAuthenticated(): Promise<boolean> {
    return false;
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

  private async resolve(idOrSlug: string): Promise<(SavedVenue & { slug: string; bootstrap?: TockBootstrap }) | null> {
    const raw = idOrSlug.trim();
    if (/^\d+$/.test(raw)) return { slug: raw, businessId: raw };

    const explicit = raw.match(/^([a-z0-9-]+):(\d+)$/i);
    if (explicit) return { slug: explicit[1].toLowerCase(), businessId: explicit[2] };

    const slug = raw.toLowerCase();
    const stored = await this.readSaved(slug);
    if (stored) return { slug, ...stored };

    try {
      const parsed = await this.bootstrap(slug);
      return { slug, businessId: parsed.businessId, name: parsed.name, bootstrap: parsed };
    } catch (error) {
      throw new Error(`Tock could not bootstrap "${slug}": ${error instanceof Error ? error.message : 'request failed'}. A saved slug/business_id can still be tried with add_tock_venue.`);
    }
  }

  private async bootstrap(slug: string): Promise<TockBootstrap> {
    const response = await fetch(`${ORIGIN}/${encodeURIComponent(slug)}`, {
      headers: { Accept: 'text/html' }, signal: AbortSignal.timeout(8000),
    });
    const html = await response.text();
    if (response.headers.get('cf-mitigated') === 'challenge' || challenged(response.status, html)) {
      throw new Error('Cloudflare challenged the Worker venue request');
    }
    if (!response.ok) throw new Error(`venue request returned HTTP ${response.status}`);
    return bootstrapFromHtml(html, slug);
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

