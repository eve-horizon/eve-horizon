import { describe, expect, it } from 'vitest';
import {
  buildManagedDbRoleGrantSql,
  buildManagedDbRoleRevokeSql,
  diffManagedDbRoles,
  generateManagedDbRoleUser,
  generateManagedDbUser,
  hasManagedDbRoleChanges,
  normalizeManagedDbRoles,
  parseManagedDbConnectionUrl,
} from '../index.js';

describe('generateManagedDbRoleUser', () => {
  it('appends the role name to the tenant user when it fits', () => {
    expect(generateManagedDbRoleUser('acme-shop-staging-u-1a2b3c', 'app_ro')).toBe(
      'acme-shop-staging-u-1a2b3c-app_ro',
    );
  });

  it('truncates to 63 characters with a short hash when the name is too long', () => {
    const dbUser = generateManagedDbUser(
      'a-very-long-organisation-slug-name',
      'an-equally-long-project-slug-here',
      'production-eu-west-1',
    );
    expect(dbUser.length).toBe(63);

    const roleUser = generateManagedDbRoleUser(dbUser, 'reporting_reader');
    expect(roleUser.length).toBe(63);
    expect(roleUser).toMatch(/-[0-9a-f]{6}$/);
    expect(roleUser.startsWith(dbUser.slice(0, 40))).toBe(true);
    // Deterministic
    expect(generateManagedDbRoleUser(dbUser, 'reporting_reader')).toBe(roleUser);
    // Distinct role names never collide once truncated
    expect(generateManagedDbRoleUser(dbUser, 'reporting_writer')).not.toBe(roleUser);
  });
});

describe('normalizeManagedDbRoles', () => {
  it('sorts by name and drops malformed entries', () => {
    expect(normalizeManagedDbRoles([
      { name: 'zeta', grants: 'readonly' },
      { name: 'alpha', grants: 'readwrite' },
      { name: 'Bad-Name', grants: 'readonly' },
      { name: 'alpha', grants: 'readonly' },
      { name: 'nope', grants: 'admin' },
      'garbage',
      null,
    ])).toEqual([
      { name: 'alpha', grants: 'readwrite' },
      { name: 'zeta', grants: 'readonly' },
    ]);
  });

  it('returns an empty list for non-array input', () => {
    expect(normalizeManagedDbRoles(undefined)).toEqual([]);
    expect(normalizeManagedDbRoles(null)).toEqual([]);
    expect(normalizeManagedDbRoles('[]')).toEqual([]);
  });
});

describe('diffManagedDbRoles', () => {
  it('reports nothing to do when desired and provisioned match', () => {
    const diff = diffManagedDbRoles(
      [{ name: 'app', grants: 'readwrite' }],
      [{ name: 'app', grants: 'readwrite' }],
    );
    expect(diff).toEqual({ create: [], regrant: [], drop: [] });
    expect(hasManagedDbRoleChanges(diff)).toBe(false);
  });

  it('separates roles to create, regrant, and drop', () => {
    const diff = diffManagedDbRoles(
      [
        { name: 'app', grants: 'readonly' },
        { name: 'new_role', grants: 'readwrite' },
      ],
      [
        { name: 'app', grants: 'readwrite' },
        { name: 'old_role', grants: 'readonly' },
      ],
    );
    expect(diff).toEqual({
      create: [{ name: 'new_role', grants: 'readwrite' }],
      regrant: [{ name: 'app', grants: 'readonly' }],
      drop: [{ name: 'old_role', grants: 'readonly' }],
    });
    expect(hasManagedDbRoleChanges(diff)).toBe(true);
  });
});

