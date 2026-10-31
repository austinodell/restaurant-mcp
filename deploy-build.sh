#!/usr/bin/env bash
# Build restaurant-mcp and upload it through the Cloudflare API.
# Does not print secret values. Refuses to upload until the Access secrets exist.
# Pass --build-only to bundle and print binding names without calling the API.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

BUILD_ONLY=0
if [[ "${1:-}" == "--build-only" ]]; then
  BUILD_ONLY=1
elif [[ $# -gt 0 ]]; then
  echo "usage: ./deploy-build.sh [--build-only]" >&2
  exit 2
fi

if [[ "$BUILD_ONLY" -eq 0 ]]; then
  if [[ -z "${CLOUDFLARE_API_TOKEN:-}" || -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]]; then
    echo "Set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID." >&2
    exit 1
  fi
fi

exec node --input-type=module - "$BUILD_ONLY" <<'EOF'
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const buildOnly = process.argv[2] === "1";
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
const root = process.cwd();

const REQUIRED_SECRETS = [
  "ACCESS_CLIENT_ID",
  "ACCESS_CLIENT_SECRET",
  "ACCESS_TOKEN_URL",
  "ACCESS_AUTHORIZATION_URL",
  "ACCESS_JWKS_URL",
  "COOKIE_ENCRYPTION_KEY",
];
const REMOVED_SECRET = "MCP_TOKEN";

function parseJsonc(file) {
  const text = readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  return JSON.parse(text);
}

const config = parseJsonc(path.join(root, "wrangler.jsonc"));
const scriptName = config.name;
const outdir = path.join(root, "dist");

const build = spawnSync(
  "npx",
  ["wrangler", "deploy", "--dry-run", "--outdir", outdir],
  { cwd: root, stdio: "inherit", env: process.env },
);
if (build.status !== 0) process.exit(build.status ?? 1);

const modules = readdirSync(outdir).filter((name) => name.endsWith(".js"));
if (modules.length !== 1) {
  throw new Error(`expected one bundled module in dist/, found ${modules.join(", ") || "none"}`);
}
const mainModule = modules[0];
const code = readFileSync(path.join(outdir, mainModule));

const bindings = [];
for (const kv of config.kv_namespaces ?? []) {
  bindings.push({ type: "kv_namespace", name: kv.binding, namespace_id: kv.id });
}
for (const [name, text] of Object.entries(config.vars ?? {})) {
  bindings.push({ type: "plain_text", name, text });
}

const metadata = {
  main_module: mainModule,
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags,
  bindings,
  keep_bindings: ["secret_text"],
};

if (buildOnly) {
  console.log(JSON.stringify({
    script: scriptName,
    main_module: mainModule,
    bytes: code.length,
    bindings: bindings.map((binding) => ({ type: binding.type, name: binding.name, namespace_id: binding.namespace_id })),
    keep_bindings: metadata.keep_bindings,
    routes: config.routes,
    observability: config.observability,
    crons: config.triggers?.crons,
    workers_dev: config.workers_dev,
  }, null, 2));
  process.exit(0);
}

const api = "https://api.cloudflare.com/client/v4";
async function cf(method, pathname, { json, form } = {}) {
  const headers = { Authorization: `Bearer ${token}` };
  let body;
  if (json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(json);
  } else if (form) {
    body = form;
  }
  const response = await fetch(`${api}${pathname}`, { method, headers, body });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) {
    const detail = (payload.errors ?? []).map((error) => error.message).join("; ") || response.statusText;
    throw new Error(`${method} ${pathname} failed (${response.status}): ${detail}`);
  }
  return payload.result;
}

const secretNames = (await cf("GET", `/accounts/${accountId}/workers/scripts/${scriptName}/secrets`)).map((secret) => secret.name);
const missing = REQUIRED_SECRETS.filter((name) => !secretNames.includes(name));
if (missing.length > 0) {
  console.error(`Missing Worker secrets: ${missing.join(", ")}`);
  console.error("Put them with wrangler secret put before deploying. This script does not read secret values.");
  process.exit(1);
}

const form = new FormData();
form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }), "metadata.json");
form.append(mainModule, new Blob([code], { type: "application/javascript+module" }), mainModule);
const version = await cf("POST", `/accounts/${accountId}/workers/scripts/${scriptName}/versions`, { form });
const versionId = version?.id;
if (!versionId) throw new Error("Upload did not return a version id");
await cf("POST", `/accounts/${accountId}/workers/scripts/${scriptName}/deployments`, {
  json: {
    strategy: "percentage",
    annotations: { "workers/message": "Deploy Access OAuth build" },
    versions: [{ version_id: versionId, percentage: 100 }],
  },
});

const crons = config.triggers?.crons ?? [];
await cf("PUT", `/accounts/${accountId}/workers/scripts/${scriptName}/schedules`, {
  json: crons.map((cron) => ({ cron })),
});

const settings = new FormData();
settings.append(
  "settings",
  new Blob([JSON.stringify({ observability: config.observability })], { type: "application/json" }),
  "settings.json",
);
await cf("PATCH", `/accounts/${accountId}/workers/scripts/${scriptName}/settings`, { form: settings });

const hostname = "restaurant-mcp.odell.io";
const domains = await cf("GET", `/accounts/${accountId}/workers/domains`);
const domainList = Array.isArray(domains) ? domains : [];
const attached = domainList.some((domain) => domain.hostname === hostname && domain.service === scriptName);
if (!attached) {
  const zones = await cf("GET", `/zones?name=odell.io`);
  const zone = (Array.isArray(zones) ? zones : [])[0];
  if (!zone) throw new Error("zone odell.io was not found on this account");
  await cf("PUT", `/accounts/${accountId}/workers/domains`, {
    json: { hostname, service: scriptName, zone_id: zone.id, enabled: true },
  });
}

if (config.workers_dev === false) {
  const subdomain = await fetch(`${api}/accounts/${accountId}/workers/scripts/${scriptName}/subdomain`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!subdomain.ok && subdomain.status !== 404) {
    const payload = await subdomain.json().catch(() => ({}));
    const detail = (payload.errors ?? []).map((error) => error.message).join("; ") || subdomain.statusText;
    throw new Error(`DELETE workers.dev subdomain failed (${subdomain.status}): ${detail}`);
  }
}

if (secretNames.includes(REMOVED_SECRET)) {
  await cf("DELETE", `/accounts/${accountId}/workers/scripts/${scriptName}/secrets/${REMOVED_SECRET}`);
  console.log(`Removed Worker secret ${REMOVED_SECRET}`);
}

console.log(`Deployed ${scriptName} version ${versionId} to https://${hostname}/mcp`);
EOF
