/**
 * Unified Permission Model
 *
 * Every endpoint declares what permission it requires.
 * Permissions are resolved differently depending on the caller:
 *
 *   User token (context-bound) → role in org/project → expand to permission set
 *   User token (context-free)  → 'member' baseline permissions
 *   Job token                  → explicit permissions[] array in JWT
 *   System admin (is_admin)    → bypass — all permissions granted
 *   Internal service           → @Public() + x-eve-internal-token — unchanged
 */

// Re-export canonical Permission type and helpers from shared.
// The shared module is the single source of truth for the permission catalog;
// this file adds the role-expansion logic that only the API needs.
export { type Permission, allPermissions, isValidPermission, ALL_PERMISSIONS } from '@eve/shared';

import { type Permission, allPermissions } from '@eve/shared';

// ── Role → Permission mapping ──────────────────────────────────────────

const MEMBER_PERMISSIONS: readonly Permission[] = [
  'jobs:read',        'jobs:write',
  'jobs:harness_override',
  'threads:read',     'threads:write',
  'projects:read',    'projects:create',
  'orgs:read',        'orgs:create',
  'orgs:members:read',
  'envs:read',
  'envdb:read',
  'secrets:read',
  'builds:read',
  'pipelines:read',
  'workflows:read',
  'integrations:read',
  'endpoints:read',
  'events:read',
  'cloud_fs:read',
];

const ADMIN_EXTRA: readonly Permission[] = [
  'projects:write',   'projects:admin',
  'envs:write',       'envs:admin',
  'envdb:write',
  'secrets:write',    'secrets:admin',
  'builds:write',     'builds:admin',
  'releases:admin',
  'pipelines:write',  'pipelines:admin',
  'workflows:write',
  'orgs:write',
  'orgs:invite',
  'integrations:write',
  'endpoints:write',
  'events:write',
  'chat:write',
  'notifications:send',
  'jobs:admin',
  'agents:admin',
  'threads:admin',
  'cloud_fs:write',  'cloud_fs:admin',
  'system:read',
];

const OWNER_EXTRA: readonly Permission[] = [
  'orgs:admin',
];

// Expanded at init time — each role includes all lower-role permissions.
const EXPANDED = new Map<string, ReadonlySet<Permission>>();

function init() {
  const member = new Set<Permission>(MEMBER_PERMISSIONS);
  EXPANDED.set('member', member);

  const admin = new Set<Permission>([...member, ...ADMIN_EXTRA]);
  EXPANDED.set('admin', admin);

  const owner = new Set<Permission>([...admin, ...OWNER_EXTRA]);
  EXPANDED.set('owner', owner);
}
init();

/**
 * Expand a role name to its full set of permissions.
 * Returns an empty set for unknown roles.
 */
export function expandPermissions(role: string): ReadonlySet<Permission> {
  return EXPANDED.get(role) ?? new Set();
}

/** Check if a permission set includes a required permission. */
export function hasPermission(permissions: ReadonlySet<string>, required: Permission): boolean {
  return permissions.has(required);
}

/** Check if a permission set includes any of the required permissions (OR). */
export function hasAnyPermission(permissions: ReadonlySet<string>, required: readonly Permission[]): boolean {
  return required.some((p) => permissions.has(p));
}

// ── Default agent permissions ──────────────────────────────────────────
// Re-exported from shared — single source of truth
export { DEFAULT_AGENT_PERMISSIONS } from '@eve/shared';

// ── Role → Permission matrix (for CLI display) ────────────────────────

export function permissionMatrix(): Array<{ permission: Permission; member: boolean; admin: boolean; owner: boolean }> {
  const memberSet = EXPANDED.get('member')!;
  const adminSet = EXPANDED.get('admin')!;
  const ownerSet = EXPANDED.get('owner')!;

  return allPermissions().map((p) => ({
    permission: p,
    member: memberSet.has(p),
    admin: adminSet.has(p),
    owner: ownerSet.has(p),
  }));
}
