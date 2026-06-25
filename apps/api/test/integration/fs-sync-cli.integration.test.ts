import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
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

async function queryAuthMe(): Promise<{ user_id: string }> {
  const response = await fetch(`${apiUrl}/auth/me`);
  if (!response.ok) {
    throw new Error(`auth/me failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { authenticated?: boolean; user_id?: string };
  if (!body.authenticated || !body.user_id) {
    throw new Error('auth/me did not return an authenticated user');
  }
  return { user_id: body.user_id };
}

async function grantOrgFsScope(orgId: string, userId: string): Promise<void> {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const roleName = `orgfs_rw_${unique}`;

  const roleResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/roles`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: roleName,
      scope: 'org',
      permissions: ['orgfs:read', 'orgfs:write'],
    }),
  });
  if (!roleResponse.ok) {
    throw new Error(`Create orgfs role failed: ${roleResponse.status} ${await roleResponse.text()}`);
  }

  const bindResponse = await fetch(`${apiUrl}/orgs/${orgId}/access/bindings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      role_name: roleName,
      principal_type: 'user',
      principal_id: userId,
      scope_json: {
        orgfs: {
          allow_prefixes: ['/**'],
        },
      },
    }),
  });
  if (!bindResponse.ok) {
    throw new Error(`Bind orgfs role failed: ${bindResponse.status} ${await bindResponse.text()}`);
  }
}

describe('integration fs sync cli', () => {
  it('supports init, status, mode, and doctor', async () => {
    const orgRaw = await runEve(['org', 'ensure', `FsSyncCliOrg${Date.now()}`, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    const auth = await queryAuthMe();
    await grantOrgFsScope(org.id, auth.user_id);
    const localPath = await mkdtemp(path.join(tmpdir(), 'eve-fs-sync-cli-'));

    try {
      const initRaw = await runEve([
        'fs',
        'sync',
        'init',
        '--org',
        org.id,
        '--local',
        localPath,
        '--mode',
        'two-way',
        '--json',
      ]);
      const init = JSON.parse(initRaw) as { link: { id: string; mode: string } };
      expect(init.link.id).toMatch(/^fslk_/);
      expect(init.link.mode).toBe('two_way');

      const modeRaw = await runEve([
        'fs',
        'sync',
        'mode',
        '--org',
        org.id,
        '--set',
        'pull-only',
        '--link',
        init.link.id,
        '--json',
      ]);
      const mode = JSON.parse(modeRaw) as { mode: string };
      expect(mode.mode).toBe('pull_only');

      const statusRaw = await runEve(['fs', 'sync', 'status', '--org', org.id, '--json']);
      const status = JSON.parse(statusRaw) as { org_id: string; links: { active: number; paused: number; revoked: number } };
      expect(status.org_id).toBe(org.id);
      expect(status.links.active + status.links.paused + status.links.revoked).toBeGreaterThanOrEqual(1);

      const doctorRaw = await runEve(['fs', 'sync', 'doctor', '--org', org.id, '--json']);
      const doctor = JSON.parse(doctorRaw) as { auth: string; links: number };
      expect(doctor.auth).toBe('ok');
      expect(doctor.links).toBeGreaterThanOrEqual(1);
    } finally {
      await deleteOrg(org.id);
    }
  }, 60_000);
});
