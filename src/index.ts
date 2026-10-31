import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import OAuthProvider from '@cloudflare/workers-oauth-provider';
import { z } from 'zod';
import { handleAccessRequest } from './access-handler.js';

import {
  setCredential,
  getCredential,
  deleteCredential,
  getResyAuthStatus,
  getOpenTableAuthStatus,
} from './credentials.js';
import { resyClient } from './platforms/resy.js';
import { openTableClient } from './platforms/opentable.js';
import { tockClient } from './platforms/tock.js';
import { parseRestaurantId } from './platforms/base.js';
import {
  findTable,
  searchRestaurant,
  getRestaurantById,
  getRestaurantsByIds,
  getRestaurantDetails,
  checkAvailability,
  getBookingOptions,
  getPlatformHealth,
  getAvailablePlatforms,
  getPlatformClient,
} from './services/search.js';
import { rateLimiter } from './services/rate-limiter.js';
import { cache } from './services/cache.js';
import type { PlatformName, ReservationParams } from './types/restaurant.js';
import {
  snipeReservation,
  snipeReservationSchema,
  listScheduledSnipes,
  listSnipesSchema,
  cancelSnipe,
  cancelSnipeSchema,
} from './tools/snipe.js';
import { runDueSnipes } from './sniper/scheduler.js';
import { setEnv, type Env } from './env.js';

// Schemas for tool inputs
const findTableSchema = z.object({
  restaurant: z.string().min(1).max(100).describe('Restaurant name'),
  location: z.string().min(1).max(100).describe('City or neighborhood'),
  date: z.string().describe('Date (YYYY-MM-DD) or relative like "friday", "tomorrow"'),
  time: z.string().describe('Preferred time like "noon", "7pm", "around 8"'),
  party_size: z.number().int().min(1).max(20).default(2).describe('Number of guests'),
  book: z.boolean().default(true).describe('Automatically book the best available slot'),
});

const searchRestaurantSchema = z.object({
  name: z.string().min(1).max(100).describe('Restaurant name to search for'),
  location: z.string().min(1).max(100).describe('City or neighborhood'),
  date: z.string().optional().describe('Optional date for availability context (YYYY-MM-DD)'),
  party_size: z.number().int().min(1).max(20).default(2).describe('Party size'),
});

const getRestaurantSchema = z.object({
  restaurant_id: z.string().min(1).describe('Restaurant ID in format "platform-id" (e.g., resy-12345, opentable-67890, tock-venue-slug)'),
});

const getRestaurantsSchema = z.object({
  restaurant_ids: z.array(z.string()).min(1).max(20).describe('Array of restaurant IDs to look up'),
});

