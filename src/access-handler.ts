import {
  AuthorizationError,
  authorizationErrorRedirect,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";

import type { Env } from "./env.js";
import { identityAllowed } from "./owner-identity.js";

type OauthEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const ACCESS_SCOPE = "openid email profile";
const CLOCK_SKEW_SECONDS = 60;
const JWKS_CACHE_MS = 10 * 60 * 1000;

const REQUIRED_CONFIG = [
  "ACCESS_CLIENT_ID",
  "ACCESS_CLIENT_SECRET",
  "ACCESS_TOKEN_URL",
  "ACCESS_AUTHORIZATION_URL",
  "ACCESS_JWKS_URL",
  "COOKIE_ENCRYPTION_KEY",
  "OWNER_EMAIL",
] as const;

interface IdClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  sub?: string;
  email?: string;
  name?: string;
}

interface JwksCache {
  url: string;
  fetchedAt: number;
  keys: Array<JsonWebKey & { kid?: string }>;
}

let jwksCache: JwksCache | null = null;

function log(message: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ message, ...fields }));
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function missingConfig(env: Env): string[] {
  return REQUIRED_CONFIG.filter((name) => {
    const value = env[name];
    if (typeof value !== "string" || value.trim().length === 0) return true;
    if (name === "COOKIE_ENCRYPTION_KEY" && value.length < 32) return true;
    return false;
  });
}

function configError(env: Env): Response | null {
  const missing = missingConfig(env);
  if (missing.length === 0) return null;
  log("access oauth is not configured", { missing });
  return new Response("Access OAuth is not configured", { status: 500 });
}

function oauthEnv(env: Env): OauthEnv | Response {
  const missing = configError(env);
  if (missing) return missing;
  if (!env.OAUTH_PROVIDER) {
    log("oauth provider binding missing");
    return new Response("OAuth provider is unavailable", { status: 500 });
  }
  return env as OauthEnv;
}

function callbackUrl(request: Request): string {
  return new URL("/callback", request.url).href;
}

async function generatePkce(): Promise<{ codeVerifier: string; codeChallenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const codeVerifier = base64Url(bytes);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  const codeChallenge = base64Url(new Uint8Array(digest));
  return { codeVerifier, codeChallenge };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function accessAuthorizeUrl(env: Env, state: string, codeChallenge: string, redirectUri: string): string {
  const url = new URL(env.ACCESS_AUTHORIZATION_URL);
  url.searchParams.set("client_id", env.ACCESS_CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ACCESS_SCOPE);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function redirectToAccess(
  request: Request,
  env: OauthEnv,
  authRequest: AuthRequest,
  extraHeaders?: Headers,
): Promise<Response> {
  const { codeVerifier, codeChallenge } = await generatePkce();
  const upstream = await env.OAUTH_PROVIDER.beginUpstream(authRequest, {
    data: { codeVerifier },
    headers: extraHeaders,
  });
  upstream.headers.set(
    "Location",
    accessAuthorizeUrl(env, upstream.state, codeChallenge, callbackUrl(request)),
  );
  return new Response(null, { status: 302, headers: upstream.headers });
}

function consentPage(
  details: {
    clientName: string;
    clientDomain?: string;
    redirectHost: string;
    redirectIsLoopback: boolean;
    scope: string[];
  },
  handle: string,
): string {
  const name = escapeHtml(details.clientName);
  const host = escapeHtml(details.redirectHost);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself; its name is not verified.";
  const scopes = details.scope
    .map((scope) => `<li>${escapeHtml(scope)}</li>`)
    .join("");
  const loopback = details.redirectIsLoopback
    ? "<p><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</p>"
    : "";
  return `<!doctype html>
<meta charset="utf-8">
<title>Authorize ${name}</title>
<h1>Allow ${name} to use restaurant reservations?</h1>
<p>${origin} Access will be sent to <strong>${host}</strong>.</p>
${loopback}
${scopes ? `<p>Requested scopes:</p><ul>${scopes}</ul>` : ""}
<p>Cloudflare Access will then ask you to sign in. Only the account owner is allowed.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <p>
    <button name="decision" value="approve">Allow</button>
    <button name="decision" value="deny">Deny</button>
  </p>
</form>`;
}

async function authorizeGet(request: Request, env: OauthEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  const authRequest = await oauth.parseAuthRequest(request);
  const details = await oauth.describeConsent(authRequest);
  if (await oauth.isConsentRemembered(request, authRequest, { secret: env.COOKIE_ENCRYPTION_KEY })) {
    return redirectToAccess(request, env, authRequest);
  }
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  return new Response(consentPage(details, consent.handle), { headers: consent.headers });
}

async function authorizePost(request: Request, env: OauthEnv): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  if (form.get("decision") !== "approve") {
    const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
    return new Response(null, { status: 302, headers: denied.headers });
  }
  const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle, {
    remember: { secret: env.COOKIE_ENCRYPTION_KEY },
  });
  return redirectToAccess(request, env, approved.request, approved.headers);
}

