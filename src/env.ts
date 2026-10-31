import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";

/** Bindings come from `src/cloudflare-bindings.d.ts` (`wrangler types`). */
export interface Env extends CloudflareBindings {
  OAUTH_PROVIDER?: OAuthHelpers;
  [k: string]: unknown;
}

let _env: Env | null = null;
export function setEnv(e: Env) { _env = e; }
export function getEnv(): Env { if (!_env) throw new Error("env not set"); return _env; }
