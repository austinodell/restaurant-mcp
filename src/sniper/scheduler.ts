// Workers port: no in-process timers. A cron trigger (every minute) calls runDueSnipes().
import { getPendingSnipes, getSnipe, type SnipeConfig } from './store.js';
import { executeSnipe, PRE_RELEASE_START_MS } from './executor.js';
export function scheduleSnipeJob(_c: SnipeConfig): void {}
export function cancelSnipeJob(_id: string): boolean { return true; }
export function isSnipeScheduled(_id: string): boolean { return true; }
export async function getSnipeStatus(id: string) { return getSnipe(id); }
export async function runDueSnipes(): Promise<void> {
  const now = Date.now();
  for (const s of await getPendingSnipes()) {
    const rel = new Date(s.releaseTime).getTime();
    // fire when within the next cron interval (60s) + pre-release window, or overdue by < 10 min
    if (rel - PRE_RELEASE_START_MS - 60000 <= now && now - rel < 10 * 60000) await executeSnipe(s);
    else if (now - rel >= 10 * 60000) { const { updateSnipeStatus } = await import('./store.js'); await updateSnipeStatus(s.id, 'failed', 'Missed release time'); }
  }
}
