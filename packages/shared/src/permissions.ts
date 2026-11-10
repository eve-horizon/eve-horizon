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
 * The narrowest job-token permissions: enough for a step to read and report on
 * its own job and read its project. A step that no user started and whose
 * declared permissions are all withheld gets these, not its executor's broader
 * default (agent: {@link DEFAULT_AGENT_PERMISSIONS}, script:
 * {@link DEFAULT_SCRIPT_JOB_PERMISSIONS}).
 */
export const MINIMAL_JOB_TOKEN_PERMISSIONS: readonly Permission[] = DEFAULT_ACTION_RUN_JOB_PERMISSIONS;

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

/**
 * Org- and platform-management permissions: they manage the org (members,
 * invites, settings, integrations, endpoints, new projects) or the platform,
 * not a project's work. A project role never confers them on a token; they come
 * only from an org-level role or binding.
 */
export const ORG_MANAGEMENT_PERMISSIONS: readonly Permission[] = [
  'orgs:create',
  'orgs:write',
  'orgs:admin',
  'orgs:invite',
  'projects:create',
  'integrations:write',
  'endpoints:write',
  'system:read',
  'system:admin',
];

const ORG_MANAGEMENT_SET: ReadonlySet<string> = new Set<string>(ORG_MANAGEMENT_PERMISSIONS);

/** True for a permission in {@link ORG_MANAGEMENT_PERMISSIONS}. */
export function isOrgManagementPermission(permission: string): boolean {
  return ORG_MANAGEMENT_SET.has(permission);
}

/**
 * Admin permissions over org-wide data (org filesystem, org docs, cloud-fs
 * mounts). Like org management, a job token gets them only from its actor's
 * org role or org-level bindings, never from a project role.
 */
export const ORG_DATA_ADMIN_PERMISSIONS: readonly Permission[] = [
  'orgfs:admin',
  'orgdocs:admin',
  'cloud_fs:admin',
];

const ORG_ROLE_ONLY_SET: ReadonlySet<string> = new Set<string>([
  ...ORG_MANAGEMENT_PERMISSIONS,
  ...ORG_DATA_ADMIN_PERMISSIONS,
]);

/**
 * True for permissions a job token may only carry when its actor holds them
 * at org level: {@link ORG_MANAGEMENT_PERMISSIONS} and
 * {@link ORG_DATA_ADMIN_PERMISSIONS}. Withheld when no user started the work.
 */
export function isOrgRoleOnlyPermission(permission: string): boolean {
  return ORG_ROLE_ONLY_SET.has(permission);
}

/**
 * Drop the permissions a deployed-service token may not carry, whatever the
 * manifest declares in `x-eve.permissions`: every admin-level (`*:admin`)
 * permission and every org-management permission. Applied when a service token
 * is minted and again when one is verified, so a token signed before a
 * narrower set took effect is held to it too.
 */
export function clampServiceTokenPermissions(requested: readonly string[]): string[] {
  return [...new Set(requested)].filter(
    (permission) => !permission.endsWith(':admin') && !isOrgManagementPermission(permission),
  );
}

/**
 * The user id recorded on work no user started (internal pipeline runs) and
 * carried by job tokens for such jobs. It is never a person.
 */
export const SYSTEM_ACTOR_ID = 'system';

/** True when `userId` names a user who started the work (not empty, not the system actor). */
export function hasUserActor(userId: string | null | undefined): userId is string {
  return typeof userId === 'string' && userId.length > 0 && userId !== SYSTEM_ACTOR_ID;
}

/** True for platform permissions (`system:*`), which no job token carries. */
export function isPlatformPermission(permission: string): boolean {
  return permission.startsWith('system:');
}

/**
 * Split permissions declared for a job token when no user started the job
 * (event triggers, schedules, internal runs): platform permissions and those
 * judged on the org role only ({@link isOrgRoleOnlyPermission}) are withheld,
 * everything else is granted. With a user actor the
 * actor's own permissions are the ceiling instead.
 */
export function splitNoActorJobPermissions(requested: readonly string[]): { granted: string[]; withheld: string[] } {
  const granted: string[] = [];
  const withheld: string[] = [];
  for (const permission of new Set(requested)) {
    if (isPlatformPermission(permission) || isOrgRoleOnlyPermission(permission)) {
      withheld.push(permission);
    } else {
      granted.push(permission);
    }
  }
  return { granted, withheld };
}

/**
 * The permissions a job token may carry, applied when it is minted and again
 * when it is verified: never platform permissions, and org-role-only
 * permissions ({@link isOrgRoleOnlyPermission}) only for a job that a user
 * started.
 */
export function clampJobTokenPermissions(requested: readonly string[], options: { hasActor: boolean }): string[] {
  return [...new Set(requested)].filter(
    (permission) => !isPlatformPermission(permission) && (options.hasActor || !isOrgRoleOnlyPermission(permission)),
  );
}
