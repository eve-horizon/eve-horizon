/**
 * Canonical permission catalog for Eve Horizon.
 *
 * Every permission recognised by the platform is listed here exactly once.
 * Both the API (for runtime enforcement) and the CLI (for YAML validation)
 * import from this single source of truth.
 */

export const ALL_PERMISSIONS = [
  // Jobs
  'jobs:read', 'jobs:write', 'jobs:admin',
  'jobs:harness_override',
  // Threads
  'threads:read', 'threads:write', 'threads:admin',
  // Projects
  'projects:read', 'projects:create', 'projects:write', 'projects:admin',
  // Environments
  'envs:read', 'envs:write', 'envs:admin',
  // Env DB
  'envdb:read', 'envdb:write',
  // Org filesystem data plane
  'orgfs:read', 'orgfs:write', 'orgfs:admin',
  // Org document data plane
  'orgdocs:read', 'orgdocs:write', 'orgdocs:admin',
  // Secrets
  'secrets:read', 'secrets:write', 'secrets:admin',
  // Builds
  'builds:read', 'builds:write', 'builds:admin',
  // Releases
  'releases:read', 'releases:write', 'releases:admin',
  // Pipelines
  'pipelines:read', 'pipelines:write', 'pipelines:admin',
  // Agents
  'agents:read', 'agents:write', 'agents:admin',
  // Workflows
  'workflows:read', 'workflows:write',
  // Orgs
  'orgs:read', 'orgs:create', 'orgs:write', 'orgs:admin',
  'orgs:members:read', 'orgs:invite',
  // Integrations
  'integrations:read', 'integrations:write',
  // Cloud FS
  'cloud_fs:read', 'cloud_fs:write', 'cloud_fs:admin',
  // Events
  'events:read', 'events:write',
  // Chat
  'chat:write',
  // Notifications
  'notifications:send',
  // Private Endpoints
  'endpoints:read', 'endpoints:write',
  // System
  'system:read', 'system:admin',
] as const;

export type Permission = (typeof ALL_PERMISSIONS)[number];

/** Set for O(1) membership checks. */
export const PERMISSION_SET: ReadonlySet<string> = new Set(ALL_PERMISSIONS);

/** Returns a copy of the full permission list. */
export function allPermissions(): Permission[] {
  return [...ALL_PERMISSIONS];
}

/** Check whether a string is a recognised permission. */
export function isValidPermission(s: string): s is Permission {
  return PERMISSION_SET.has(s);
}

/** Default permissions granted to agent job tokens. */
export const DEFAULT_AGENT_PERMISSIONS: readonly Permission[] = [
  'jobs:read',
  'jobs:write',
  'jobs:harness_override',
  'projects:read',     // Needed for `eve api call/spec/list`
  'threads:read',
  'threads:write',
  'envdb:read',
  'secrets:read',
  'builds:read',
  'pipelines:read',
];

/**
 * Default permissions for pipeline `script:` jobs.
 *
 * Broader than agent defaults — script steps historically run platform
 * operations (migrations, env writes, releases). Workflow authors narrow
 * this by declaring explicit `permissions:` on the step.
 */
export const DEFAULT_SCRIPT_JOB_PERMISSIONS: readonly Permission[] = [
  'jobs:read',
  'jobs:write',
  'projects:read',
  'envs:read',
  'envs:write',
  'envdb:read',
  'envdb:write',
  'releases:read',
  'builds:read',
  'pipelines:read',
  'secrets:read',
];

/**
 * Default permissions for pipeline `action: { type: run }` jobs.
 *
 * Narrow by design — `type: run` is "arbitrary user shell command". Authors
 * opt in to broader access by declaring explicit `permissions:` on the step.
 * Notably excludes `secrets:read` (least privilege).
 */
export const DEFAULT_ACTION_RUN_JOB_PERMISSIONS: readonly Permission[] = [
  'jobs:read',
  'jobs:write',
  'projects:read',
  'envs:read',
];

/**
 * Default permissions granted to deployed-service tokens.
 *
 * Read-only by design — apps that need write access must declare
 * additional permissions in their manifest via `x-eve.permissions`.
 */
export const DEFAULT_SERVICE_PERMISSIONS: readonly Permission[] = [
  'projects:read',
  'jobs:read',
  'threads:read',
  'envs:read',
  'secrets:read',
  'builds:read',
  'pipelines:read',
  'agents:read',
  'events:read',
];
