import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
// Use the CLI package (runtime commands) not bin/eh (dev helpers)
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
const repoBranch = process.env.EVE_INTEGRATION_REPO_BRANCH || 'main';

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;
const deferUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();

async function runEve(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    cwd: repoRoot,
    env: { ...process.env, EVE_API_URL: apiUrl },
  });
  return stdout.trim();
}

async function createProject(org: { id: string }, slugPrefix: string): Promise<{ id: string }> {
  const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
  const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;
  const uniqueId = Math.random().toString(36).substring(2, 5);
  const projectSlug = `${slugPrefix}${uniqueId}`;
  const projectName = `${slugPrefix}-test-${Date.now()}`;

  const raw = await runEve([
    'project', 'ensure',
    '--org', org.id,
    '--name', projectName,
    '--slug', projectSlug,
    '--repo-url', repoUrl,
    '--branch', repoBranch,
    '--force', '--json',
  ]);
  return JSON.parse(raw) as { id: string };
}

async function createJob(
  projectId: string,
  description: string,
  extra: string[] = [],
): Promise<{ id: string; env_name: string | null; blocked_on_gates: string[] }> {
  const raw = await runEve([
    'job', 'create',
    '--project', projectId,
    '--description', description,
    '--defer-until', deferUntil,
    '--phase', 'ready',
    '--json',
    ...extra,
  ]);
  return JSON.parse(raw);
}

async function claimJob(jobId: string, agentId: string): Promise<Response> {
  return fetch(`${apiUrl}/jobs/${jobId}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, harness: 'mclaude' }),
  });
}

async function releaseJob(jobId: string, agentId: string): Promise<void> {
  await fetch(`${apiUrl}/jobs/${jobId}/release`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent_id: agentId, reason: 'Test cleanup' }),
  });
}

describe('integration job environment gates', () => {
  it('explicit hint gates prevent concurrent claims', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    const project = await createProject(org, 'gate');

    // Create two jobs with the same explicit gate (simulates what action jobs get)
    const gate = `test:${project.id}:mutex`;
    const job1 = await createJob(project.id, 'First gated job', ['--hint', `gates=${gate}`]);
    const job2 = await createJob(project.id, 'Second gated job', ['--hint', `gates=${gate}`]);

    // Claim first — should succeed
    const claim1 = await claimJob(job1.id, 'agent-1');
    expect(claim1.ok).toBe(true);

    // Claim second — should be blocked by the gate
    const claim2 = await claimJob(job2.id, 'agent-2');
    expect(claim2.status).toBe(409);
    const claim2Body = await claim2.json() as { message: string; blocked_on_gates: string[] };
    expect(claim2Body.message).toContain('blocked on gates');
    expect(claim2Body.blocked_on_gates).toContain(gate);

    // Release first, then second should succeed
    await releaseJob(job1.id, 'agent-1');

    const claim2Retry = await claimJob(job2.id, 'agent-2');
    expect(claim2Retry.ok).toBe(true);

    await releaseJob(job2.id, 'agent-2');
  }, 90000);

  it('allows concurrent jobs to different environments', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    const project = await createProject(org, 'mult');

    const jobStaging = await createJob(project.id, 'Staging job', ['--env', 'staging']);
    const jobProd = await createJob(project.id, 'Production job', ['--env', 'production']);

    // Both should succeed — different envs, and ad-hoc jobs don't gate
    const claimStaging = await claimJob(jobStaging.id, 'staging-agent');
    const claimProd = await claimJob(jobProd.id, 'prod-agent');

    expect(claimStaging.ok).toBe(true);
    expect(claimProd.ok).toBe(true);

    await releaseJob(jobStaging.id, 'staging-agent');
    await releaseJob(jobProd.id, 'prod-agent');
  }, 90000);

  it('ad-hoc jobs with same env_name do NOT acquire environment gate', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    const project = await createProject(org, 'noga');

    // Two ad-hoc agent jobs both targeting 'sandbox' — the exact scenario from
    // the DeckBld incident where defaults.env caused global serialization
    const job1 = await createJob(project.id, 'Research task', ['--env', 'sandbox']);
    const job2 = await createJob(project.id, 'Planning task', ['--env', 'sandbox']);

    expect(job1.env_name).toBe('sandbox');
    expect(job2.env_name).toBe('sandbox');

    // Both claims should succeed concurrently — no gate for ad-hoc jobs
    const claim1 = await claimJob(job1.id, 'agent-1');
    expect(claim1.ok).toBe(true);

    const claim2 = await claimJob(job2.id, 'agent-2');
    expect(claim2.ok).toBe(true);

    // Verify both are active
    const job1Show = JSON.parse(await runEve(['job', 'show', job1.id, '--json'])) as { phase: string };
    const job2Show = JSON.parse(await runEve(['job', 'show', job2.id, '--json'])) as { phase: string };
    expect(job1Show.phase).toBe('active');
    expect(job2Show.phase).toBe('active');

    await releaseJob(job1.id, 'agent-1');
    await releaseJob(job2.id, 'agent-2');
  }, 90000);
});
