/**
 * Resy platform client implementing PlatformClient interface
 */

import axios, { AxiosInstance, AxiosError } from 'axios';
import { getCredential, setCredential } from '../credentials.js';
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
  ReservationError,
} from '../types/restaurant.js';
import { cache, CacheKeys, CacheTTL } from '../services/cache.js';
import { rateLimiter } from '../services/rate-limiter.js';
import { parseResySearchBody, type ParsedResyVenue } from '../resy/search-results.js';
import { geocodeLocation, searchRadiusMeters } from '../resy/geocode.js';
import { findResyToken, parseResyReservations } from '../resy/reservations.js';

const BASE_URL = 'https://api.resy.com';

interface ResySlot {
  config: { id: number; type: string; token: string };
  date: { start: string; end: string };
  payment?: { cancellation_fee?: number; deposit_fee?: number };
}

interface ResyVenueSlotsResponse {
  results: {
    venues: Array<{
      venue: { id: { resy: number }; name: string };
      slots: ResySlot[];
    }>;
  };
}

interface ResyBookDetailsResponse {
  book_token: { value: string; date_expires: string };
  user: { payment_methods: Array<{ id: number; is_default: boolean }> };
}

interface ResyBookResponse {
  resy_token: string;
  reservation_id: number;
}

interface ResyLoginResponse {
  id: number;
  token: string;
  first_name: string;
  last_name: string;
  email: string;
}

function isGenericQuery(query: string): boolean {
  return /^(restaurants?|food|dinner|lunch|bar|bars)$/i.test(query.trim());
}

function filterHitsByRadius(data: unknown, coords: { lat: number; lng: number }, radiusMeters: number): unknown {
  if (!data || typeof data !== 'object') return data;
  const body = data as { search?: { hits?: unknown[] } };
  const hits = body.search?.hits;
  if (!Array.isArray(hits)) return data;
  const kept = hits.filter((hit) => {
    if (!hit || typeof hit !== 'object') return false;
    const geo = (hit as { _geoloc?: { lat?: number; lng?: number } })._geoloc;
    if (typeof geo?.lat !== 'number' || typeof geo?.lng !== 'number') return true;
    return haversineMeters(coords.lat, coords.lng, geo.lat, geo.lng) <= radiusMeters * 1.15;
  });
  return { ...body, search: { ...body.search, hits: kept } };
}

