import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
const projectName = `integration-secrets-${Date.now()}`;
const repoBranch = process.env.EVE_INTEGRATION_REPO_BRANCH || 'main';

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

describe('integration secrets', () => {
  it('creates and reads masked secrets', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      projectName,
      '--slug',
      'IntgSec',
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const setRaw = await runEve([
      'secrets',
      'set',
      'GITHUB_TOKEN',
      'ghp_test_secret_value',
      '--project',
      project.id,
      '--type',
      'github_token',
      '--json',
    ]);
    const setResult = JSON.parse(setRaw) as { key: string; type: string };
    expect(setResult.key).toBe('GITHUB_TOKEN');
    expect(setResult.type).toBe('github_token');

    const listRaw = await runEve(['secrets', 'list', '--project', project.id, '--json']);
    const list = JSON.parse(listRaw) as { data: Array<{ key: string }> };
    expect(list.data.some((item) => item.key === 'GITHUB_TOKEN')).toBe(true);

    const showRaw = await runEve(['secrets', 'show', 'GITHUB_TOKEN', '--project', project.id, '--json']);
    const show = JSON.parse(showRaw) as { masked_value: string };
    expect(show.masked_value).toMatch(/^ghp_\*+alue$/);

    const internalToken = process.env.EVE_INTERNAL_API_KEY || 'test-internal-key';
    const resolveResponse = await fetch(`${apiUrl}/internal/projects/${project.id}/secrets/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eve-internal-token': internalToken,
      },
      body: JSON.stringify({ project_id: project.id }),
    });
    expect(resolveResponse.ok).toBe(true);
    const resolved = await resolveResponse.json() as { data: Array<{ key: string }> };
    expect(resolved.data.some((item) => item.key === 'GITHUB_TOKEN')).toBe(true);
  }, 60000);

  it('resolves secrets by scope priority and masks short values', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `${projectName}-priority`,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const userId = `integration-user-${Date.now()}`;
    const orderedKey = `ORDERED_SECRET_${Date.now()}`;

    await runEve(['secrets', 'set', orderedKey, 'system-value', '--system', '--json']);
    await runEve(['secrets', 'set', orderedKey, 'org-value', '--org', org.id, '--json']);
    await runEve(['secrets', 'set', orderedKey, 'user-value', '--user', userId, '--json']);
    await runEve(['secrets', 'set', orderedKey, 'project-value', '--project', project.id, '--json']);

    const shortKey = `SHORT_SECRET_${Date.now()}`;
    await runEve(['secrets', 'set', shortKey, 'xy', '--system', '--json']);
    const shortMaskedRaw = await runEve(['secrets', 'show', shortKey, '--system', '--json']);
    const shortMasked = JSON.parse(shortMaskedRaw) as { masked_value: string };
    expect(shortMasked.masked_value).toBe('**');

    const internalToken = process.env.EVE_INTERNAL_API_KEY || 'test-internal-key';
    const resolveResponse = await fetch(`${apiUrl}/internal/projects/${project.id}/secrets/resolve`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-eve-internal-token': internalToken,
      },
      body: JSON.stringify({ project_id: project.id, user_id: userId }),
    });
    expect(resolveResponse.ok).toBe(true);
    const resolved = await resolveResponse.json() as { data: Array<{ key: string; value: string }> };
    const ordered = resolved.data.find((item) => item.key === orderedKey);
    expect(ordered?.value).toBe('project-value');
  }, 60000);

  it('validates required secrets by key list', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `${projectName}-validate`,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const key = `VALIDATE_SECRET_${Date.now()}`;
    await runEve(['secrets', 'set', key, 'present', '--project', project.id, '--json']);

    const validateRaw = await runEve([
      'secrets',
      'validate',
      '--project',
      project.id,
      '--keys',
      key,
      '--json',
    ]);
    const validate = JSON.parse(validateRaw) as { missing: Array<{ key: string }> };
    expect(validate.missing.length).toBe(0);
  }, 60000);

  it('ensures and exports safe secrets', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `${projectName}-export`,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const ensureRaw = await runEve([
      'secrets',
      'ensure',
      '--project',
      project.id,
      '--keys',
      'GITHUB_WEBHOOK_SECRET',
      '--json',
    ]);
    const ensure = JSON.parse(ensureRaw) as { created: string[]; existing: string[] };
    expect(ensure.created.length + ensure.existing.length).toBe(1);

    const exportRaw = await runEve([
      'secrets',
      'export',
      '--project',
      project.id,
      '--keys',
      'GITHUB_WEBHOOK_SECRET',
      '--json',
    ]);
    const exported = JSON.parse(exportRaw) as { data: Array<{ key: string; value: string }> };
    expect(exported.data[0]?.key).toBe('GITHUB_WEBHOOK_SECRET');
    expect(exported.data[0]?.value.length).toBeGreaterThan(10);
  }, 60000);

  it('forbids a non-admin from accessing another user\'s secrets', async () => {
    // Regression guard: UserSecretsController must enforce self-or-admin. Bootstrap auth
    // (used by the rest of this suite) is a system admin and bypasses the check, so this
    // test mints a plain member token to exercise the non-admin path.
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    // globalThis.fetch (patched in setup.ts) injects the admin token here because no
    // Authorization header is set — so /auth/mint runs as admin and returns a member token.
    const mintResponse = await fetch(`${apiUrl}/auth/mint`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: `secrets-member-${Date.now()}@example.com`,
        org_id: org.id,
        role: 'member',
      }),
    });
    expect(mintResponse.status).toBeLessThan(300);
    const member = (await mintResponse.json()) as { access_token: string; user_id: string };

    const memberAuth = { Authorization: `Bearer ${member.access_token}`, 'Content-Type': 'application/json' };
    const otherUserId = `victim-user-${Date.now()}`;

    // A member may write their OWN user secret.
    const own = await fetch(`${apiUrl}/users/${member.user_id}/secrets`, {
      method: 'POST',
      headers: memberAuth,
      body: JSON.stringify({ key: `SELF_${Date.now()}`, value: 'self-value' }),
    });
    expect(own.status).toBe(201);

    // A member may NOT write another user's secret.
    const crossWrite = await fetch(`${apiUrl}/users/${otherUserId}/secrets`, {
      method: 'POST',
      headers: memberAuth,
      body: JSON.stringify({ key: `HACK_${Date.now()}`, value: 'stolen' }),
    });
    expect(crossWrite.status).toBe(403);

    // ...nor read another user's secrets.
    const crossRead = await fetch(`${apiUrl}/users/${otherUserId}/secrets`, {
      headers: { Authorization: `Bearer ${member.access_token}` },
    });
    expect(crossRead.status).toBe(403);
  }, 60000);
});
