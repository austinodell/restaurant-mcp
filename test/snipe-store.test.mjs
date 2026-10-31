import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
// Emit inside the repo so bare imports (axios, etc.) resolve to node_modules.
mkdirSync(path.join(repoRoot, 'dist'), { recursive: true });
const out = mkdtempSync(path.join(repoRoot, 'dist', 'snipe-'));
execFileSync(
  'npx',
  ['--no-install', 'tsc', '--outDir', out, '--declaration', 'false', '--sourceMap', 'false', '--pretty', 'false'],
  { cwd: repoRoot, stdio: 'inherit' },
);

const base = pathToFileURL(out).href;
const { setEnv } = await import(`${base}/env.js`);
const store = await import(`${base}/sniper/store.js`);
const { PRE_RELEASE_START_MS } = await import(`${base}/sniper/executor.js`);
const { runDueSnipes } = await import(`${base}/sniper/scheduler.js`);

const { SNIPE_INDEX_KEY, SNIPE_DUE_LEAD_MS, createSnipe, getPendingSnipes, updateSnipeStatus, deleteSnipe, listSnipes } = store;
const { identityAllowed } = await import(`${base}/owner-identity.js`);

function makeKv() {
  const data = new Map();
  const ops = { get: 0, put: 0, list: 0, delete: 0, gets: [] };
  const kv = {
    async get(key, opts) {
      ops.get++;
      ops.gets.push({ key, opts });
      return data.has(key) ? data.get(key) : null;
    },
    async put(key, value) {
      ops.put++;
      data.set(key, value);
    },
    async delete(key) {
      ops.delete++;
      data.delete(key);
    },
    async list({ prefix } = {}) {
      ops.list++;
      const keys = [...data.keys()].filter((name) => !prefix || name.startsWith(prefix)).map((name) => ({ name }));
      return { keys, list_complete: true, cacheStatus: null };
    },
  };
  return { data, ops, kv };
}

function useKv() {
  const mock = makeKv();
  setEnv({ CREDS: mock.kv });
  return mock;
}

function snipeInput(releaseTime) {
  return {
    restaurantId: '123',
    platform: 'resy',
    date: '2026-07-01',
    partySize: 2,
    preferredTimes: ['7:00 PM'],
    releaseTime,
  };
}

function readIndex(data) {
  const raw = data.get(SNIPE_INDEX_KEY);
  assert.ok(raw, 'expected snipe index');
  return JSON.parse(raw);
}

const NOW = Date.parse('2026-06-01T15:00:00.000Z');
const LEAD = SNIPE_DUE_LEAD_MS;

