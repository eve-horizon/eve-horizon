import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');
const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;

async function runEve(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    cwd: repoRoot,
    env: { ...process.env, EVE_API_URL: apiUrl },
  });
  return stdout.trim();
}

async function deleteOrg(orgId: string): Promise<void> {
  await fetch(`${apiUrl}/orgs/${orgId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleted: true }),
  });
}

async function authMe(): Promise<{ user_id: string }> {
  const response = await fetch(`${apiUrl}/auth/me`);
  if (!response.ok) {
    throw new Error(`auth/me failed: ${response.status} ${await response.text()}`);
  }
  return (await response.json()) as { user_id: string };
}

describe('integration access cli', () => {
  it('supports access groups, scoped bind, memberships, and resource checks', async () => {
    const orgRaw = await runEve(['org', 'ensure', `AccessCliOrg${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    const me = await authMe();
    const roleName = `orgfs_reader_${Date.now()}`;

    try {
      const createGroupRaw = await runEve([
        'access',
        'groups',
        'create',
        'PM Team',
        '--org',
        org.id,
        '--slug',
        'pm-team',
        '--json',
      ]);
      const group = JSON.parse(createGroupRaw) as { id: string; slug: string };
      expect(group.id).toMatch(/^grp_/);

      const addMemberRaw = await runEve([
        'access',
        'groups',
        'members',
        'add',
        group.id,
        '--org',
        org.id,
        '--user',
        me.user_id,
        '--json',
      ]);
      const addMember = JSON.parse(addMemberRaw) as { principal_type: string; principal_id: string };
      expect(addMember.principal_type).toBe('user');
      expect(addMember.principal_id).toBe(me.user_id);

      await runEve([
        'access',
        'roles',
        'create',
        roleName,
        '--org',
        org.id,
        '--scope',
        'org',
        '--permissions',
        'orgfs:read',
        '--json',
      ]);

      const bindRaw = await runEve([
        'access',
        'bind',
        '--org',
        org.id,
        '--group',
        group.id,
        '--role',
        roleName,
        '--scope-json',
        '{"orgfs":{"allow_prefixes":["/groups/pm/**"]}}',
        '--json',
      ]);
      const binding = JSON.parse(bindRaw) as { principal_type: string; scope_json?: { orgfs?: { allow_prefixes?: string[] } } };
      expect(binding.principal_type).toBe('group');
      expect(binding.scope_json?.orgfs?.allow_prefixes).toContain('/groups/pm/**');

      const membershipsRaw = await runEve([
        'access',
        'memberships',
        '--org',
        org.id,
        '--user',
        me.user_id,
        '--json',
      ]);
      const memberships = JSON.parse(membershipsRaw) as {
        groups: Array<{ id: string }>;
        effective_permissions: string[];
      };
      expect(memberships.groups.some((item) => item.id === group.id)).toBe(true);
      expect(memberships.effective_permissions).toContain('orgfs:read');

      const canAllowedRaw = await runEve([
        'access',
        'can',
        '--org',
        org.id,
        '--user',
        me.user_id,
        '--permission',
        'orgfs:read',
        '--resource-type',
        'orgfs',
        '--resource',
        '/groups/pm/spec.md',
        '--action',
        'read',
        '--json',
      ]);
      const canAllowed = JSON.parse(canAllowedRaw) as { allowed: boolean; resource?: { scope_matched: boolean } };
      expect(canAllowed.allowed).toBe(true);
      expect(canAllowed.resource?.scope_matched).toBe(true);

      const canDeniedRaw = await runEve([
        'access',
        'can',
        '--org',
        org.id,
        '--user',
        me.user_id,
        '--permission',
        'orgfs:read',
        '--resource-type',
        'orgfs',
        '--resource',
        '/groups/eng/spec.md',
        '--action',
        'read',
        '--json',
      ]);
      const canDenied = JSON.parse(canDeniedRaw) as { allowed: boolean; resource?: { scope_matched: boolean } };
      expect(canDenied.allowed).toBe(false);
      expect(canDenied.resource?.scope_matched).toBe(false);
    } finally {
      await deleteOrg(org.id);
    }
  }, 90_000);

  it('supports access policy-as-code v2 validate/plan/sync flow', async () => {
    const orgRaw = await runEve(['org', 'ensure', `AccessPolicyCliOrg${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    const me = await authMe();

    const dir = await mkdtemp(path.join(tmpdir(), 'eve-access-v2-'));
    const filePath = path.join(dir, 'access.yaml');
    const yaml = `version: 2
access:
  groups:
    pm-team:
      name: Product Management
      members:
        - { type: user, id: ${me.user_id} }
  roles:
    pm_docs_reader:
      scope: org
      permissions:
        - orgdocs:read
  bindings:
    - subject: { type: group, id: pm-team }
      roles: [pm_docs_reader]
      scope:
        orgdocs: { allow_prefixes: ["/groups/pm/**"] }
`;
    await writeFile(filePath, yaml, 'utf8');

    try {
      const validateRaw = await runEve([
        'access',
        'validate',
        '--file',
        filePath,
        '--json',
      ]);
      const validate = JSON.parse(validateRaw) as {
        valid: boolean;
        groups: number;
        roles: number;
        members: number;
        bindings: number;
      };
      expect(validate.valid).toBe(true);
      expect(validate.groups).toBe(1);
      expect(validate.roles).toBe(1);
      expect(validate.members).toBe(1);
      expect(validate.bindings).toBe(1);

      const planRaw = await runEve([
        'access',
        'plan',
        '--file',
        filePath,
        '--org',
        org.id,
        '--json',
      ]);
      const plan = JSON.parse(planRaw) as {
        groups: { create: Array<{ slug: string }> };
        roles: { create: Array<{ name: string }> };
        bindings: { create: Array<{ role: string; subject_type: string; subject_id: string }> };
      };
      expect(plan.groups.create).toEqual(
        expect.arrayContaining([expect.objectContaining({ slug: 'pm-team' })]),
      );
      expect(plan.roles.create).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'pm_docs_reader' })]),
      );
      expect(plan.bindings.create).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'pm_docs_reader',
            subject_type: 'group',
            subject_id: 'pm-team',
          }),
        ]),
      );

      const syncRaw = await runEve([
        'access',
        'sync',
        '--file',
        filePath,
        '--org',
        org.id,
        '--yes',
        '--json',
      ]);
      const sync = JSON.parse(syncRaw) as {
        applied: boolean;
        groups_created?: number;
        group_members_added?: number;
        roles_created?: number;
        bindings_created?: number;
      };
      expect(sync.applied).toBe(true);
      expect((sync.groups_created ?? 0) >= 1).toBe(true);
      expect((sync.group_members_added ?? 0) >= 1).toBe(true);
      expect((sync.roles_created ?? 0) >= 1).toBe(true);
      expect((sync.bindings_created ?? 0) >= 1).toBe(true);

      const planAfterRaw = await runEve([
        'access',
        'plan',
        '--file',
        filePath,
        '--org',
        org.id,
        '--json',
      ]);
      const planAfter = JSON.parse(planAfterRaw) as {
        groups: { create: unknown[]; unchanged: number };
        group_members: { add: unknown[]; unchanged: number };
        roles: { create: unknown[]; unchanged: number };
        bindings: { create: unknown[]; replace?: unknown[]; unchanged: number };
      };
      expect(planAfter.groups.create.length).toBe(0);
      expect(planAfter.group_members.add.length).toBe(0);
      expect(planAfter.roles.create.length).toBe(0);
      expect(planAfter.bindings.create.length).toBe(0);
      expect(planAfter.groups.unchanged).toBe(1);
      expect(planAfter.group_members.unchanged).toBe(1);
      expect(planAfter.roles.unchanged).toBe(1);
      expect(planAfter.bindings.unchanged).toBe(1);

      const membershipsRaw = await runEve([
        'access',
        'memberships',
        '--org',
        org.id,
        '--user',
        me.user_id,
        '--json',
      ]);
      const memberships = JSON.parse(membershipsRaw) as {
        groups: Array<{ slug: string }>;
        effective_permissions: string[];
      };
      expect(memberships.groups.some((group) => group.slug === 'pm-team')).toBe(true);
      expect(memberships.effective_permissions).toContain('orgdocs:read');
    } finally {
      await deleteOrg(org.id);
      await rm(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