function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export class ResyPlatformClient extends BasePlatformClient {
  readonly name: PlatformName = 'resy';
  private client: AxiosInstance;
  private apiKey: string | null = null;
  private authToken: string | null = null;

  constructor() {
    super();
    this.client = axios.create({
      adapter: 'fetch',
      baseURL: BASE_URL,
      timeout: 15000, // 15 second timeout
    });
  }

  private async ensureCredentials(): Promise<void> {
    if (!this.apiKey) {
      this.apiKey = await getCredential('resy-api-key');
    }
    if (!this.authToken) {
      this.authToken = await getCredential('resy-auth-token');
    }
    if (!this.apiKey) {
      throw new Error('Resy API key not configured. Use set_credentials tool first.');
    }
  }

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json, text/plain, */*',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
      'Origin': 'https://resy.com',
      'Referer': 'https://resy.com/',
      'x-origin': 'https://resy.com',
    };
    if (this.apiKey) {
      headers['Authorization'] = `ResyAPI api_key="${this.apiKey}"`;
    }
    if (this.authToken) {
      headers['x-resy-auth-token'] = this.authToken;
      headers['x-resy-universal-auth'] = this.authToken;
    }
    return headers;
  }

  private async refreshToken(): Promise<boolean> {
    const email = await getCredential('resy-email');
    const password = await getCredential('resy-password');

    if (!email || !password) {
      return false;
    }

    try {
      const response = await this.client.post<ResyLoginResponse>(
        '/3/auth/password',
        new URLSearchParams({ email, password }).toString(),
        { headers: this.getHeaders() }
      );

      this.authToken = response.data.token;
      await setCredential('resy-auth-token', this.authToken);
      return true;
    } catch {
      return false;
    }
  }

  private async request<T>(
    method: 'get' | 'post' | 'delete',
    url: string,
    data?: Record<string, string | number>,
    retry = true
  ): Promise<T> {
    await this.ensureCredentials();

    // Check rate limit
    if (!await rateLimiter.acquire(this.name)) {
      throw new Error('Rate limited. Please try again later.') as ReservationError;
    }

    try {
      const config = { headers: this.getHeaders() };

      let response;
      if (method === 'get') {
        response = await this.client.get<T>(url, { ...config, params: data });
      } else if (method === 'post') {
        const body = data ? new URLSearchParams(data as Record<string, string>).toString() : '';
        response = await this.client.post<T>(url, body, config);
      } else {
        response = await this.client.delete<T>(url, { ...config, params: data });
      }

      return response.data;
    } catch (error) {
      // Handle both 401 and 419 as auth errors
      if (error instanceof AxiosError && (error.response?.status === 401 || error.response?.status === 419) && retry) {
        console.log(`Resy auth error (${error.response?.status}), attempting token refresh...`);
        const refreshed = await this.refreshToken();
        if (refreshed) {
          return this.request<T>(method, url, data, false);
        }
        throw new Error('Resy authentication failed. Set Worker secrets with `wrangler secret put RESY_EMAIL` and `wrangler secret put RESY_PASSWORD`.');
      }
      throw error;
    }
  }

  async search(query: SearchQuery): Promise<Restaurant[]> {
    const fallback = this.getCityCoordinates(query.location);
    const geocoded = await geocodeLocation(query.location).catch(() => null);
    const coords = geocoded ?? { lat: fallback.lat, lng: fallback.lng };
    const radius = searchRadiusMeters(query.location);

    console.error(`Resy search: "${query.query}" in "${query.location}" @ ${coords.lat},${coords.lng} r=${radius}m`);

    try {
      await this.ensureCredentials();
      // geo.radius is meters. Values under 1 are ignored; a missing radius does not
      // keep results in the requested city.
      const body = await this.venueSearch(query.query, coords, radius);
      const hits = parseResySearchBody(filterHitsByRadius(body, coords, radius), query.query);
      if (hits.length === 0 && isGenericQuery(query.query)) {
        const nearby = await this.venueSearch('', coords, radius);
        return parseResySearchBody(filterHitsByRadius(nearby, coords, radius)).map((hit) => this.mapToRestaurant(hit));
      }
      console.error(`Resy search found ${hits.length} results`);
      return hits.map((hit) => this.mapToRestaurant(hit));
    } catch (error) {
      console.error('Resy search error:', error instanceof Error ? error.message : error);
      return [];
    }
  }

  private async venueSearch(text: string, coords: { lat: number; lng: number }, radius: number): Promise<unknown> {
    const response = await this.client.post(
      '/3/venuesearch/search',
      {
        query: text,
        geo: { latitude: coords.lat, longitude: coords.lng, radius },
        per_page: 20,
        types: ['venue'],
      },
      {
        headers: {
          ...this.getHeaders(),
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        timeout: 30000,
      }
    );
    return response.data;
  }

  private getLocationSlug(location: string): string {
    const locationLower = location.toLowerCase();

    const locationSlugs: Record<string, string> = {
      'new york': 'new-york-ny',
      'nyc': 'new-york-ny',
      'manhattan': 'new-york-ny',
      'brooklyn': 'new-york-ny',
      'los angeles': 'los-angeles-ca',
      'la': 'los-angeles-ca',
      'chicago': 'chicago-il',
      'san francisco': 'san-francisco-ca',
      'sf': 'san-francisco-ca',
      'miami': 'miami-fl',
      'austin': 'austin-tx',
      'seattle': 'seattle-wa',
      'boston': 'boston-ma',
      'denver': 'denver-co',
      'atlanta': 'atlanta-ga',
      'dallas': 'dallas-tx',
      'houston': 'houston-tx',
      'philadelphia': 'philadelphia-pa',
      'washington': 'washington-dc',
      'dc': 'washington-dc',
      'las vegas': 'las-vegas-nv',
      'vegas': 'las-vegas-nv',
      'nashville': 'nashville-tn',
      'portland': 'portland-or',
      'san diego': 'san-diego-ca',
    };

    for (const [city, slug] of Object.entries(locationSlugs)) {
      if (locationLower.includes(city)) {
        return slug;
      }
    }

    // Default: convert location to slug format
    return locationLower.replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
  }

  private getCityCoordinates(location: string): { lat: number; lng: number } {
    const locationLower = location.toLowerCase();

    // Common city coordinates
    const cities: Record<string, { lat: number; lng: number }> = {
      'new york': { lat: 40.7128, lng: -73.9352 },
      'nyc': { lat: 40.7128, lng: -73.9352 },
      'manhattan': { lat: 40.7831, lng: -73.9712 },
      'brooklyn': { lat: 40.6782, lng: -73.9442 },
      'los angeles': { lat: 34.0522, lng: -118.2437 },
      'la': { lat: 34.0522, lng: -118.2437 },
      'chicago': { lat: 41.8781, lng: -87.6298 },
      'san francisco': { lat: 37.7749, lng: -122.4194 },
      'sf': { lat: 37.7749, lng: -122.4194 },
      'miami': { lat: 25.7617, lng: -80.1918 },
      'austin': { lat: 30.2672, lng: -97.7431 },
      'seattle': { lat: 47.6062, lng: -122.3321 },
      'boston': { lat: 42.3601, lng: -71.0589 },
      'denver': { lat: 39.7392, lng: -104.9903 },
      'atlanta': { lat: 33.7490, lng: -84.3880 },
      'dallas': { lat: 32.7767, lng: -96.7970 },
      'houston': { lat: 29.7604, lng: -95.3698 },
      'philadelphia': { lat: 39.9526, lng: -75.1652 },
      'washington': { lat: 38.9072, lng: -77.0369 },
      'dc': { lat: 38.9072, lng: -77.0369 },
      'las vegas': { lat: 36.1699, lng: -115.1398 },
      'vegas': { lat: 36.1699, lng: -115.1398 },
      'nashville': { lat: 36.1627, lng: -86.7816 },
      'portland': { lat: 45.5152, lng: -122.6784 },
      'san diego': { lat: 32.7157, lng: -117.1611 },
    };

    // Check if location matches any known city
    for (const [city, coords] of Object.entries(cities)) {
      if (locationLower.includes(city)) {
        return coords;
      }
    }

    // Default to New York if no match
    return { lat: 40.7128, lng: -73.9352 };
  }

  async getDetails(id: string | number): Promise<RestaurantDetails | null> {
    const numericId = typeof id === 'string' ? parseInt(this.extractId(id), 10) : id;

    // Check cache
    const cacheKey = CacheKeys.details(this.name, numericId);
    const cached = cache.get<RestaurantDetails>(cacheKey);
    if (cached) return cached;

    try {
      // Use /4/find with venue_id to get venue info (same endpoint as availability)
      const data = await this.request<ResyVenueSlotsResponse>('get', '/4/find', {
        lat: 0,
        long: 0,
        day: this.today(),
        party_size: 2,
        venue_id: numericId,
      });

      const venue = data.results?.venues?.[0];
      if (!venue) return null;

      // Build details from the find response
      const details: RestaurantDetails = {
        id: this.createId(numericId),
        platformIds: { resy: numericId },
        name: venue.venue.name,
        cuisines: [],
        priceRange: 2 as PriceRange,
        rating: 0,
        reviewCount: 0,
        address: {
          street: '',
          city: '',
          state: '',
          zip: '',
        },
        acceptsOnlineReservations: true,
        reservationPlatforms: [this.name],
        bookingUrls: {
          resy: `https://resy.com/cities/ny/venues/${numericId}`,
        },
        images: [],
        lastUpdated: new Date().toISOString(),
      };

      cache.set(cacheKey, details, CacheTTL.RESTAURANT_DETAILS);
      return details;
    } catch (error) {
      console.error('Resy getDetails error:', error);
      return null;
    }
  }

  async getAvailability(id: string | number, date: string, partySize: number): Promise<TimeSlot[]> {
    const numericId = typeof id === 'string' ? parseInt(this.extractId(id), 10) : id;

    // Check cache
    const cacheKey = CacheKeys.availability(this.name, numericId, date, partySize);
    const cached = cache.get<TimeSlot[]>(cacheKey);
    if (cached) return cached;

    try {
      const data = await this.request<ResyVenueSlotsResponse>('get', '/4/find', {
        lat: 0,
        long: 0,
        day: date,
        party_size: partySize,
        venue_id: numericId,
      });

      const venue = data.results?.venues?.[0];
      if (!venue?.slots) {
        return [];
      }

      const slots = venue.slots.map((slot) => this.mapToTimeSlot(slot));
      cache.set(cacheKey, slots, CacheTTL.AVAILABILITY);
      return slots;
    } catch (error) {
      console.error('Resy getAvailability error:', error);
      return [];
    }
  }

  async makeReservation(params: ReservationParams): Promise<ReservationResult> {
    try {
      // Get booking details (includes book token and payment methods)
      const details = await this.request<ResyBookDetailsResponse>('get', '/3/details', {
        config_id: params.slotId,
        day: params.date,
        party_size: params.partySize,
      });

      // Get default payment method if available
      const defaultPayment = details.user.payment_methods?.find((p) => p.is_default);

      // Make the reservation
      const bookData: Record<string, string> = {
        book_token: details.book_token.value,
      };
      if (defaultPayment) {
        bookData.struct_payment_method = JSON.stringify({ id: defaultPayment.id });
      }

      const result = await this.request<ResyBookResponse>('post', '/3/book', bookData);

      // Invalidate availability cache
      cache.invalidate(`availability:${this.name}:*`);

      return {
        success: true,
        platform: this.name,
        reservationId: String(result.reservation_id),
        confirmationDetails: `Reservation confirmed! ID: ${result.reservation_id}`,
      };
    } catch (error) {
      return {
        success: false,
        platform: this.name,
        error: error instanceof Error ? error.message : 'Failed to make reservation',
      };
    }
  }

  async isAvailable(): Promise<boolean> {
    // Check cache
    const cacheKey = CacheKeys.health(this.name);
    const cached = cache.get<boolean>(cacheKey);
    if (cached !== null) return cached;

    try {
      await this.ensureCredentials();
      // Health check using /4/find which is the working search endpoint
      const response = await this.client.get('/4/find', {
        headers: this.getHeaders(),
        params: { lat: 40.7128, long: -73.9352, day: this.today(), party_size: 2, query: 'carbone', limit: 1 },
        timeout: 30000,
      });
      const available = response.status === 200;
      cache.set(cacheKey, available, CacheTTL.PLATFORM_HEALTH);
      return available;
    } catch (error) {
      console.error('Resy isAvailable error:', error instanceof Error ? error.message : error);
      cache.set(cacheKey, false, CacheTTL.PLATFORM_HEALTH);
      return false;
    }
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.ensureCredentials();
      if (!this.authToken) return false;

      // Try to get user reservations to verify auth
      await this.request<{ reservations: unknown[] }>('get', '/3/user/reservations');
      return true;
    } catch {
      return false;
    }
  }

  // Login method for credential management
  async login(email: string, password: string): Promise<ResyLoginResponse> {
    await this.ensureCredentials();

    const response = await this.client.post<ResyLoginResponse>(
      '/3/auth/password',
      new URLSearchParams({ email, password }).toString(),
      { headers: this.getHeaders() }
    );

    this.authToken = response.data.token;
    // Cache the short-lived token only. Email and password stay in Worker secrets.
    await setCredential('resy-auth-token', this.authToken);

    return response.data;
  }

  // Get user's reservations
  async getReservations(): Promise<Array<{
    reservationId: string;
    resy_token: string;
    reservation_id?: string;
    venue: { name: string; location: string };
    date: string;
    time: string;
    partySize: number;
    status: string;
  }>> {
    const data = await this.request<unknown>('get', '/3/user/reservations', { type: 'upcoming' });
    return parseResyReservations(data).map((res) => ({
      reservationId: res.resy_token,
      resy_token: res.resy_token,
      reservation_id: res.reservation_id,
      venue: { name: res.venueName, location: res.location },
      date: res.date,
      time: res.time,
      partySize: res.partySize,
      status: res.status,
    }));
  }

  // Cancel a reservation. Numeric ids are looked up; Resy cancels with resy_token.
  async cancelReservation(idOrToken: string): Promise<void> {
    const token = await this.resolveResyToken(idOrToken);
    await this.request<void>('post', '/3/cancel', { resy_token: token });
  }

  private async resolveResyToken(idOrToken: string): Promise<string> {
    if (!/^\d+$/.test(idOrToken.trim())) return idOrToken.trim();
    const reservations = await this.getReservations();
    const token = findResyToken(reservations.map((reservation) => ({
      resy_token: reservation.resy_token,
      reservation_id: reservation.reservation_id,
      venueName: reservation.venue.name,
      location: reservation.venue.location,
      date: reservation.date,
      time: reservation.time,
      partySize: reservation.partySize,
      status: reservation.status,
    })), idOrToken.trim());
    if (!token) {
      throw new Error(`No upcoming Resy reservation found for id ${idOrToken}. Cancel with the reservation's resy_token.`);
    }
    return token;
  }

  // Helper methods
  private mapToRestaurant(hit: ParsedResyVenue): Restaurant {
    return {
      id: this.createId(hit.id),
      platform: this.name,
      platformId: hit.id,
      name: hit.name,
      location: hit.location,
      neighborhood: hit.neighborhood || undefined,
      cuisine: hit.cuisines.join(', '),
      cuisines: hit.cuisines,
      priceRange: hit.priceRange,
      rating: hit.rating,
      imageUrl: hit.imageUrl,
    };
  }

  private mapToTimeSlot(slot: ResySlot): TimeSlot {
    return {
      slotId: String(slot.config.id),
      platform: this.name,
      time: slot.date.start,
      endTime: slot.date.end,
      type: slot.config.type,
      token: slot.config.token,
      cancellationFee: slot.payment?.cancellation_fee,
      depositFee: slot.payment?.deposit_fee,
    };
  }
}

// Singleton instance
export const resyClient = new ResyPlatformClient();
