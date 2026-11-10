import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
const out = mkdtempSync(path.join(repoRoot, 'dist', 'access-'));
execFileSync(
  'npx',
  ['--no-install', 'tsc', '--outDir', out, '--declaration', 'false', '--sourceMap', 'false', '--pretty', 'false'],
  { cwd: repoRoot, stdio: 'inherit' },
);

const base = pathToFileURL(out).href;
const { verifyAccessRequest, resetAccessKeyCache } = await import(`${base}/access-auth.js`);

const TEAM = 'aodell.cloudflareaccess.com';
const AUD = 'test-aud-tag';
const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

async function makeKey(kid) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  );
  const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { privateKey: pair.privateKey, jwk, kid };
}

async function sign(key, claims, header = {}) {
  const head = b64({ alg: 'RS256', kid: key.kid, typ: 'JWT', ...header });
  const body = b64(claims);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(sig).toString('base64url')}`;
}

const now = () => Math.floor(Date.now() / 1000);
const goodClaims = () => ({ iss: `https://${TEAM}`, aud: [AUD], exp: now() + 300, email: 'austin@odell.io', sub: 'user-1' });
const req = (token) => new Request('https://restaurant-mcp.odell.io/mcp', { method: 'POST', headers: token ? { 'Cf-Access-Jwt-Assertion': token } : {} });

const realFetch = globalThis.fetch;
let served = [];
function serveKeys(...keys) {
  served = keys;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), `https://${TEAM}/cdn-cgi/access/certs`);
    return Response.json({ keys: served.map((k) => k.jwk) });
  };
}

test.beforeEach(() => resetAccessKeyCache());
test.after(() => { globalThis.fetch = realFetch; });

test('accepts a valid Access token', async () => {
  const key = await makeKey('k1');
  serveKeys(key);
  const result = await verifyAccessRequest(req(await sign(key, goodClaims())), env);
  assert.equal(result.ok, true);
  assert.equal(result.claims.email, 'austin@odell.io');
});

test('rejects a missing token', async () => {
  const result = await verifyAccessRequest(req(undefined), env);
  assert.deepEqual([result.ok, result.status], [false, 401]);
});

test('rejects a token signed by another key', async () => {
  const trusted = await makeKey('k1');
  const attacker = await makeKey('k1');
  serveKeys(trusted);
  const result = await verifyAccessRequest(req(await sign(attacker, goodClaims())), env);
  assert.deepEqual([result.ok, result.status], [false, 401]);
});

test('rejects wrong audience, wrong issuer, expired, and not-yet-valid tokens', async () => {
  const key = await makeKey('k1');
  serveKeys(key);
  for (const claims of [
    { ...goodClaims(), aud: ['some-other-app'] },
    { ...goodClaims(), iss: 'https://evil.cloudflareaccess.com' },
    { ...goodClaims(), exp: now() - 3600 },
    { ...goodClaims(), nbf: now() + 3600 },
    { ...goodClaims(), exp: undefined },
  ]) {
    const result = await verifyAccessRequest(req(await sign(key, claims)), env);
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  }
});

test('rejects unsigned and non-RS256 tokens', async () => {
  const key = await makeKey('k1');
  serveKeys(key);
  const none = `${b64({ alg: 'none', kid: 'k1' })}.${b64(goodClaims())}.`;
  assert.equal((await verifyAccessRequest(req(none), env)).ok, false);
  const hs = `${b64({ alg: 'HS256', kid: 'k1' })}.${b64(goodClaims())}.${b64('x')}`;
  assert.equal((await verifyAccessRequest(req(hs), env)).ok, false);
  assert.equal((await verifyAccessRequest(req('not-a-jwt'), env)).ok, false);
});

test('refetches keys when Access rotates its signing key', async () => {
  const oldKey = await makeKey('old');
  const newKey = await makeKey('new');
  serveKeys(oldKey);
  assert.equal((await verifyAccessRequest(req(await sign(oldKey, goodClaims())), env)).ok, true);
  serveKeys(oldKey, newKey);
  assert.equal((await verifyAccessRequest(req(await sign(newKey, goodClaims())), env)).ok, true);
});

test('fails closed when the Worker is not configured', async () => {
  const key = await makeKey('k1');
  serveKeys(key);
  const token = await sign(key, goodClaims());
  for (const bad of [{}, { ACCESS_TEAM_DOMAIN: TEAM }, { ACCESS_AUD: AUD }, { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: '  ' }]) {
    const result = await verifyAccessRequest(req(token), bad);
    assert.deepEqual([result.ok, result.status], [false, 500]);
  }
});
