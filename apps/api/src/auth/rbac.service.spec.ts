import { describe, expect, it } from 'vitest';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { RbacService } from './rbac.service.js';

type Row = { id: string; slug: string; deleted_at: Date | null; org_id?: string };

const deleted = new Date('2026-01-01T00:00:00Z');

const projects: Row[] = [
  { id: 'proj_a', org_id: 'org_a', slug: 'alpha', deleted_at: null },
  { id: 'proj_b', org_id: 'org_b', slug: 'web', deleted_at: null },
  { id: 'proj_c', org_id: 'org_c', slug: 'web', deleted_at: null },
  { id: 'proj_d', org_id: 'org_d', slug: 'beta', deleted_at: null },
  { id: 'proj_e', org_id: 'org_e', slug: 'beta', deleted_at: deleted },
  { id: 'proj_f', org_id: 'org_f', slug: 'gone', deleted_at: deleted },
];

const orgs: Row[] = [
  { id: 'org_a', slug: 'acme', deleted_at: null },
  { id: 'org_b', slug: 'other', deleted_at: null },
  { id: 'org_z', slug: 'closed', deleted_at: deleted },
];

/** Answers the project and org lookups RbacService makes, by id or by slug. */
const db = (async (strings: TemplateStringsArray, ...values: unknown[]) => {
  const sql = strings.join('?');
  const [value] = values;
  const table = /FROM orgs/.test(sql) ? orgs : projects;
  let rows = table.filter((r) => {
    if (/id = \? OR slug = \?/.test(sql)) return r.id === value || r.slug === value;
    return /WHERE id =/.test(sql) ? r.id === value : r.slug === value;
  });
  if (/deleted_at IS NULL/.test(sql)) rows = rows.filter((r) => !r.deleted_at);
  const limit = /LIMIT (\d+)/.exec(sql);
  return limit ? rows.slice(0, Number(limit[1])) : rows;
}) as never;

describe('RbacService token scope lookups', () => {
  const rbac = new RbacService(db);

  describe('getProjectScope', () => {
    it('resolves a project id to the project and its org', async () => {
      await expect(rbac.getProjectScope('proj_a')).resolves.toEqual({ id: 'proj_a', org_id: 'org_a' });
    });

    it('resolves a slug held by one project to that project and its org', async () => {
      await expect(rbac.getProjectScope('alpha')).resolves.toEqual({ id: 'proj_a', org_id: 'org_a' });
    });

    it('refuses a slug that names projects in more than one org', async () => {
      await expect(rbac.getProjectScope('web')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('counts deleted projects when deciding whether a slug is unique', async () => {
      await expect(rbac.getProjectScope('beta')).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('returns 404 for an unknown or deleted project', async () => {
      await expect(rbac.getProjectScope('proj_missing')).rejects.toBeInstanceOf(NotFoundException);
      await expect(rbac.getProjectScope('missing')).rejects.toBeInstanceOf(NotFoundException);
      await expect(rbac.getProjectScope('gone')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getOrgScopeId', () => {
    it('resolves an org id or slug to the org id', async () => {
      await expect(rbac.getOrgScopeId('org_a')).resolves.toBe('org_a');
      await expect(rbac.getOrgScopeId('acme')).resolves.toBe('org_a');
    });

    it('returns 404 for an unknown or deleted org', async () => {
      await expect(rbac.getOrgScopeId('nobody')).rejects.toBeInstanceOf(NotFoundException);
      await expect(rbac.getOrgScopeId('closed')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