const checkAvailabilitySchema = z.object({
  restaurant_id: z.string().min(1).describe('Restaurant ID (e.g., resy-12345, opentable-67890, tock-abc)'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Date to check (YYYY-MM-DD)'),
  party_size: z.number().int().min(1).max(20).describe('Number of guests'),
});

const makeReservationSchema = z.object({
  restaurant_id: z.string().min(1).describe('Restaurant ID'),
  slot_id: z.string().min(1).describe('Time slot ID from check_availability'),
  party_size: z.number().int().min(1).max(20).describe('Number of guests'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe('Reservation date (YYYY-MM-DD)'),
});


const getBookingOptionsSchema = z.object({
  restaurant_id: z.string().min(1).describe('Restaurant ID'),
});

const listReservationsSchema = z.object({
  platform: z.enum(['resy', 'opentable', 'tock', 'all']).default('all').describe('Platform filter'),
});

const cancelReservationSchema = z.object({
  reservation_id: z.string().min(1).describe('Reservation ID to cancel'),
  platform: z.enum(['resy', 'opentable', 'tock']).describe('Platform'),
});

const setCredentialsSchema = z.object({
  platform: z.enum(['resy', 'opentable']).describe('Platform to set credentials for'),
  api_key: z.string().optional().describe('API key (required for Resy)'),
  auth_token: z.string().optional().describe('Authentication token'),
});

const setLoginSchema = z.object({
  platform: z.enum(['resy']).describe('Platform (currently only Resy supported)'),
});

const checkAuthStatusSchema = z.object({
  platform: z.enum(['resy', 'opentable', 'tock', 'all']).default('all').describe('Platform to check'),
});

const refreshTokenSchema = z.object({
  platform: z.enum(['resy']).describe('Platform to refresh token for'),
});

// McpServer.tool infers a Zod generic that exhausts tsc. Handlers validate with schema.parse.
function toolArgs(schema: { shape: unknown }) {
  return schema.shape as any;
}

function registerTools(server: McpServer) {
  server.tool('find_table', 'Find and book a table at a restaurant.', toolArgs(findTableSchema), async (args: unknown) => {
    const input = findTableSchema.parse(args);
    const result = await findTable(input.restaurant, input.location, input.date, input.time, input.party_size, input.book);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('search_restaurant', 'Search Resy (geocoded, radius-limited), OpenTable, and SevenRooms by venue URL key. Tock has no public directory search because exploretock.com challenges datacenter clients; only venues saved with add_tock_venue are returned.', toolArgs(searchRestaurantSchema), async (args: unknown) => {
    const input = searchRestaurantSchema.parse(args);
    const result = await searchRestaurant(input.name, input.location, input.date, input.party_size);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('get_restaurant', 'Look up a restaurant by its platform-specific ID.', toolArgs(getRestaurantSchema), async (args: unknown) => {
    const input = getRestaurantSchema.parse(args);
    const result = await getRestaurantById(input.restaurant_id);
    if (result.error || !result.restaurant) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: result.error || 'Restaurant not found' }, null, 2) }] };
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(result.restaurant, null, 2) }] };
  });

  server.tool('get_restaurants', 'Look up multiple restaurants by their IDs.', toolArgs(getRestaurantsSchema), async (args: unknown) => {
    const input = getRestaurantsSchema.parse(args);
    const results = await getRestaurantsByIds(input.restaurant_ids);
    const output = results.map((r) => ({ id: r.restaurant?.id, name: r.restaurant?.name, platform: r.platform, found: r.restaurant !== null, error: r.error, details: r.restaurant }));
    return { content: [{ type: 'text' as const, text: JSON.stringify(output, null, 2) }] };
  });

  server.tool('check_availability', 'Get available time slots. Ids look like resy-123, opentable-67890, sevenrooms-rezdora, or tock-4 / tock-alinea.', toolArgs(checkAvailabilitySchema), async (args: unknown) => {
    const input = checkAvailabilitySchema.parse(args);
    const result = await checkAvailability(input.restaurant_id, input.date, input.party_size);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('make_reservation', 'Book a reservation.', toolArgs(makeReservationSchema), async (args: unknown) => {
    const input = makeReservationSchema.parse(args);
    const parsed = parseRestaurantId(input.restaurant_id);
    if (!parsed) return { content: [{ type: 'text' as const, text: `Invalid restaurant ID: ${input.restaurant_id}` }] };
    const client = getPlatformClient(parsed.platform);
    const params: ReservationParams = { restaurantId: input.restaurant_id, platform: parsed.platform, slotId: input.slot_id, date: input.date, partySize: input.party_size };
    const result = await client.makeReservation(params);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('get_booking_options', 'Get all ways to book a restaurant.', toolArgs(getBookingOptionsSchema), async (args: unknown) => {
    const input = getBookingOptionsSchema.parse(args);
    const options = await getBookingOptions(input.restaurant_id);
    return { content: [{ type: 'text' as const, text: JSON.stringify(options, null, 2) }] };
  });

  server.tool('list_reservations', 'View your upcoming reservations.', toolArgs(listReservationsSchema), async (args: unknown) => {
    const input = listReservationsSchema.parse(args);
    const results: Array<{ platform: string; reservationId: string; resy_token?: string; reservation_id?: string; restaurantName: string; location: string; date: string; time: string; partySize: number; status: string }> = [];
    const errors: Record<string, string> = {};
    if (input.platform === 'resy' || input.platform === 'all') {
      try {
        const resyReservations = await resyClient.getReservations();
        for (const r of resyReservations) {
          results.push({ platform: 'resy', reservationId: r.resy_token, resy_token: r.resy_token, reservation_id: r.reservation_id, restaurantName: r.venue.name, location: r.venue.location, date: r.date, time: r.time, partySize: r.partySize, status: r.status });
        }
      } catch (error) {
        errors.resy = error instanceof Error ? error.message : 'Failed to list Resy reservations';
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ reservations: results, errors }, null, 2) }] };
  });

  server.tool('cancel_reservation', 'Cancel an existing reservation.', toolArgs(cancelReservationSchema), async (args: unknown) => {
    const input = cancelReservationSchema.parse(args);
    if (input.platform === 'resy') {
      try {
        await resyClient.cancelReservation(input.reservation_id);
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: true, message: 'Reservation cancelled successfully' }, null, 2) }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, message: error instanceof Error ? error.message : 'Failed to cancel' }, null, 2) }] };
      }
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify({ success: false, message: `${input.platform} reservations must be cancelled on their website` }, null, 2) }] };
  });

  server.tool('set_credentials', 'Securely store API credentials.', toolArgs(setCredentialsSchema), async (args: unknown) => {
    const input = setCredentialsSchema.parse(args);
    const stored: string[] = [];
    if (input.platform === 'resy') {
      if (input.api_key) { await setCredential('resy-api-key', input.api_key); stored.push('API key'); }
      if (input.auth_token) { await setCredential('resy-auth-token', input.auth_token); stored.push('auth token'); }
    } else {
      if (input.auth_token) { await setCredential('opentable-token', input.auth_token); stored.push('auth token'); }
    }
    return { content: [{ type: 'text' as const, text: stored.length > 0 ? `Stored ${stored.join(' and ')} for ${input.platform}.` : 'No credentials provided to store.' }] };
  });

  server.tool('set_login', 'Resy login is a Worker secret, not KV. Explains how to set RESY_EMAIL and RESY_PASSWORD.', toolArgs(setLoginSchema), async (args: unknown) => {
    const input = setLoginSchema.parse(args);
    if (input.platform !== 'resy') {
      return { content: [{ type: 'text' as const, text: 'Only Resy login is currently supported.' }] };
    }
    await deleteCredential('resy-email');
    await deleteCredential('resy-password');
    return { content: [{ type: 'text' as const, text: 'Resy email and password are not stored in KV. Set them with `wrangler secret put RESY_EMAIL` and `wrangler secret put RESY_PASSWORD`. Optional auth token: `wrangler secret put RESY_AUTH_TOKEN`.' }] };
  });

  server.tool('check_auth_status', 'Check if credentials are configured and valid.', toolArgs(checkAuthStatusSchema), async (args: unknown) => {
    const input = checkAuthStatusSchema.parse(args);
    const statuses: Record<string, unknown>[] = [];
    if (input.platform === 'resy' || input.platform === 'all') {
      const status = await getResyAuthStatus();
      const isValid = status.hasAuthToken ? await resyClient.isAuthenticated() : false;
      statuses.push({ ...status, isValid });
    }
    if (input.platform === 'opentable' || input.platform === 'all') {
      const status = await getOpenTableAuthStatus();
      statuses.push({ ...status, isValid: true });
    }
    if (input.platform === 'tock' || input.platform === 'all') {
      statuses.push({ platform: 'tock', hasApiKey: false, hasAuthToken: false, hasLogin: false, isValid: true });
    }
    return { content: [{ type: 'text' as const, text: JSON.stringify(statuses, null, 2) }] };
  });

  server.tool('refresh_token', 'Manually refresh authentication token.', toolArgs(refreshTokenSchema), async (args: unknown) => {
    const input = refreshTokenSchema.parse(args);
    if (input.platform === 'resy') {
      const email = await getCredential('resy-email');
      const password = await getCredential('resy-password');
      if (!email || !password) return { content: [{ type: 'text' as const, text: 'RESY_EMAIL and RESY_PASSWORD are not set. Add them with `wrangler secret put RESY_EMAIL` and `wrangler secret put RESY_PASSWORD`.' }] };
      try {
        await resyClient.login(email, password);
        return { content: [{ type: 'text' as const, text: 'Token refreshed successfully!' }] };
      } catch (error) {
        return { content: [{ type: 'text' as const, text: `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}` }] };
      }
    }
    return { content: [{ type: 'text' as const, text: 'Only Resy token refresh is supported.' }] };
  });

  server.tool('snipe_reservation', 'Schedule an automatic booking attempt.', toolArgs(snipeReservationSchema), async (args: unknown) => {
    const input = snipeReservationSchema.parse(args);
    const result = await snipeReservation(input);
    (result as any).note = 'Checked by a once-per-minute cron; polls ~30s before release for up to 2.5 min.';
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  server.tool('list_snipes', 'View all scheduled snipe attempts.', toolArgs(listSnipesSchema), async (args: unknown) => {
    const input = listSnipesSchema.parse(args);
    const results = await listScheduledSnipes(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(results, null, 2) }] };
  });

  server.tool('cancel_snipe', 'Cancel a scheduled snipe attempt.', toolArgs(cancelSnipeSchema), async (args: unknown) => {
    const input = cancelSnipeSchema.parse(args);
    const result = await cancelSnipe(input);
    return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
  });

  const addTockVenueSchema = z.object({
    slug: z.string().min(1).describe('Tock URL slug, such as alinea'),
    business_id: z.string().min(1).describe('Tock businessId used by the calendar API'),
    name: z.string().optional().describe('Display name'),
  });

  server.tool('add_tock_venue', 'Save a Tock slug and businessId in KV so availability can be checked when exploretock.com challenges slug lookups. Does not book.', toolArgs(addTockVenueSchema), async (args: unknown) => {
    const input = addTockVenueSchema.parse(args);
    const saved = await tockClient.saveVenue(input.slug, input.business_id, input.name);
    return { content: [{ type: 'text' as const, text: JSON.stringify({ id: `tock-${saved.slug}`, ...saved }, null, 2) }] };
  });

  server.tool('get_platform_status', 'Check health and rate limit status of all platforms.', {}, async () => {
    const health = await getPlatformHealth();
    const rateLimits = rateLimiter.getAllStatus();
    const cacheStats = cache.stats();
    const status = { platforms: Object.entries(health).map(([platform, available]) => ({ platform, available, rateLimit: rateLimits.find((r) => r.platform === platform) })), cache: cacheStats };
    return { content: [{ type: 'text' as const, text: JSON.stringify(status, null, 2) }] };
  });
}


