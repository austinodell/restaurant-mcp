/**
 * The committed package.json says 0.0.0-development. Git tags (vX.Y.Z, made by
 * semantic-release) are the source of truth, and the deploy workflow passes
 * `git describe` to the Worker as APP_VERSION.
 */
export const DEVELOPMENT_VERSION = '0.0.0-development';

/** Any Worker env object; only APP_VERSION and CF_VERSION_METADATA are read. */
type VersionEnv = object | null | undefined;

export function appVersion(env: VersionEnv): string {
  const value = (env as { APP_VERSION?: unknown } | null | undefined)?.APP_VERSION;
  return (typeof value === 'string' && value.trim()) || DEVELOPMENT_VERSION;
}

/** What get_server_info reports: the release, and which Worker deployment is serving it. */
export function serverInfo(env: VersionEnv) {
  const deployment = (env as { CF_VERSION_METADATA?: Partial<WorkerVersionMetadata> } | null | undefined)?.CF_VERSION_METADATA;
  return {
    name: 'restaurant-mcp',
    version: appVersion(env),
    ...(deployment?.id ? { worker_version_id: deployment.id } : {}),
    ...(deployment?.timestamp ? { deployed_at: deployment.timestamp } : {}),
  };
}
