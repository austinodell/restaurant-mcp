# Restaurant Reservation MCP Server

A remote MCP server for searching and booking restaurant reservations. It runs as a Cloudflare Worker at `https://restaurant-mcp.odell.io/mcp`.

Authentication is handled by Cloudflare Access, not by this Worker. `restaurant-mcp.odell.io` is a **self-hosted Access application with Managed OAuth** enabled. Access runs the OAuth flow with MCP clients (discovery, dynamic client registration, login), then forwards each request to the Worker with a signed `Cf-Access-Jwt-Assertion` JWT. The Worker verifies that JWT on every `/mcp` request (RS256 signature against the team's keys, issuer, audience and expiry) and answers `401` otherwise, so it never serves a request that did not come through the Access application. There is no static bearer token, no `MCP_TOKEN` fallback, and no OAuth server in this code.

Who may connect is decided only by the Access policy (see below), so adding a login method or another email never needs a deploy.

- `POST /mcp`: requires a valid Access JWT
- `GET /health`: public, returns status and version (Access still gates it at the edge unless you add a Bypass rule for that path)
- The once-a-minute snipe cron does not go through HTTP or Access

The same hostname can also be added to a Cloudflare MCP Server Portal.

## Zero Trust setup

Do this in the Cloudflare account that owns the `odell.io` zone (Zero Trust team `aodell.cloudflareaccess.com`) **before merging**, because the deploy requires the `ACCESS_AUD` secret.

### 1. Self-hosted Access application

1. [Zero Trust](https://one.dash.cloudflare.com/) → **Access controls** → **Applications** → **Add an application** → **Self-hosted**.
2. Name `restaurant-mcp`. Public hostname `restaurant-mcp.odell.io`, no path (the whole host).
3. Enable **Managed OAuth** on the application so MCP clients get the OAuth discovery flow.
4. Add one **Allow** policy with an Include rule for the emails that may connect (currently `austin@odell.io` and `austintodell@gmail.com`). No Bypass and no Everyone rules.
5. Copy the application's **Audience (AUD) tag**.

### 2. Worker configuration

`wrangler.jsonc` sets `ACCESS_TEAM_DOMAIN` (`aodell.cloudflareaccess.com`). Put the AUD tag in as a secret; `wrangler deploy` stops if it is missing:

```bash
npx wrangler secret put ACCESS_AUD
```

Upstream Resy login stays in Worker secrets and is never written to KV:

```bash
npx wrangler secret put RESY_EMAIL
npx wrangler secret put RESY_PASSWORD
npx wrangler secret put RESY_AUTH_TOKEN   # optional
```

`CREDS` (`restaurant-mcp-creds`, `7d05dafe369446c29cdd0cd61bf6b60e`) holds API keys, cached Resy tokens, saved Tock venues, and snipe jobs.

For local `wrangler dev`, copy `.dev.vars.example` to `.dev.vars`. Requests must still carry an Access-issued JWT, so test authenticated calls against the deployed hostname.

### 3. Deploy

This repo deploys from GitHub Actions on every push to `master` (see Releases). Deploying by hand:

```bash
npx wrangler deploy
```

or, through the Cloudflare API with `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` set (the script also refuses to upload if `ACCESS_AUD` is missing):

```bash
chmod +x deploy-build.sh
./deploy-build.sh
```

`./deploy-build.sh --build-only` prints the bundle and binding names and does not call the API.

#### Migrating from the old Worker-side OAuth

Earlier versions ran their own OAuth server (`workers-oauth-provider`) with an Access for SaaS OIDC app. After this version is live and a client connects successfully, these are unused and can be removed: the Access for SaaS application, the Worker secrets `ACCESS_CLIENT_ID`, `ACCESS_CLIENT_SECRET`, `ACCESS_TOKEN_URL`, `ACCESS_AUTHORIZATION_URL`, `ACCESS_JWKS_URL`, `COOKIE_ENCRYPTION_KEY`, the `OWNER_EMAIL` var, and the `OAUTH_KV` namespace (`restaurant-mcp-oauth`). MCP clients must reconnect once, since tokens issued by the old server are no longer accepted.

### 4. Connect a client

Use the MCP URL `https://restaurant-mcp.odell.io/mcp`. The client discovers Access' OAuth endpoints, registers itself, and opens a browser to sign in through Access.

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

A cron trigger (`* * * * *`) runs due snipes. That trigger does not go through Access.

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
| `get_server_info` | Running version and when that Worker version was deployed |

## Releases

Releasing is automatic, using [semantic-release](https://semantic-release.gitbook.io) and [Conventional Commits](https://www.conventionalcommits.org) (config in `.releaserc.json`), the same as `imessage-mcp`. Pull requests run **Test**. On each push to `master`, **Deploy Worker** runs the tests, then semantic-release reads the commits since the latest `vX.Y.Z` tag:

| Commit | Release |
|---|---|
| `feat: …` | minor |
| `fix: …`, `perf: …`, `revert: …`, `deps: …` | patch |
| `feat!: …` (any type with `!`), or `BREAKING CHANGE:` in the body | major |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:`, anything else | none |

A release creates the `vX.Y.Z` tag and a GitHub Release with notes grouped by type. The Worker deploys on every push either way, with `git describe` passed as `APP_VERSION` (`2.1.0` right after a release, `2.1.0-3-gabc1234` for unreleased commits). `deploy-build.sh` sends the same value. `/health`, the MCP handshake and `get_server_info` report it. Nothing is committed to `master`; the committed `package.json` version stays `0.0.0-development` and the tags are the source of truth. **Give PRs a Conventional title**, such as `feat: add get_server_info`. A squash merge uses the title as the commit message, and for a "Merge pull request #N" commit semantic-release reads the title on the line after it.

## Security

- **No credit card data**: This MCP never handles payment info. Bookings use payment methods saved in your Resy/OpenTable accounts.
- **KV credentials**: API keys and cached Resy auth tokens live in the `CREDS` KV namespace. Resy email and password do not
- **Resy login secrets**: `RESY_EMAIL` and `RESY_PASSWORD` (optional `RESY_AUTH_TOKEN`) are Worker secrets and override KV
- **Cloudflare Access**: `/mcp` requires a valid `Cf-Access-Jwt-Assertion` (signature, issuer, audience, expiry), so only requests that passed the Access application are served. `MCP_TOKEN` is not read
- **Allow-list in Access**: only the emails in the Access policy can sign in
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
- Availability uses native Worker `fetch`: `POST /api/consumer/calendar/full/v2`, an empty binary body, `application/octet-stream`, and `X-Tock-Stream-Format: proto2`. The protobuf calendar is decoded and filtered by local date, party-size limits, ticket capacity, and experience.
- Venue HTML supplies the business ID, anonymous JWT, and build number. JWTs stay in request memory; they are never saved to KV or logged. This uses a private, undocumented website API, not the official business data API.
- Public pages may be challenged. Save `slug` + `business_id` with `add_tock_venue` to allow a calendar attempt even if page bootstrap fails. A saved ID does not guarantee the calendar will accept an anonymous request.
- Cloudflare challenges, HTTP errors, and unexpected protobuf/HTML responses fail explicitly; they are not reported as no availability. No browser, native executable, or external proxy is used.
- Search only returns venues saved in KV; this experiment does not add a directory search.
- Tock checkout remains a website handoff. `make_reservation` returns `success: false` with the booking URL and explains that no reservation was made. `check_auth_status` reports Tock as unauthenticated.
- Protocol research: [table-reservation-goat calendar client](https://github.com/mvanhorn/printing-press-library/blob/main/library/food-and-dining/table-reservation-goat/internal/source/tock/calendar.go). The Worker decoder is implemented locally without adding that native client as a dependency.

After deployment, run `check_availability` for a known `tock-<slug>` and a future date. If bootstrap is challenged, save its known business ID using `add_tock_venue` and repeat. A challenge at the calendar endpoint confirms the remaining network-access limitation; revert this PR if the experiment is unsuccessful. Tests cover protocol fixtures and mocked fetches, not live Worker-to-Tock access.

## Troubleshooting

### "Resy API key not configured"
Run `set_credentials` with your API key first.

### "Resy authentication failed"
The auth token expired and login could not refresh it. Set `RESY_EMAIL` and `RESY_PASSWORD` with `wrangler secret put`. `check_auth_status` shows whether those secrets are present.

### OpenTable booking returns URL
This is expected. OpenTable doesn't allow third-party booking - click the URL to complete on their site.

### MCP client stays unauthorized
Check that the Access application has Managed OAuth enabled and your email in its Allow policy, that `ACCESS_AUD` matches the application's AUD tag, and that `ACCESS_TEAM_DOMAIN` is the team domain. The Worker logs the reason for each rejected token (`access token rejected`) without logging the token.

## Limitations

- Uses unofficial APIs that could change
- OpenTable requires manual booking completion
- For personal use only

