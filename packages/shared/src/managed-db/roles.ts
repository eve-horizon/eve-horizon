import { quotePostgresIdentifier } from './extensions.js';

// ---------------------------------------------------------------------------
// Declarable tenant roles
// ---------------------------------------------------------------------------
//
// A managed DB tenant always has one owner login (managed_db_tenants.db_user).
// The manifest may additionally declare least-privilege runtime logins:
//
//   x-eve.managed.roles:
//     - { name: app,     grants: readwrite }
//     - { name: reports, grants: readonly }
//
// Each declared role becomes a Postgres LOGIN role named
// `<tenant db_user>-<name>` with grants scoped to the tenant database's
// `public` schema. The helpers below are pure so the reconciler's SQL can be
// unit-tested without a database.

export const MANAGED_DB_ROLE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,15}$/;

export const MANAGED_DB_ROLE_GRANTS = ['readwrite', 'readonly'] as const;

export type ManagedDbRoleGrants = (typeof MANAGED_DB_ROLE_GRANTS)[number];

export interface ManagedDbRoleDeclaration {
  name: string;
  grants: ManagedDbRoleGrants;
}

export function isManagedDbRoleGrants(value: unknown): value is ManagedDbRoleGrants {
  return typeof value === 'string' && (MANAGED_DB_ROLE_GRANTS as readonly string[]).includes(value);
}

/**
 * Normalize a list of role declarations (manifest input or the JSONB
 * `desired_roles` column): drop malformed entries, dedupe by name (first
 * wins), and sort by name so persisted intent is stable.
 */
export function normalizeManagedDbRoles(input: unknown): ManagedDbRoleDeclaration[] {
  if (!Array.isArray(input)) return [];
  const byName = new Map<string, ManagedDbRoleDeclaration>();
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const { name, grants } = entry as { name?: unknown; grants?: unknown };
    if (typeof name !== 'string' || !MANAGED_DB_ROLE_NAME_PATTERN.test(name)) continue;
    if (!isManagedDbRoleGrants(grants)) continue;
    if (byName.has(name)) continue;
    byName.set(name, { name, grants });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Desired vs provisioned diff
// ---------------------------------------------------------------------------

export interface ManagedDbProvisionedRole {
  name: string;
  grants: string;
}

export interface ManagedDbRoleDiff<TProvisioned extends ManagedDbProvisionedRole = ManagedDbProvisionedRole> {
  /** Declared in the manifest but not yet provisioned. */
  create: ManagedDbRoleDeclaration[];
  /** Provisioned with a different grant set than declared. */
  regrant: ManagedDbRoleDeclaration[];
  /** Provisioned but no longer declared. */
  drop: TProvisioned[];
}

export function diffManagedDbRoles<TProvisioned extends ManagedDbProvisionedRole>(
  desired: ManagedDbRoleDeclaration[],
  provisioned: TProvisioned[],
): ManagedDbRoleDiff<TProvisioned> {
  const provisionedByName = new Map(provisioned.map((role) => [role.name, role]));
  const desiredByName = new Map(desired.map((role) => [role.name, role]));

  const create: ManagedDbRoleDeclaration[] = [];
  const regrant: ManagedDbRoleDeclaration[] = [];
  for (const role of desired) {
    const existing = provisionedByName.get(role.name);
    if (!existing) {
      create.push(role);
    } else if (existing.grants !== role.grants) {
      regrant.push(role);
    }
  }

  const drop = provisioned.filter((role) => !desiredByName.has(role.name));
  return { create, regrant, drop };
}

export function hasManagedDbRoleChanges(diff: ManagedDbRoleDiff<ManagedDbProvisionedRole>): boolean {
  return diff.create.length > 0 || diff.regrant.length > 0 || diff.drop.length > 0;
}

// ---------------------------------------------------------------------------
// SQL builders
// ---------------------------------------------------------------------------

export interface ManagedDbRoleSqlTarget {
  /** Tenant database name. */
  dbName: string;
  /** Tenant owner login (managed_db_tenants.db_user). */
  ownerUser: string;
  /** Login role being granted/revoked. */
  roleUser: string;
}

export interface ManagedDbRoleSql {
  /** Statements to run on the instance admin connection (any database). */
  instance: string[];
  /** Statements to run while connected to the tenant database. */
  tenant: string[];
}

const TENANT_SCHEMA = 'public';

function privilegesFor(grants: ManagedDbRoleGrants): { tables: string; sequences: string } {
  return grants === 'readwrite'
    ? { tables: 'SELECT, INSERT, UPDATE, DELETE', sequences: 'SELECT, USAGE' }
    : { tables: 'SELECT', sequences: 'SELECT' };
}

/**
 * Grants for a declared role: CONNECT on the database, USAGE on `public`,
 * privileges on every existing table/sequence, and matching default
 * privileges so objects the owner creates later are covered too.
 *
 * Passwords are never part of the output; role creation stays with the caller.
 */
export function buildManagedDbRoleGrantSql(
  target: ManagedDbRoleSqlTarget & { grants: ManagedDbRoleGrants },
): ManagedDbRoleSql {
  const db = quotePostgresIdentifier(target.dbName);
  const owner = quotePostgresIdentifier(target.ownerUser);
  const role = quotePostgresIdentifier(target.roleUser);
  const schema = quotePostgresIdentifier(TENANT_SCHEMA);
  const { tables, sequences } = privilegesFor(target.grants);

  return {
    instance: [
      `GRANT CONNECT ON DATABASE ${db} TO ${role}`,
    ],
    tenant: [
      `GRANT USAGE ON SCHEMA ${schema} TO ${role}`,
      `GRANT ${tables} ON ALL TABLES IN SCHEMA ${schema} TO ${role}`,
      `GRANT ${sequences} ON ALL SEQUENCES IN SCHEMA ${schema} TO ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT ${tables} ON TABLES TO ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} GRANT ${sequences} ON SEQUENCES TO ${role}`,
    ],
  };
}

/**
 * Inverse of {@link buildManagedDbRoleGrantSql}: strip every privilege the
 * role holds in the tenant database (default privileges first so nothing is
 * re-granted mid-flight), then its database-level CONNECT. After these run
 * the role owns nothing and can be dropped.
 */
export function buildManagedDbRoleRevokeSql(target: ManagedDbRoleSqlTarget): ManagedDbRoleSql {
  const db = quotePostgresIdentifier(target.dbName);
  const owner = quotePostgresIdentifier(target.ownerUser);
  const role = quotePostgresIdentifier(target.roleUser);
  const schema = quotePostgresIdentifier(TENANT_SCHEMA);

  return {
    tenant: [
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} REVOKE ALL ON TABLES FROM ${role}`,
      `ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA ${schema} REVOKE ALL ON SEQUENCES FROM ${role}`,
      `REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`,
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`,
      `REVOKE ALL ON SCHEMA ${schema} FROM ${role}`,
    ],
    instance: [
      `REVOKE ALL ON DATABASE ${db} FROM ${role}`,
    ],
  };
}
