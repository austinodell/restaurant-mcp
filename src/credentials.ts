import { getEnv } from './env.js';
export type CredentialKey = 'resy-api-key' | 'resy-auth-token' | 'resy-email' | 'resy-password' | 'opentable-token';
const ENV_VAR_MAP: Record<CredentialKey, string> = {
  'resy-api-key': 'API_KEY', 'resy-auth-token': 'RESY_AUTH_TOKEN', 'resy-email': 'RESY_EMAIL',
  'resy-password': 'RESY_PASSWORD', 'opentable-token': 'OPENTABLE_TOKEN',
};
const K = (k: string) => `cred:${k}`;
export async function getCredential(key: CredentialKey): Promise<string | null> {
  const env = getEnv(); const v = env[ENV_VAR_MAP[key]];
  if (typeof v === 'string' && v) return v;
  return await env.CREDS.get(K(key));
}
export async function setCredential(key: CredentialKey, value: string): Promise<void> { await getEnv().CREDS.put(K(key), value); }
export async function deleteCredential(key: CredentialKey): Promise<boolean> {
  const had = (await getEnv().CREDS.get(K(key))) !== null; await getEnv().CREDS.delete(K(key)); return had;
}
export async function getAllCredentialKeys(): Promise<CredentialKey[]> {
  const l = await getEnv().CREDS.list({ prefix: 'cred:' }); return l.keys.map(k => k.name.slice(5) as CredentialKey);
}
export function maskCredential(value: string): string {
  if (value.length <= 4) return '*'.repeat(value.length);
  return value.slice(0, 2) + '*'.repeat(value.length - 4) + value.slice(-2);
}
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@'); if (!domain) return maskCredential(email);
  const m = local.length <= 2 ? '*'.repeat(local.length) : local[0] + '*'.repeat(local.length - 2) + local[local.length - 1];
  return `${m}@${domain}`;
}
export interface AuthStatus { platform: 'resy' | 'opentable'; hasApiKey: boolean; hasAuthToken: boolean; hasLogin: boolean; email?: string; }
export async function getResyAuthStatus(): Promise<AuthStatus> {
  const [a, t, e, p] = await Promise.all([getCredential('resy-api-key'), getCredential('resy-auth-token'), getCredential('resy-email'), getCredential('resy-password')]);
  return { platform: 'resy', hasApiKey: !!a, hasAuthToken: !!t, hasLogin: !!e && !!p, email: e ? maskEmail(e) : undefined };
}
export async function getOpenTableAuthStatus(): Promise<AuthStatus> {
  return { platform: 'opentable', hasApiKey: false, hasAuthToken: !!(await getCredential('opentable-token')), hasLogin: false };
}
