/**
 * SevenRooms widget client.
 * Availability and venue details use the public widget APIs.
 * There is no directory search; a name resolves only when it matches a venue URL key.
 * Booking is a link back to the widget. Checkout is not automated.
 */

import { BasePlatformClient } from './base.js';
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

const ORIGIN = 'https://www.sevenrooms.com';

interface VenueInfo {
  name: string;
  url_key: string;
  address?: string | null;
  city?: string | null;
  phone_number?: string | null;
  website?: string | null;
  cuisine_keywords?: string[] | null;
  municipality?: { name?: string; state?: string; country?: string } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function slugCandidates(query: string): string[] {
  const raw = query.trim();
  const url = raw.match(/sevenrooms\.com\/(?:reservations|explore)\/([a-z0-9-]+)/i);
  if (url) return [url[1].toLowerCase()];
  const slug = raw.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const tight = slug.replace(/-/g, '');
  return [...new Set([slug, tight].filter(Boolean))];
}

function nameMatches(query: string, venueName: string, slug: string): boolean {
  const q = fold(query);
  const name = fold(venueName);
  if (!q || !name) return false;
  return name === q || name.startsWith(q) || q === fold(slug) || slug === slugCandidates(query)[0];
}

function widgetDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-');
  if (!year || !month || !day) return isoDate;
  return `${month}-${day}-${year}`;
}

function to24h(time: string, timeIso?: string): string {
  const iso = timeIso?.match(/(\d{2}):(\d{2})/);
  if (iso) return `${iso[1]}:${iso[2]}`;
  const match = time.match(/(\d{1,2}):(\d{2})\s*(AM|PM)?/i);
  if (!match) return time;
  let hour = Number(match[1]);
  const minute = match[2];
  const period = match[3]?.toUpperCase();
  if (period === 'PM' && hour < 12) hour += 12;
  if (period === 'AM' && hour === 12) hour = 0;
  return `${String(hour).padStart(2, '0')}:${minute}`;
}

export function slotsFromSevenRoomsRange(data: unknown, date: string): Array<{
  slotId: string;
  time: string;
  type: string;
}> {
  const availability = isRecord(data) && isRecord(data.data) ? data.data.availability : undefined;
  const shifts = isRecord(availability) ? availability[date] : undefined;
  if (!Array.isArray(shifts)) return [];

  const slots: Array<{ slotId: string; time: string; type: string }> = [];
  for (const shift of shifts) {
    if (!isRecord(shift) || !Array.isArray(shift.times)) continue;
    for (const slot of shift.times) {
      if (!isRecord(slot) || typeof slot.time !== 'string') continue;
      const timeIso = typeof slot.time_iso === 'string' ? slot.time_iso : undefined;
      const type = typeof slot.type === 'string' ? slot.type : 'book';
      const slotId = typeof slot.access_persistent_id === 'string' && slot.access_persistent_id
        ? slot.access_persistent_id
        : `${date}-${to24h(slot.time, timeIso)}`;
      slots.push({ slotId, time: to24h(slot.time, timeIso), type });
    }
  }
  return slots;
}

async function getJson(url: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/json',
      'User-Agent': 'restaurant-mcp/2.0',
    },
  });
  const text = await response.text();
  try {
    return { status: response.status, body: JSON.parse(text) };
  } catch {
    return { status: response.status, body: text };
  }
}

export class SevenRoomsPlatformClient extends BasePlatformClient {
  readonly name: PlatformName = 'sevenrooms';

  async search(query: SearchQuery): Promise<Restaurant[]> {
    const candidates = slugCandidates(query.query);
    for (const slug of candidates) {
      const venue = await this.fetchVenue(slug);
      if (!venue) continue;
      if (!nameMatches(query.query, venue.name, venue.url_key || slug)) continue;
      return [this.toRestaurant(venue)];
    }
    return [];
  }