const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Accept, Authorization, Mcp-Session-Id, Mcp-Protocol-Version' };

const apiHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    setEnv(env);
    if (request.method !== 'POST') {
      return Response.json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed' }, id: null }, { status: 405, headers: cors });
    }
    const server = new McpServer({ name: 'restaurant-reservations', version: '2.0.0' });
    registerTools(server);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    const res = await transport.handleRequest(request);
    const h = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) h.set(k, v);
    return new Response(res.body, { status: res.status, headers: h });
  },
};

let provider: OAuthProvider<Env> | undefined;

function getProvider(env: Env): OAuthProvider<Env> {
  if (!env.MCP_RESOURCE) throw new Error('MCP_RESOURCE is not configured');
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: '/mcp',
      apiHandler,
      defaultHandler: { fetch: handleAccessRequest },
      authorizeEndpoint: '/authorize',
      tokenEndpoint: '/token',
      clientRegistrationEndpoint: '/register',
      resourceMetadata: {
        resource: env.MCP_RESOURCE,
        resource_name: 'Restaurant reservations',
      },
    });
  }
  return provider;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    setEnv(env);
    return getProvider(env).fetch(request, env, ctx);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    setEnv(env);
    ctx.waitUntil(runDueSnipes());
  },
} satisfies ExportedHandler<Env>;