describe('buildManagedDbRoleGrantSql', () => {
  const target = {
    dbName: 'acme-shop-staging-1a2b3c',
    ownerUser: 'acme-shop-staging-u-1a2b3c',
    roleUser: 'acme-shop-staging-u-1a2b3c-app',
  };

  it('grants read/write on existing and future tables and sequences', () => {
    const sql = buildManagedDbRoleGrantSql({ ...target, grants: 'readwrite' });

    expect(sql.instance).toEqual([
      'GRANT CONNECT ON DATABASE "acme-shop-staging-1a2b3c" TO "acme-shop-staging-u-1a2b3c-app"',
    ]);
    expect(sql.tenant).toEqual([
      'GRANT USAGE ON SCHEMA "public" TO "acme-shop-staging-u-1a2b3c-app"',
      'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "public" TO "acme-shop-staging-u-1a2b3c-app"',
      'GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA "public" TO "acme-shop-staging-u-1a2b3c-app"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "acme-shop-staging-u-1a2b3c" IN SCHEMA "public" GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "acme-shop-staging-u-1a2b3c-app"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "acme-shop-staging-u-1a2b3c" IN SCHEMA "public" GRANT SELECT, USAGE ON SEQUENCES TO "acme-shop-staging-u-1a2b3c-app"',
    ]);
  });

  it('grants select-only for readonly roles', () => {
    const sql = buildManagedDbRoleGrantSql({ ...target, grants: 'readonly' });

    expect(sql.tenant).toEqual([
      'GRANT USAGE ON SCHEMA "public" TO "acme-shop-staging-u-1a2b3c-app"',
      'GRANT SELECT ON ALL TABLES IN SCHEMA "public" TO "acme-shop-staging-u-1a2b3c-app"',
      'GRANT SELECT ON ALL SEQUENCES IN SCHEMA "public" TO "acme-shop-staging-u-1a2b3c-app"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "acme-shop-staging-u-1a2b3c" IN SCHEMA "public" GRANT SELECT ON TABLES TO "acme-shop-staging-u-1a2b3c-app"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "acme-shop-staging-u-1a2b3c" IN SCHEMA "public" GRANT SELECT ON SEQUENCES TO "acme-shop-staging-u-1a2b3c-app"',
    ]);
  });

  it('quotes identifiers containing double quotes', () => {
    const sql = buildManagedDbRoleGrantSql({ ...target, roleUser: 'we"ird', grants: 'readonly' });
    expect(sql.instance[0]).toContain('TO "we""ird"');
  });
});

describe('buildManagedDbRoleRevokeSql', () => {
  it('revokes default privileges, object privileges, schema usage, and database connect', () => {
    const sql = buildManagedDbRoleRevokeSql({
      dbName: 'db1',
      ownerUser: 'owner',
      roleUser: 'owner-app',
    });

    expect(sql.tenant).toEqual([
      'ALTER DEFAULT PRIVILEGES FOR ROLE "owner" IN SCHEMA "public" REVOKE ALL ON TABLES FROM "owner-app"',
      'ALTER DEFAULT PRIVILEGES FOR ROLE "owner" IN SCHEMA "public" REVOKE ALL ON SEQUENCES FROM "owner-app"',
      'REVOKE ALL ON ALL TABLES IN SCHEMA "public" FROM "owner-app"',
      'REVOKE ALL ON ALL SEQUENCES IN SCHEMA "public" FROM "owner-app"',
      'REVOKE ALL ON SCHEMA "public" FROM "owner-app"',
    ]);
    expect(sql.instance).toEqual([
      'REVOKE ALL ON DATABASE "db1" FROM "owner-app"',
    ]);
  });
});

describe('parseManagedDbConnectionUrl', () => {
  it('splits a tenant URL into its connection fields', () => {
    expect(parseManagedDbConnectionUrl(
      'postgres://acme-shop-u-1a2b3c:s3cr3t@db.internal:6543/acme-shop-1a2b3c?sslmode=verify-full',
    )).toEqual({
      host: 'db.internal',
      port: '6543',
      database: 'acme-shop-1a2b3c',
      username: 'acme-shop-u-1a2b3c',
      password: 's3cr3t',
    });
  });

  it('defaults the port to 5432 and decodes percent-encoded credentials', () => {
    expect(parseManagedDbConnectionUrl('postgresql://user%40x:p%40ss@localhost/app')).toEqual({
      host: 'localhost',
      port: '5432',
      database: 'app',
      username: 'user@x',
      password: 'p@ss',
    });
  });

  it('returns null for values that are not postgres URLs', () => {
    expect(parseManagedDbConnectionUrl('${secret.DATABASE_URL}')).toBeNull();
    expect(parseManagedDbConnectionUrl('https://example.com/db')).toBeNull();
    expect(parseManagedDbConnectionUrl('')).toBeNull();
  });
});
