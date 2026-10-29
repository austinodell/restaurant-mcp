import { getEnv } from '../env.js';

export interface SnipeConfig {
  id: string; restaurantId: string; platform: 'resy' | 'opentable'; date: string; partySize: number;
  preferredTimes: string[]; releaseTime: string; status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  createdAt: string; result?: string;
}

/**
 * One KV key for every pending snipe. The per-minute cron reads only this key.
 * `nextDue` is the earliest releaseTime (ms); membership changes are what cost writes.
 * A missing key means "none pending" — the cron must not list() to find out.
 * The next createSnipe rebuilds it once from existing `snipe:<id>` records.
 */
export const SNIPE_INDEX_KEY = 'snipe:next_due';

/** How long before releaseTime the cron must load a snipe: 30s pre-release poll + 60s cron interval. */
export const SNIPE_DUE_LEAD_MS = 30_000 + 60_000;

const INDEX_CACHE_TTL = 60;

interface DueEntry {
  id: string;
  releaseTime: string;
}

interface DueIndex {
  nextDue: number | null;
  pending: DueEntry[];
}

const kv = () => getEnv().CREDS;
const K = (id: string) => `snipe:${id}`;

function normalize(pending: DueEntry[]): DueIndex {
  const byId = new Map<string, DueEntry>();
  for (const entry of pending) {
    if (!entry || typeof entry.id !== 'string' || typeof entry.releaseTime !== 'string') continue;
    byId.set(entry.id, { id: entry.id, releaseTime: entry.releaseTime });
  }
  const entries = [...byId.values()].sort((a, b) => a.releaseTime.localeCompare(b.releaseTime) || a.id.localeCompare(b.id));
  let nextDue: number | null = null;
  for (const entry of entries) {
    const t = Date.parse(entry.releaseTime);
    if (!Number.isFinite(t)) continue;
    if (nextDue === null || t < nextDue) nextDue = t;
  }
  return { nextDue, pending: entries };
}

function samePending(a: DueEntry[], b: DueEntry[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].releaseTime !== b[i].releaseTime) return false;
  }
  return true;
}

function parseIndex(raw: string | null): DueIndex | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { pending?: unknown };
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.pending)) return null;
    return normalize(parsed.pending as DueEntry[]);
  } catch {
    return null;
  }
}

function parseSnipe(raw: string | null): SnipeConfig | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as SnipeConfig;
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || typeof s.releaseTime !== 'string') return null;
    if (s.status !== 'pending' && s.status !== 'running' && s.status !== 'success' && s.status !== 'failed' && s.status !== 'cancelled') return null;
    return s;
  } catch {
    return null;
  }
}

async function readIndex(cacheTtl?: number): Promise<DueIndex | null> {
  const raw = cacheTtl != null
    ? await kv().get(SNIPE_INDEX_KEY, { cacheTtl })
    : await kv().get(SNIPE_INDEX_KEY);
  return parseIndex(raw);
}

async function writeIndex(pending: DueEntry[]): Promise<void> {
  await kv().put(SNIPE_INDEX_KEY, JSON.stringify(normalize(pending)));
}

/** Insert or drop one id. Rebuilds via list() only when the index is missing and `rebuildIfMissing` is set. */
async function syncIndex(id: string, releaseTime: string, pending: boolean, rebuildIfMissing: boolean): Promise<void> {
  const current = await readIndex();
  let base: DueEntry[];
  let mustWrite = false;
  if (!current) {
    if (!rebuildIfMissing) return;
    mustWrite = true;
    const existing = await listSnipes('pending');
    base = existing.map((s) => ({ id: s.id, releaseTime: s.releaseTime }));
  } else {
    base = current.pending;
  }
  const without = base.filter((p) => p.id !== id);
  const next = pending ? [...without, { id, releaseTime }] : without;
  const normalized = normalize(next);
  if (!mustWrite && samePending(normalize(base).pending, normalized.pending)) return;
  await writeIndex(normalized.pending);
}

async function pruneIndex(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const current = await readIndex();
  if (!current) return;
  const drop = new Set(ids);
  const next = normalize(current.pending.filter((p) => !drop.has(p.id)));
  if (samePending(current.pending, next.pending)) return;
  await writeIndex(next.pending);
}

export async function createSnipe(c: Omit<SnipeConfig, 'id' | 'createdAt' | 'status'>): Promise<SnipeConfig> {
  const s: SnipeConfig = {
    id: `snipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...c,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };
  await kv().put(K(s.id), JSON.stringify(s));
  // List is eventually consistent, so the record just written is merged in explicitly.
  await syncIndex(s.id, s.releaseTime, true, true);
  return s;
}

export async function getSnipe(id: string): Promise<SnipeConfig | null> {
  return parseSnipe(await kv().get(K(id)));
}

export async function listSnipes(status?: SnipeConfig['status']): Promise<SnipeConfig[]> {
  const listed = await kv().list({ prefix: 'snipe:' });
  const names = listed.keys.map((key) => key.name).filter((name) => name !== SNIPE_INDEX_KEY);
  const all = (await Promise.all(names.map(async (name) => parseSnipe(await kv().get(name))))).filter((s): s is SnipeConfig => !!s);
  return all.filter((s) => !status || s.status === status).sort((a, b) => a.releaseTime.localeCompare(b.releaseTime));
}

export async function updateSnipeStatus(id: string, status: SnipeConfig['status'], result?: string): Promise<void> {
  const s = await getSnipe(id);
  if (!s) return;
  s.status = status;
  s.result = result;
  await kv().put(K(id), JSON.stringify(s));
  await syncIndex(s.id, s.releaseTime, status === 'pending', false);
}

export async function deleteSnipe(id: string): Promise<boolean> {
  const had = !!(await getSnipe(id));
  await kv().delete(K(id));
  await syncIndex(id, '', false, false);
  return had;
}

/**
 * Pending snipes the cron should act on. One cached index read when nothing is due
 * (including a missing index). Individual records are loaded only for ids already due.
 */
export async function getPendingSnipes(now = Date.now(), leadMs = SNIPE_DUE_LEAD_MS): Promise<SnipeConfig[]> {
  const index = await readIndex(INDEX_CACHE_TTL);
  if (!index || index.pending.length === 0) return [];
  if (index.nextDue == null || index.nextDue - leadMs > now) return [];

  const due = index.pending.filter((entry) => {
    const rel = Date.parse(entry.releaseTime);
    return Number.isFinite(rel) && rel - leadMs <= now;
  });
  if (due.length === 0) return [];

  const loaded = await Promise.all(due.map(async (entry) => ({ id: entry.id, snipe: await getSnipe(entry.id) })));
  const stale = loaded.filter((row) => !row.snipe || row.snipe.status !== 'pending').map((row) => row.id);
  if (stale.length > 0) await pruneIndex(stale);

  return loaded
    .map((row) => row.snipe)
    .filter((s): s is SnipeConfig => !!s && s.status === 'pending')
    .sort((a, b) => a.releaseTime.localeCompare(b.releaseTime));
}