async function exchangeCode(
  env: Env,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<{ accessToken: string; idToken: string } | Response> {
  const body = new URLSearchParams({
    client_id: env.ACCESS_CLIENT_ID,
    client_secret: env.ACCESS_CLIENT_SECRET,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  });
  const response = await fetch(env.ACCESS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (!response.ok) {
    log("access token exchange failed", { status: response.status });
    return new Response("Access login could not be verified", { status: 401 });
  }
  const payload = (await response.json()) as { access_token?: string; id_token?: string };
  if (!payload.access_token || !payload.id_token) {
    log("access token exchange missing tokens");
    return new Response("Access login could not be verified", { status: 401 });
  }
  return { accessToken: payload.access_token, idToken: payload.id_token };
}

function decodeSegment(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((segment.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function fetchJwks(env: Env, force: boolean): Promise<Array<JsonWebKey & { kid?: string }>> {
  const url = env.ACCESS_JWKS_URL;
  const now = Date.now();
  if (!force && jwksCache && jwksCache.url === url && now - jwksCache.fetchedAt < JWKS_CACHE_MS) {
    return jwksCache.keys;
  }
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    log("access jwks fetch failed", { status: response.status });
    throw new Error("jwks fetch failed");
  }
  const body = (await response.json()) as { keys?: Array<JsonWebKey & { kid?: string }> };
  const keys = body.keys ?? [];
  jwksCache = { url, fetchedAt: now, keys };
  return keys;
}

async function verifyIdToken(env: Env, token: string): Promise<IdClaims> {
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("malformed id token");
  }
  const header = JSON.parse(new TextDecoder().decode(decodeSegment(parts[0]))) as { alg?: string; kid?: string };
  if (header.alg !== "RS256" || !header.kid) throw new Error("unsupported id token");
  let keys = await fetchJwks(env, false);
  let jwk = keys.find((key) => key.kid === header.kid);
  if (!jwk) {
    keys = await fetchJwks(env, true);
    jwk = keys.find((key) => key.kid === header.kid);
  }
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
  if (!valid) throw new Error("id token signature rejected");
  const claims = JSON.parse(new TextDecoder().decode(decodeSegment(parts[1]))) as IdClaims;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || claims.exp + CLOCK_SKEW_SECONDS < now) throw new Error("id token expired");
  if (typeof claims.nbf === "number" && claims.nbf - CLOCK_SKEW_SECONDS > now) throw new Error("id token not yet valid");
  let issuer: string;
  try {
    issuer = new URL(env.ACCESS_JWKS_URL).origin;
  } catch {
    throw new Error("access jwks url is invalid");
  }
  if (!claims.iss || new URL(claims.iss).origin !== issuer) throw new Error("id token issuer rejected");
  const audiences = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!audiences.includes(env.ACCESS_CLIENT_ID)) throw new Error("id token audience rejected");
  return claims;
}

async function callback(request: Request, env: OauthEnv): Promise<Response> {
  const resumed = await env.OAUTH_PROVIDER.finishUpstream<{ codeVerifier?: string }>(request);
  const params = new URL(request.url).searchParams;
  if (params.get("error")) {
    log("access authorization denied", { error: params.get("error") });
    resumed.headers.set("Location", authorizationErrorRedirect(resumed.request, "access_denied"));
    return new Response(null, { status: 302, headers: resumed.headers });
  }
  const code = params.get("code");
  const codeVerifier = resumed.data?.codeVerifier;
  if (!code || !codeVerifier) {
    log("access callback missing code");
    return new Response("Access login could not be verified", { status: 401 });
  }
  const exchanged = await exchangeCode(env, code, callbackUrl(request), codeVerifier);
  if (exchanged instanceof Response) return exchanged;
  let claims: IdClaims;
  try {
    claims = await verifyIdToken(env, exchanged.idToken);
  } catch (error) {
    log("access id token rejected", { reason: error instanceof Error ? error.message : "unknown" });
    return new Response("Access login could not be verified", { status: 401 });
  }
  if (!identityAllowed(claims.email, env.OWNER_EMAIL) || !claims.sub) {
    log("access identity rejected");
    return new Response("This server only allows the account owner.", { status: 403 });
  }
  const userId = encodeURIComponent(claims.sub);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: resumed.request,
    userId,
    metadata: { label: claims.email },
    scope: resumed.request.scope,
    props: {
      email: claims.email,
      name: claims.name ?? claims.email,
      sub: claims.sub,
    },
  });
  resumed.headers.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: resumed.headers });
}

function authorizationFailure(error: unknown): Response {
  if (error instanceof AuthorizationError) {
    log("oauth authorization failed", { code: error.code });
    if (error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return new Response(error.description, { status: 400 });
  }
  log("oauth request failed", { reason: error instanceof Error ? error.message : "unknown" });
  return new Response("Authorization failed", { status: 500 });
}

/** Consent page and Cloudflare Access OIDC callback. OAuthProvider routes /mcp itself. */
export async function handleAccessRequest(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return Response.json({ status: "ok", service: "restaurant-mcp", version: "2.0.0-workers" });
  }
  const ready = oauthEnv(env);
  if (ready instanceof Response) return ready;
  try {
    if (request.method === "GET" && url.pathname === "/authorize") return await authorizeGet(request, ready);
    if (request.method === "POST" && url.pathname === "/authorize") return await authorizePost(request, ready);
    if (request.method === "GET" && url.pathname === "/callback") return await callback(request, ready);
  } catch (error) {
    return authorizationFailure(error);
  }
  return new Response("Not found", { status: 404 });
}