test('snipe due index', { concurrency: false }, async (t) => {
  await t.test('lead matches the pre-release poll plus the one-minute cron', () => {
    assert.equal(SNIPE_DUE_LEAD_MS, PRE_RELEASE_START_MS + 60_000);
    assert.equal(PRE_RELEASE_START_MS, 30_000);
  });

  await t.test('idle cron with no index does not list or write', async () => {
    const { ops } = useKv();
    for (let i = 0; i < 1440; i++) {
      assert.deepEqual(await getPendingSnipes(NOW, LEAD), []);
    }
    assert.equal(ops.list, 0);
    assert.equal(ops.put, 0);
    assert.equal(ops.delete, 0);
    assert.equal(ops.get, 1440);
    assert.equal(ops.gets[0].key, SNIPE_INDEX_KEY);
    assert.deepEqual(ops.gets[0].opts, { cacheTtl: 60 });
  });

  await t.test('idle cron with only future snipes reads the index and stops', async () => {
    const { data, ops } = useKv();
    const release = new Date(NOW + LEAD + 1).toISOString();
    const created = await createSnipe(snipeInput(release));
    const index = readIndex(data);
    assert.deepEqual(index.pending.map((p) => p.id), [created.id]);
    assert.equal(index.nextDue, Date.parse(release));
    const listsAfterCreate = ops.list;
    const putsAfterCreate = ops.put;
    ops.get = 0;
    ops.gets.length = 0;

    for (let i = 0; i < 10; i++) assert.deepEqual(await getPendingSnipes(NOW, LEAD), []);

    assert.equal(ops.list, listsAfterCreate);
    assert.equal(ops.put, putsAfterCreate);
    assert.equal(ops.get, 10);
    assert.ok(ops.gets.every((g) => g.key === SNIPE_INDEX_KEY && g.opts?.cacheTtl === 60));
  });

  await t.test('a snipe inside the lead window is loaded by id, not list()', async () => {
    const { ops } = useKv();
    const onTime = new Date(NOW + 30_000).toISOString();
    const later = new Date(NOW + 3 * 60 * 60_000).toISOString();
    const due = await createSnipe(snipeInput(onTime));
    const future = await createSnipe(snipeInput(later));
    ops.list = 0;
    ops.get = 0;
    ops.gets.length = 0;

    const pending = await getPendingSnipes(NOW, LEAD);
    assert.deepEqual(pending.map((s) => s.id), [due.id]);
    assert.equal(ops.list, 0);
    const bodyGets = ops.gets.filter((g) => g.key !== SNIPE_INDEX_KEY);
    assert.deepEqual(bodyGets.map((g) => g.key), [`snipe:${due.id}`]);
    assert.equal(bodyGets.some((g) => g.key === `snipe:${future.id}`), false);

    // Exact lead boundary is due; one millisecond later is not.
    const edge = useKv();
    const boundary = await createSnipe(snipeInput(new Date(NOW + LEAD).toISOString()));
    const outside = await createSnipe(snipeInput(new Date(NOW + LEAD + 1).toISOString()));
    const atEdge = await getPendingSnipes(NOW, LEAD);
    assert.deepEqual(atEdge.map((s) => s.id), [boundary.id]);
    assert.equal(atEdge.some((s) => s.id === outside.id), false);
    assert.equal(edge.ops.list, 1);
  });

  await t.test('overdue snipes stay visible so the cron can mark them missed', async () => {
    const { ops } = useKv();
    const missed = await createSnipe(snipeInput(new Date(NOW - 11 * 60_000).toISOString()));
    const stillOpen = await createSnipe(snipeInput(new Date(NOW - 5 * 60_000).toISOString()));
    const pending = await getPendingSnipes(NOW, LEAD);
    assert.deepEqual(pending.map((s) => s.id), [missed.id, stillOpen.id]);
    assert.equal(ops.list, 1);
  });

  await t.test('missing index ignores legacy records until create rebuilds once', async () => {
    const { data, ops } = useKv();
    const legacy = {
      id: 'snipe-legacy',
      restaurantId: '9',
      platform: 'resy',
      date: '2026-07-01',
      partySize: 2,
      preferredTimes: ['7:00 PM'],
      releaseTime: new Date(NOW - 1000).toISOString(),
      status: 'pending',
      createdAt: new Date(NOW).toISOString(),
    };
    data.set('snipe:snipe-legacy', JSON.stringify(legacy));

    assert.deepEqual(await getPendingSnipes(NOW, LEAD), []);
    assert.equal(ops.list, 0);
    assert.equal(ops.put, 0);

    const created = await createSnipe(snipeInput(new Date(NOW + 86_400_000).toISOString()));
    assert.equal(ops.list, 1);
    const index = readIndex(data);
    assert.deepEqual(index.pending.map((p) => p.id).sort(), [created.id, legacy.id].sort());

    ops.list = 0;
    await createSnipe(snipeInput(new Date(NOW + 2 * 86_400_000).toISOString()));
    assert.equal(ops.list, 0);
  });

  await t.test('corrupt index is treated as missing and rebuilt on create', async () => {
    const { data, ops } = useKv();
    data.set(SNIPE_INDEX_KEY, 'not-json');
    assert.deepEqual(await getPendingSnipes(NOW, LEAD), []);
    assert.equal(ops.list, 0);
    const created = await createSnipe(snipeInput(new Date(NOW + 86_400_000).toISOString()));
    assert.equal(ops.list, 1);
    assert.deepEqual(readIndex(data).pending.map((p) => p.id), [created.id]);
  });

  await t.test('status changes and deletes update the index without listing', async () => {
    const { data, ops } = useKv();
    const a = await createSnipe(snipeInput(new Date(NOW + 86_400_000).toISOString()));
    const b = await createSnipe(snipeInput(new Date(NOW + 2 * 86_400_000).toISOString()));
    ops.list = 0;
    ops.put = 0;

    await updateSnipeStatus(a.id, 'running');
    assert.equal(ops.list, 0);
    assert.deepEqual(readIndex(data).pending.map((p) => p.id), [b.id]);

    await updateSnipeStatus(a.id, 'failed', 'no slots');
    assert.equal(ops.list, 0);
    assert.deepEqual(readIndex(data).pending.map((p) => p.id), [b.id]);

    const removed = await deleteSnipe(b.id);
    assert.equal(removed, true);
    assert.equal(ops.list, 0);
    assert.deepEqual(readIndex(data), { nextDue: null, pending: [] });

    ops.get = 0;
    ops.put = 0;
    ops.list = 0;
    assert.deepEqual(await getPendingSnipes(NOW, LEAD), []);
    assert.equal(ops.list, 0);
    assert.equal(ops.put, 0);
    assert.equal(ops.get, 1);
  });

  await t.test('a stale due id is pruned once, then idle ticks do not write', async () => {
    const { data, ops } = useKv();
    const created = await createSnipe(snipeInput(new Date(NOW - 1000).toISOString()));
    const body = JSON.parse(data.get(`snipe:${created.id}`));
    body.status = 'success';
    data.set(`snipe:${created.id}`, JSON.stringify(body));
    const putsBefore = ops.put;

    assert.deepEqual(await getPendingSnipes(NOW, LEAD), []);
    assert.deepEqual(readIndex(data).pending, []);
    assert.equal(ops.put, putsBefore + 1);
    assert.equal(ops.list, 1);

    ops.put = 0;
    ops.list = 0;
    ops.get = 0;
    assert.deepEqual(await getPendingSnipes(NOW, LEAD), []);
    assert.equal(ops.list, 0);
    assert.equal(ops.put, 0);
    assert.equal(ops.get, 1);
  });

  await t.test('listSnipes skips the index key', async () => {
    const { ops } = useKv();
    const created = await createSnipe(snipeInput(new Date(NOW + 86_400_000).toISOString()));
    const rows = await listSnipes();
    assert.deepEqual(rows.map((s) => s.id), [created.id]);
    assert.ok(ops.list >= 1);
  });

  await t.test('runDueSnipes idle path does not list or write', async () => {
    const { ops } = useKv();
    await createSnipe(snipeInput(new Date(Date.now() + 24 * 60 * 60_000).toISOString()));
    const lists = ops.list;
    const puts = ops.put;
    await runDueSnipes();
    assert.equal(ops.list, lists);
    assert.equal(ops.put, puts);
    assert.equal(ops.delete, 0);
  });

  await t.test('runDueSnipes fails a snipe that missed release by 10 minutes', async () => {
    const { data, ops } = useKv();
    const created = await createSnipe(snipeInput(new Date(Date.now() - 11 * 60_000).toISOString()));
    ops.list = 0;
    await runDueSnipes();
    const body = JSON.parse(data.get(`snipe:${created.id}`));
    assert.equal(body.status, 'failed');
    assert.equal(body.result, 'Missed release time');
    assert.deepEqual(readIndex(data).pending, []);
    assert.equal(ops.list, 0);
  });
});

test('owner identity', () => {
  assert.equal(identityAllowed('Austin@Odell.io', 'austin@odell.io'), true);
  assert.equal(identityAllowed('  austin@odell.io  ', 'austin@odell.io'), true);
  assert.equal(identityAllowed('other@example.com', 'austin@odell.io'), false);
  assert.equal(identityAllowed(undefined, 'austin@odell.io'), false);
  assert.equal(identityAllowed('austin@odell.io', ''), false);
  assert.equal(identityAllowed('austin@odell.io', undefined), false);
});
