// Workers port: no in-process timers. A cron trigger (every minute) calls runDueSnipes().
import { getPendingSnipes, getSnipe, updateSnipeStatus, type SnipeConfig } from './store.js';
import { executeSnipe, PRE_RELEASE_START_MS } from './executor.js';

const CRON_INTERVAL_MS = 60_000;
const MISS_AFTER_MS = 10 * 60_000;

export function scheduleSnipeJob(_c: SnipeConfig): void {}
export function cancelSnipeJob(_id: string): boolean { return true; }
export function isSnipeScheduled(_id: string): boolean { return true; }
export async function getSnipeStatus(id: string) { return getSnipe(id); }

export async function runDueSnipes(): Promise<void> {
  const now = Date.now();
  // Same window as before: start within one cron tick of the 30s pre-release poll, or fail after 10 min.
  const lead = PRE_RELEASE_START_MS + CRON_INTERVAL_MS;
  for (const s of await getPendingSnipes(now, lead)) {
    const rel = new Date(s.releaseTime).getTime();
    if (now - rel >= MISS_AFTER_MS) await updateSnipeStatus(s.id, 'failed', 'Missed release time');
    else if (rel - lead <= now) await executeSnipe(s);
  }
}
