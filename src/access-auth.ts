import type { Env } from "./env.js";

/**
 * Cloudflare Access sits in front of restaurant-mcp.odell.io (a self-hosted Access
 * application with Managed OAuth). Access authenticates the caller and forwards the
 * request with a signed `Cf-Access-Jwt-Assertion` JWT. The Worker never trusts the
 * request on its own: it verifies that JWT's signature, issuer, audience and expiry on
 * every call, so a request that reaches the Worker by any path other than that Access
 * application is rejected.
 *
 * Who may connect is decided by the Access policy, not by this code.
 */

export const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";

const CLOCK_SKEW_SECONDS = 60;
const JWKS_CACHE_MS = 10 * 60 * 1000;

type Jwk = JsonWebKey & { kid?: string };

interface AccessClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  sub?: string;
  email?: string;
  common_name?: string;
}

interface JwksCache {
  url: string;
  fetchedAt: number;
  keys: Jwk[];
}

let jwksCache: JwksCache | null = null;

/** Drop the cached signing keys (used by tests). */
export function resetAccessKeyCache(): void {
  jwksCache = null;
}

export type AccessResult =
  | { ok: true; claims: AccessClaims }
  | { ok: false; status: 401 | 500; reason: string };

function log(message: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ message, ...fields }));
}

function decodeSegment(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((segment.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson<T>(segment: string): T {
  return JSON.parse(new TextDecoder().decode(decodeSegment(segment))) as T;
}

/** `aodell.cloudflareaccess.com` or `https://aodell.cloudflareaccess.com/` → the bare host. */
function teamHost(value: string): string {
  return value.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

async function fetchKeys(url: string, force: boolean): Promise<Jwk[]> {
  const now = Date.now();
  if (!force && jwksCache && jwksCache.url === url && now - jwksCache.fetchedAt < JWKS_CACHE_MS) {
    return jwksCache.keys;
  }
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    log("access certs fetch failed", { status: response.status });
    throw new Error("access certs fetch failed");
  }
  const body = (await response.json()) as { keys?: Jwk[] };
  const keys = body.keys ?? [];
  jwksCache = { url, fetchedAt: now, keys };
  return keys;
}

async function verify(token: string, host: string, audience: string): Promise<AccessClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new Error("malformed token");

  const header = decodeJson<{ alg?: string; kid?: string }>(parts[0]);
  if (header.alg !== "RS256" || !header.kid) throw new Error("unsupported token");

  const certsUrl = `https://${host}/cdn-cgi/access/certs`;
  let jwk = (await fetchKeys(certsUrl, false)).find((key) => key.kid === header.kid);
  if (!jwk) jwk = (await fetchKeys(certsUrl, true)).find((key) => key.kid === header.kid);
  if (!jwk) throw new Error("unknown signing key");

  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    decodeSegment(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) throw new Error("signature rejected");

  const claims = decodeJson<AccessClaims>(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now) throw new Error("token expired");
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now) throw new Error("token not yet valid");
  if (claims.iss !== `https://${host}`) throw new Error("issuer rejected");
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(audience)) throw new Error("audience rejected");
  return claims;
}

/** Verify the Access JWT on a request. Fails closed when the Worker is not configured. */
export async function verifyAccessRequest(request: Request, env: Env): Promise<AccessResult> {
  const host = typeof env.ACCESS_TEAM_DOMAIN === "string" ? teamHost(env.ACCESS_TEAM_DOMAIN) : "";
  const audience = typeof env.ACCESS_AUD === "string" ? env.ACCESS_AUD.trim() : "";
  if (!host || !audience) {
    log("access validation is not configured", { team_domain: Boolean(host), aud: Boolean(audience) });
    return { ok: false, status: 500, reason: "Access validation is not configured" };
  }
  const token = request.headers.get(ACCESS_JWT_HEADER);
  if (!token) return { ok: false, status: 401, reason: "Missing Access token" };
  try {
    return { ok: true, claims: await verify(token, host, audience) };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown";
    log("access token rejected", { reason });
    return { ok: false, status: 401, reason: "Invalid Access token" };
  }
}
