/**
 * OpenTable platform client implementing PlatformClient interface
 * NOTE: The OpenTable public API (opentable.com/restref/api) has been shut down.
 * Search, details, and availability return empty results.
 * Booking URL construction still works for manual use.
 */

import { BasePlatformClient } from './base.js';
import { openTableBlocked, parseOpenTableSearchHtml } from '../opentable/search-html.js';
import type {
  PlatformName,
  Restaurant,
  RestaurantDetails,
  TimeSlot,
  ReservationParams,
  ReservationResult,
  SearchQuery,
} from '../types/restaurant.js';

const BOOKING_BASE = 'https://www.opentable.com/booking/experiences-availability';

export class OpenTablePlatformClient extends BasePlatformClient {
  readonly name: PlatformName = 'opentable';

  async search(query: SearchQuery): Promise<Restaurant[]> {
    const term = [query.query, query.location].filter(Boolean).join(' ').trim();
    const url = new URL('https://www.opentable.com/s');
    url.searchParams.set('term', term);
    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Accept: 'text/html',
          'User-Agent': 'Mozilla/5.0 (compatible; restaurant-mcp/2.0)',
        },
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new Error('OpenTable search timed out before returning results.');
    }
    const html = await response.text();
    if (openTableBlocked(response.status, html)) {
      throw new Error('OpenTable blocked this request from Cloudflare (403 or bot challenge). Search is unavailable on this network.');
    }
    if (!response.ok) {
      throw new Error(`OpenTable search returned HTTP ${response.status}.`);
    }
    const date = query.date || this.today();
    const partySize = query.partySize || 2;
    return parseOpenTableSearchHtml(html).map((hit) => ({
      id: this.createId(hit.id),
      platform: this.name,
      platformId: hit.id,
      name: hit.name,
      location: hit.location,
      cuisine: hit.cuisine,
      priceRange: hit.priceRange,
      rating: hit.rating,
      bookingUrl: this.buildBookingUrl(hit.id, date, '19:00', partySize),
    }));
  }

  async getDetails(_id: string | number): Promise<RestaurantDetails | null> {
    // OpenTable public API is no longer available
    return null;
  }

  async getAvailability(_id: string | number, _date: string, _partySize: number): Promise<TimeSlot[]> {
    // OpenTable public API is no longer available
    return [];
  }

  async makeReservation(params: ReservationParams): Promise<ReservationResult> {
    // OpenTable cannot complete booking via API
    // Return booking URL for user to complete
    const numericId = parseInt(this.extractId(params.restaurantId), 10);

    // Extract time from slot ID (format: ot-{rid}-{date}-{time})
    const slotParts = params.slotId.split('-');
    const time = slotParts[slotParts.length - 1] || '19:00';

    const bookingUrl = this.buildBookingUrl(numericId, params.date, time, params.partySize);

    return {
      success: true,
      platform: this.name,
      bookingUrl,
      confirmationDetails: 'OpenTable requires completing booking on their website. Use the provided URL.',
    };
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async isAuthenticated(): Promise<boolean> {
    return true;
  }

  // Build booking URL
  buildBookingUrl(restaurantId: number, date: string, time: string, partySize: number): string {
    const params = new URLSearchParams({
      rid: String(restaurantId),
      datetime: `${date}T${time}`,
      covers: String(partySize),
    });
    return `${BOOKING_BASE}?${params.toString()}`;
  }
}

// Singleton instance
export const openTableClient = new OpenTablePlatformClient();
