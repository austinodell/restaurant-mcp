# Restaurant Reservation MCP Server

A remote MCP server for searching and booking restaurant reservations. It runs as a Cloudflare Worker at `https://restaurant-mcp.odell.io/mcp`.

Clients authenticate with OAuth 2.1. The Worker is the authorization server (`workers-oauth-provider`) and Cloudflare Access is the identity provider, using an Access for SaaS OIDC application. This is the same shape as [Cloudflare's remote MCP Access example](https://github.com/cloudflare/ai/tree/main/demos/remote-mcp-cf-access) and the [Secure MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/) guide. There is no static bearer token and no `MCP_TOKEN` fallback.

Discovery:

- `https://restaurant-mcp.odell.io/.well-known/oauth-authorization-server`
- `https://restaurant-mcp.odell.io/.well-known/oauth-protected-resource/mcp`
- Dynamic client registration: `https://restaurant-mcp.odell.io/register`

`GET /health` stays public. `POST /mcp` requires an access token issued by this Worker. The once-a-minute snipe cron does not go through OAuth.

## Zero Trust setup

Do these in the Cloudflare account that owns the `odell.io` zone (Zero Trust team `aodell.cloudflareaccess.com`) before deploying. The One-time PIN identity provider is already on that team.

### 1. Access for SaaS OIDC application

1. Open [Zero Trust](https://one.dash.cloudflare.com/) → **Access controls** → **Applications**.
2. **Create new application** → **SaaS**.
3. Name it `restaurant-mcp`.
4. Authentication protocol: **OIDC**. Select **Add application**.
5. Redirect URL (exact): `https://restaurant-mcp.odell.io/callback`
6. Scopes: `openid`, `email`, `profile`. The Worker requests those so the ID token contains `email`.
7. Grant type: **Authorization code with PKCE** (`authorization_code_with_pkce`). The authorize redirect sends `code_challenge` with `S256`. Optional: turn on **Refresh tokens** if you want fewer Access logins. Do not use the OAuth values from a third-party IdP; use the Access for SaaS endpoints.
8. Copy these values. They become Worker secrets in the next section. Do not commit them.

   | Worker secret | Access for SaaS field |
   | --- | --- |
   | `ACCESS_CLIENT_ID` | Client ID |
   | `ACCESS_CLIENT_SECRET` | Client secret |
   | `ACCESS_TOKEN_URL` | Token endpoint |
   | `ACCESS_AUTHORIZATION_URL` | Authorization endpoint |
   | `ACCESS_JWKS_URL` | Key endpoint (JWKS) |

   The endpoints look like `https://aodell.cloudflareaccess.com/cdn-cgi/access/sso/oidc/<client_id>/{authorization,token,jwks}`.

### 2. Allow only the owner

On that SaaS application, add one Allow policy and no others.

| Field | Value |
| --- | --- |
| Policy name | `restaurant-mcp owner` |
| Action | Allow |
| Include | Selector **Emails**, value `austin@odell.io` |
| Exclude / Require | empty |
| Identity provider | One-time PIN (the team's only IdP) |

One Include rule is enough. A second Include is OR and would let someone else through. Do not add a Bypass policy and do not add an Everyone rule.

`wrangler.jsonc` sets `OWNER_EMAIL` to `austin@odell.io`. After Access issues an ID token, the Worker checks the `email` claim against that variable and refuses every other address. The Access policy and `OWNER_EMAIL` must stay the same address. Changing who can connect means editing both, then redeploying.

### 3. OAuth state KV

The authorization server stores grants, registration, and upstream login state in the `OAUTH_KV` binding. That namespace already exists:

| Binding | Name | ID |
| --- | --- | --- |
| `OAUTH_KV` | `restaurant-mcp-oauth` | `3d876299b9544f5ba24fe7fc865aa666` |
| `CREDS` | `restaurant-mcp-creds` | `7d05dafe369446c29cdd0cd61bf6b60e` |

`CREDS` is unchanged. It still holds API keys, cached Resy tokens, saved Tock venues, and snipe jobs. To recreate the OAuth namespace on a new account:

```bash
npx wrangler kv namespace create OAUTH_KV
```

Put the printed id in `wrangler.jsonc` under the `OAUTH_KV` binding, and in `deploy-build.sh` the binding is read from that file.

### 4. Worker secrets

Generate the cookie key locally (`openssl rand -hex 32` prints 64 hex characters; the Worker requires at least 32). Then:

```bash
npx wrangler secret put ACCESS_CLIENT_ID
npx wrangler secret put ACCESS_CLIENT_SECRET
npx wrangler secret put ACCESS_TOKEN_URL
npx wrangler secret put ACCESS_AUTHORIZATION_URL
npx wrangler secret put ACCESS_JWKS_URL
npx wrangler secret put COOKIE_ENCRYPTION_KEY
```

`COOKIE_ENCRYPTION_KEY` signs the "remember this MCP client" cookie. It is not an Access credential.

Upstream Resy login stays in Worker secrets and is never written to KV:

```bash
npx wrangler secret put RESY_EMAIL
npx wrangler secret put RESY_PASSWORD
npx wrangler secret put RESY_AUTH_TOKEN   # optional
```

Non-secret vars in `wrangler.jsonc`:

- `MCP_RESOURCE` = `https://restaurant-mcp.odell.io/mcp` (every token is bound to this URL)
- `OWNER_EMAIL` = `austin@odell.io`

For local `wrangler dev`, copy `.dev.vars.example` to `.dev.vars` and fill the same Access secrets. `.dev.vars` is gitignored. Add `http://localhost:8787/callback` as a second redirect URL on the SaaS app only if you need local login, and point `MCP_RESOURCE` at that local `/mcp` URL in `.dev.vars`.

### 5. Deploy

Do not deploy until the Access app, the owner policy, and the six Access secrets exist. `wrangler.jsonc` marks those secrets required, so `wrangler deploy` stops if they are missing.

This repo is deployed with the Cloudflare API, not Workers Builds. From a shell that has `CLOUDFLARE_API_TOKEN` (Workers Scripts Write, and Account Settings Read or the equivalent that can attach a Worker custom domain on zone `odell.io`) and `CLOUDFLARE_ACCOUNT_ID`:

```bash
chmod +x deploy-build.sh
./deploy-build.sh
```

The script:

1. Bundles with `wrangler deploy --dry-run --outdir dist` (no upload in that step).
2. Refuses to continue if any required Access secret name is missing on the Worker. It lists names only.
3. Uploads a version with `CREDS`, `OAUTH_KV`, `MCP_RESOURCE`, and `OWNER_EMAIL`, and keeps existing `secret_text` bindings (so `RESY_EMAIL`, `RESY_PASSWORD`, and `RESY_AUTH_TOKEN` stay).
4. Deploys that version to 100%.
5. Sets the `* * * * *` cron, Workers logs, and traces.
6. Attaches the custom domain `restaurant-mcp.odell.io` on zone `odell.io` if it is not already attached. Wrangler uses the same hostname with `custom_domain: true`, which creates the proxied DNS record on deploy.
7. Turns off the `workers.dev` subdomain (`workers_dev` is false) so the only public origin is the custom domain.
8. Deletes the `MCP_TOKEN` secret when it is still present.

`./deploy-build.sh --build-only` prints the bundle and binding names and does not call the API.

`npx wrangler deploy` is the other path. It reads the same `wrangler.jsonc` (custom domain, both KV bindings, observability, required secrets). After a Wrangler deploy, delete the old token if it is still listed:

```bash
npx wrangler secret delete MCP_TOKEN
```

`.github/workflows/deploy.yml` still runs `wrangler deploy` on pushes to `master`. It fails closed until the Access secrets exist on the Worker. It does not set secrets.

### 6. Connect a client

Use the MCP URL `https://restaurant-mcp.odell.io/mcp`. The client discovers the authorization server, registers at `/register`, and opens a browser. Approve the client, then complete the Access one-time PIN as `austin@odell.io`.

Cursor, a remote MCP entry:

```json
{
  "mcpServers": {
    "restaurant-reservations": {
      "url": "https://restaurant-mcp.odell.io/mcp"
    }
  }
}
```

Clients that cannot do OAuth themselves can use `npx mcp-remote https://restaurant-mcp.odell.io/mcp`.

## Features

- **Unified Search**: Search both Resy and OpenTable with a single query
- **Real-time Availability**: Check available time slots for any date
- **Direct Booking**: Book Resy reservations directly; get booking links for OpenTable
- **Reservation Sniper**: Auto-book the instant slots become available
- **Secure Credentials**: API keys and snipe jobs live in the `CREDS` KV namespace. Resy email and password are Worker secrets (`RESY_EMAIL`, `RESY_PASSWORD`)

## Getting Started

### 1. Set Up Resy Credentials

The Resy API key can be stored in KV. Email and password are Worker secrets:

```
set_credentials(platform: "resy", api_key: "YOUR_API_KEY")

# npx wrangler secret put RESY_EMAIL
# npx wrangler secret put RESY_PASSWORD
```

### 2. Search for Restaurants

```
search_restaurants(query: "Carbone", location: "New York", party_size: 2)
```

**You don't need to know which platform a restaurant uses.** The search checks Resy and OpenTable. Each result includes a `platform` field (`resy` or `opentable`) and an ID like `resy-12345` or `opentable-67890`.

### 3. Check Availability

```
check_availability(restaurant_id: "resy-12345", date: "2025-02-15", party_size: 2)
```

### 4. Book a Reservation

```
make_reservation(
  restaurant_id: "resy-12345",
  slot_id: "123456",
  party_size: 2,
  date: "2025-02-15"
)
```

## Reservation Sniper

For popular restaurants that release reservations at specific times:

```
snipe_reservation(
  restaurant_id: "resy-12345",
  platform: "resy",
  date: "2025-02-15",
  party_size: 2,
  preferred_times: ["7:00 PM", "7:30 PM", "8:00 PM"],
  release_time: "2025-02-01T09:00:00"
)
```

The sniper will:

1. Start polling 30 seconds before release time
2. Poll every 500ms once release time hits
3. Instantly book the first matching slot
4. Return confirmation or error

A cron trigger (`* * * * *`) runs due snipes. That trigger does not use the MCP OAuth token.

## Available Tools

| Tool | Description |
|------|-------------|
| `find_table` | Find and book a table |
| `search_restaurant` | Search Resy, OpenTable, and SevenRooms. Tock only returns saved venues |
| `get_restaurant` | Look up one restaurant by id |
| `get_restaurants` | Look up several restaurants by id |
| `add_tock_venue` | Store a Tock slug and business id for availability |
| `check_availability` | Get available time slots for a restaurant |
| `make_reservation` | Book a reservation |
| `get_booking_options` | List ways to book a restaurant |
| `list_reservations` | View your upcoming reservations |
| `cancel_reservation` | Cancel a booking |
| `set_credentials` | Store API key/token securely |
| `set_login` | Refuses to store a password; tells you to set `RESY_EMAIL` / `RESY_PASSWORD` |
| `check_auth_status` | Verify credentials and whether Resy Worker secrets are set |
| `refresh_token` | Manually refresh auth token |
| `snipe_reservation` | Schedule auto-booking when slots open |
| `list_snipes` | View scheduled snipes |
| `cancel_snipe` | Cancel a scheduled snipe |
| `get_platform_status` | Platform health, rate limits, and cache stats |

## Security

- **No credit card data**: This MCP never handles payment info. Bookings use payment methods saved in your Resy/OpenTable accounts.
- **KV credentials**: API keys and cached Resy auth tokens live in the `CREDS` KV namespace. Resy email and password do not
- **Resy login secrets**: `RESY_EMAIL` and `RESY_PASSWORD` (optional `RESY_AUTH_TOKEN`) are Worker secrets and override KV
- **Access OAuth**: `/mcp` accepts only tokens this Worker issues after Cloudflare Access login. `MCP_TOKEN` is not read
- **Owner only**: the Access policy includes only `austin@odell.io`, and the Worker rejects any other verified email
- **HTTPS only**: The public hostname is `restaurant-mcp.odell.io`
- **Rate limited**: Max 10 requests/minute per platform

## Platform Notes

### Resy
- Full booking support via unofficial API
- Search is geocoded and limited with `geo.radius` in meters
- Upcoming reservations come from `GET /3/user/reservations?type=upcoming` and include `resy_token`
- Cancel is `POST /3/cancel` with that `resy_token` (a numeric reservation id is looked up first)
- Automatic token refresh when expired

### OpenTable
- Search reads the public results page (`/s?term=`) without auth and includes a booking link
- If Cloudflare answers with a 403 or challenge, search reports that it was blocked
- Availability is unchanged
- **Cannot complete booking via API** - returns a URL to finish on OpenTable's website

### SevenRooms
- Availability uses the public widget range API
- Search resolves a name only when it matches a venue URL key such as `rezdora` or `nobu`
- Booking returns `https://www.sevenrooms.com/reservations/<slug>`

### Tock
- Availability is `POST /api/consumer/calendar/full/v2` with an `x-tock-scope` business id
- Public pages are often challenged, so save `slug` + `business_id` with `add_tock_venue` when a slug cannot be resolved
- There is no public directory search; search only returns venues saved in KV
- Booking stays a link

## Troubleshooting

### "Resy API key not configured"
Run `set_credentials` with your API key first.

### "Resy authentication failed"
The auth token expired and login could not refresh it. Set `RESY_EMAIL` and `RESY_PASSWORD` with `wrangler secret put`. `check_auth_status` shows whether those secrets are present.

### OpenTable booking returns URL
This is expected. OpenTable doesn't allow third-party booking - click the URL to complete on their site.

### MCP client stays unauthorized
Confirm the SaaS redirect URL is exactly `https://restaurant-mcp.odell.io/callback`, the six Access secrets are set, and the signed-in email is `austin@odell.io`. A static `Authorization: Bearer` value from the old `MCP_TOKEN` is rejected.

## Limitations

- Uses unofficial APIs that could change
- OpenTable requires manual booking completion
- For personal use only
