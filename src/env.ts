export interface Env { CREDS: KVNamespace; MCP_TOKEN: string; [k: string]: unknown }
let _env: Env | null = null;
export function setEnv(e: Env) { _env = e; }
export function getEnv(): Env { if (!_env) throw new Error('env not set'); return _env; }
