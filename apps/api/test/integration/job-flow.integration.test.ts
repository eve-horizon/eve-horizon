import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
// Use the CLI package (runtime commands) not bin/eh (dev helpers)
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
// Use unique project name per test run to avoid stale data issues
const projectName = `integration-flow-${Date.now()}`;
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

describe('integration job flow', () => {
  it('creates project and verifies job CRUD operations', async () => {
    // 1. Ensure org exists
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string; name: string };

    // 2. Ensure project exists
    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const uniqueId = Math.random().toString(36).substring(2, 6);
    const projectSlug = `jf${uniqueId}`;
    const projectRaw = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      projectName,
      '--slug',
      projectSlug,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    // 3. Create a job with the new CLI (description is required, title auto-generated)
    // Use --phase backlog AND a far-future --defer-until: this test transitions the job to
    // 'ready' (step 6), and backlog alone stops protecting once it does. The orchestrator's
    // claim queries exclude deferred jobs, while manual phase updates ignore defer_until, so
    // the CRUD flow stays deterministic instead of racing the orchestrator.
    const jobRaw = await runEve([
      'job',
      'create',
      '--project',
      project.id,
      '--description',
      'Testing job CRUD operations for integration tests',
      '--phase',
      'backlog',
      '--defer-until',
      new Date(Date.now() + 3_600_000).toISOString(),
      '--json',
    ]);
    const job = JSON.parse(jobRaw) as { id: string; phase: string; title: string };

    expect(job.id).toBeTruthy();
    expect(job.phase).toBe('backlog');  // created in backlog to avoid orchestrator pickup
    expect(job.title).toBe('Testing job CRUD operations for integration tests');  // auto-generated from description

    // 4. Verify job shows up in list
    const listRaw = await runEve(['job', 'list', '--project', project.id, '--json']);
    const list = JSON.parse(listRaw) as { jobs: { id: string; title: string }[] };
    const foundJob = list.jobs.find(j => j.id === job.id);

    expect(foundJob).toBeTruthy();
    expect(foundJob?.title).toBe('Testing job CRUD operations for integration tests');

    // 5. Show job details
    const showRaw = await runEve(['job', 'show', job.id, '--json']);
    const shown = JSON.parse(showRaw) as { id: string; phase: string; title: string; description: string };

    expect(shown.id).toBe(job.id);
    expect(shown.phase).toBe('backlog');
    expect(shown.description).toBe('Testing job CRUD operations for integration tests');

    // 6. Update job phase: backlog → ready (valid transition)
    const readyRaw = await runEve(['job', 'update', job.id, '--phase', 'ready', '--json']);
    const readyJob = JSON.parse(readyRaw) as { id: string; phase: string };
    expect(readyJob.phase).toBe('ready');

    // 7. Update job phase: ready → active (valid transition)
    const updateRaw = await runEve(['job', 'update', job.id, '--phase', 'active', '--json']);
    const updated = JSON.parse(updateRaw) as { id: string; phase: string };

    expect(updated.phase).toBe('active');

    // 8. Verify the update persisted
    const verifyRaw = await runEve(['job', 'show', job.id, '--json']);
    const verified = JSON.parse(verifyRaw) as { phase: string };

    expect(verified.phase).toBe('active');

    // 9. Close the job
    const closeRaw = await runEve(['job', 'close', job.id, '--reason', 'Integration test completed', '--json']);
    const closed = JSON.parse(closeRaw) as { phase: string; close_reason: string };

    expect(closed.phase).toBe('done');
    expect(closed.close_reason).toBe('Integration test completed');
  }, 60000); // 1 min timeout for CRUD operations
});