  async getDetails(id: string | number): Promise<RestaurantDetails | null> {
    const slug = this.extractId(String(id));
    const venue = await this.fetchVenue(slug);
    if (!venue) return null;
    const city = venue.city || venue.municipality?.name || '';
    return {
      id: this.createId(venue.url_key || slug),
      platformIds: { sevenrooms: venue.url_key || slug },
      name: venue.name,
      cuisines: venue.cuisine_keywords || [],
      priceRange: 2 as PriceRange,
      rating: 0,
      reviewCount: 0,
      address: {
        street: venue.address || '',
        city,
        state: venue.municipality?.state || '',
        zip: '',
      },
      phone: venue.phone_number || undefined,
      website: venue.website || undefined,
      acceptsOnlineReservations: true,
      reservationPlatforms: [this.name],
      bookingUrls: { sevenrooms: this.bookingUrl(venue.url_key || slug) },
      images: [],
      lastUpdated: new Date().toISOString(),
    };
  }

  async getAvailability(id: string | number, date: string, partySize: number): Promise<TimeSlot[]> {
    const slug = this.extractId(String(id));
    const url = new URL('/api-yoa/availability/ng/widget/range', ORIGIN);
    url.searchParams.set('venue', slug);
    url.searchParams.set('party_size', String(partySize));
    url.searchParams.set('start_date', widgetDate(date));
    url.searchParams.set('num_days', '1');
    url.searchParams.set('time_slot', '19:00');
    url.searchParams.set('halo_size_interval', '16');
    url.searchParams.set('channel', 'SEVENROOMS_WIDGET');
    url.searchParams.set('selected_lang_code', 'en');

    const { status, body } = await getJson(url.toString());
    if (status !== 200) return [];
    return slotsFromSevenRoomsRange(body, date).map((slot) => ({
      slotId: slot.slotId,
      platform: this.name,
      time: slot.time,
      type: slot.type,
      bookingUrl: this.bookingUrl(slug, date, partySize),
    }));
  }

  async makeReservation(params: ReservationParams): Promise<ReservationResult> {
    const slug = this.extractId(params.restaurantId);
    return {
      success: true,
      platform: this.name,
      bookingUrl: this.bookingUrl(slug, params.date, params.partySize),
      confirmationDetails: 'Finish this SevenRooms reservation in the widget. Checkout is not completed here.',
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { status, body } = await getJson(`${ORIGIN}/api-yoa/dining/venue_info?venue_url_key=nobu`);
      return status === 200 && isRecord(body) && (body as { status?: number }).status === 200;
    } catch {
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    return true;
  }

  private bookingUrl(slug: string, date?: string, partySize?: number): string {
    const url = new URL(`/reservations/${encodeURIComponent(slug)}`, ORIGIN);
    if (date) url.searchParams.set('date', date);
    if (partySize) url.searchParams.set('party_size', String(partySize));
    return url.toString();
  }

  private async fetchVenue(slug: string): Promise<VenueInfo | null> {
    const url = new URL('/api-yoa/dining/venue_info', ORIGIN);
    url.searchParams.set('venue_url_key', slug);
    const { status, body } = await getJson(url.toString());
    if (status !== 200 || !isRecord(body)) return null;
    const data = isRecord(body.data) ? body.data : null;
    const venue = data && isRecord(data.venue_info) ? data.venue_info as unknown as VenueInfo : null;
    if (!venue?.name) return null;
    return venue;
  }

  private toRestaurant(venue: VenueInfo): Restaurant {
    const city = venue.city || venue.municipality?.name || '';
    const cuisines = venue.cuisine_keywords || [];
    return {
      id: this.createId(venue.url_key),
      platform: this.name,
      platformId: venue.url_key,
      name: venue.name,
      location: [venue.address, city].filter(Boolean).join(', '),
      cuisine: cuisines.join(', '),
      cuisines,
      priceRange: 0,
      rating: 0,
      bookingUrl: this.bookingUrl(venue.url_key),
    };
  }
}

export const sevenRoomsClient = new SevenRoomsPlatformClient();
