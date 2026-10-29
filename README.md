# Restaurant Reservation MCP Server

A remote MCP server for searching and booking restaurant reservations through Resy and OpenTable. It runs as a Cloudflare Worker. Clients call `POST /mcp` with `Authorization: Bearer <MCP_TOKEN>`.

## Deploying on Cloudflare

### Workers Builds

Connect this repo in Cloudflare Workers Builds with:

- Root directory: `/`
- Build command: `npm install`
- Deploy command: `npx wrangler deploy`

`wrangler.jsonc` binds the `CREDS` KV namespace used for Resy/OpenTable credentials and snipe jobs. Do not commit secrets.

Set the Worker secret `MCP_TOKEN` in the dashboard, or locally with:

```bash
npx wrangler secret put MCP_TOKEN
```

That value is the bearer token clients send. The deploy workflow does not set it.

Resy login comes from Worker secrets, not KV. The worker reads `RESY_EMAIL` and `RESY_PASSWORD` (and optional `RESY_AUTH_TOKEN`) from the environment and prefers them over anything in KV. Email and password are never written to KV. A short-lived auth token from login or refresh may be cached in KV; if `RESY_AUTH_TOKEN` is set, that secret is used instead.

```bash
npx wrangler secret put RESY_EMAIL
npx wrangler secret put RESY_PASSWORD
npx wrangler secret put RESY_AUTH_TOKEN   # optional
```

`set_login` does not store a password. It tells you to set those secrets. `check_auth_status` reports whether `RESY_EMAIL`, `RESY_PASSWORD`, and `RESY_AUTH_TOKEN` are present.

### GitHub Actions

`.github/workflows/deploy.yml` deploys on every push to `master` and when run manually (`workflow_dispatch`). Add these repository secrets (Settings → Secrets and variables → Actions):

- `CLOUDFLARE_API_TOKEN` — API token with permission to deploy Workers
- `CLOUDFLARE_ACCOUNT_ID` — Cloudflare account ID

`MCP_TOKEN` stays a Worker secret. It is not a GitHub Actions secret.

## Features

- **Unified Search**: Search both Resy and OpenTable with a single query
- **Real-time Availability**: Check available time slots for any date
- **Direct Booking**: Book Resy reservations directly; get booking links for OpenTable
- **Reservation Sniper**: Auto-book the instant slots become available
- **Secure Credentials**: API keys and snipe jobs live in the `CREDS` KV namespace. Resy email and password are Worker secrets (`RESY_EMAIL`, `RESY_PASSWORD`)

## Installation

```bash
cd C:\Users\jrkle\Desktop\restaurant-mcp
npm install
npm run build
```

## Configure Claude Code

Add to `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "restaurant-reservations": {
      "command": "node",
      "args": ["C:\\Users\\jrkle\\Desktop\\restaurant-mcp\\dist\\index.js"]
    }
  }
}
```

## Getting Started

### 1. Set Up Resy Credentials

First, you need your Resy API key and auth token. You can find these in your browser's developer tools while logged into resy.com:

```
# API key can be stored in KV:
set_credentials(platform: "resy", api_key: "YOUR_API_KEY")

# Email and password are Worker secrets, not tool arguments:
# npx wrangler secret put RESY_EMAIL
# npx wrangler secret put RESY_PASSWORD
```

### 2. Search for Restaurants

```
search_restaurants(query: "Carbone", location: "New York", party_size: 2)
```

**You don't need to know which platform a restaurant uses!** The search automatically checks both Resy and OpenTable in parallel. Each result includes a `platform` field (`resy` or `opentable`) and an ID like `resy-12345` or `opentable-67890` - just use these directly with `check_availability` and `make_reservation`.

### 3. Check Availability

```
check_availability(restaurant_id: "resy-12345", platform: "resy", date: "2025-02-15", party_size: 2)
```

### 4. Book a Reservation

```
make_reservation(
  restaurant_id: "resy-12345",
  platform: "resy",
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

## Available Tools

| Tool | Description |
|------|-------------|
| `search_restaurants` | Search restaurants by name/location on Resy and/or OpenTable |
| `check_availability` | Get available time slots for a restaurant |
| `make_reservation` | Book a reservation |
| `list_reservations` | View your upcoming reservations |
| `cancel_reservation` | Cancel a booking |
| `set_credentials` | Store API key/token securely |
| `set_login` | Refuses to store a password; tells you to set `RESY_EMAIL` / `RESY_PASSWORD` |
| `check_auth_status` | Verify credentials and whether Resy Worker secrets are set |
| `refresh_token` | Manually refresh auth token |
| `snipe_reservation` | Schedule auto-booking when slots open |
| `list_snipes` | View scheduled snipes |
| `cancel_snipe` | Cancel a scheduled snipe |

## Security

- **No credit card data**: This MCP never handles payment info. Bookings use payment methods saved in your Resy/OpenTable accounts.
- **KV credentials**: API keys and cached Resy auth tokens live in the `CREDS` KV namespace. Resy email and password do not
- **Resy login secrets**: `RESY_EMAIL` and `RESY_PASSWORD` (optional `RESY_AUTH_TOKEN`) are Worker secrets and override KV
- **Bearer auth**: `/mcp` requires `Authorization: Bearer <MCP_TOKEN>`
- **HTTPS only**: All API calls use TLS
- **Rate limited**: Max 10 requests/minute per platform

## Platform Notes

### Resy
- Full booking support via unofficial API
- Automatic token refresh when expired
- Can view and cancel reservations

### OpenTable
- Search and availability work without auth
- **Cannot complete booking via API** - returns a URL to finish on OpenTable's website
- Reservation listing not available

## Troubleshooting

### "Resy API key not configured"
Run `set_credentials` with your API key first.

### "Resy authentication failed"
The auth token expired and login could not refresh it. Set `RESY_EMAIL` and `RESY_PASSWORD` with `wrangler secret put`. `check_auth_status` shows whether those secrets are present.

### OpenTable booking returns URL
This is expected. OpenTable doesn't allow third-party booking - click the URL to complete on their site.

## Limitations

- Uses unofficial APIs that could change
- OpenTable requires manual booking completion
- For personal use only
