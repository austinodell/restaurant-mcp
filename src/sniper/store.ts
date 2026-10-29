import { getEnv } from '../env.js';
export interface SnipeConfig {
  id: string; restaurantId: string; platform: 'resy' | 'opentable'; date: string; partySize: number;
  preferredTimes: string[]; releaseTime: string; status: 'pending' | 'running' | 'success' | 'failed' | 'cancelled';
  createdAt: string; result?: string;
}
const kv = () => getEnv().CREDS;
const K = (id: string) => `snipe:${id}`;
export async function createSnipe(c: Omit<SnipeConfig, 'id' | 'createdAt' | 'status'>): Promise<SnipeConfig> {
  const s: SnipeConfig = { id: `snipe-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, ...c, status: 'pending', createdAt: new Date().toISOString() };
  await kv().put(K(s.id), JSON.stringify(s)); return s;
}
export async function getSnipe(id: string): Promise<SnipeConfig | null> { const v = await kv().get(K(id)); return v ? JSON.parse(v) : null; }
export async function listSnipes(status?: SnipeConfig['status']): Promise<SnipeConfig[]> {
  const l = await kv().list({ prefix: 'snipe:' });
  const all = (await Promise.all(l.keys.map(k => kv().get(k.name)))).filter(Boolean).map(v => JSON.parse(v!) as SnipeConfig);
  return all.filter(s => !status || s.status === status).sort((a, b) => a.releaseTime.localeCompare(b.releaseTime));
}
export async function updateSnipeStatus(id: string, status: SnipeConfig['status'], result?: string): Promise<void> {
  const s = await getSnipe(id); if (!s) return; s.status = status; s.result = result; await kv().put(K(id), JSON.stringify(s));
}
export async function deleteSnipe(id: string): Promise<boolean> { const had = !!(await getSnipe(id)); await kv().delete(K(id)); return had; }
export async function getPendingSnipes(): Promise<SnipeConfig[]> { return listSnipes('pending'); }
