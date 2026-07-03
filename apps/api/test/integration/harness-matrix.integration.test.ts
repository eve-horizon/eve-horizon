import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
// Use unique project name and slug per test run to avoid stale data issues
// Slug must be 4-8 alphanumeric chars starting with a letter
const uniqueId = Math.random().toString(36).substring(2, 6);
const projectName = `integration-matrix-${uniqueId}`;
const projectSlug = `mtx${uniqueId}`;  // 7 chars total (mtx + 4 random)
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

describe('integration harness matrix', () => {
  /**
   * Test job creation with different priorities.
   *
   * The new job model is queue-based - jobs are created in 'ready' phase
   * by default so they're immediately schedulable.
   */
  it('creates jobs with different priorities', async () => {
    // Setup org
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string; name: string };

    // Setup project
    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project', 'ensure',
      '--org', org.id,
      '--name', projectName,
      '--slug', projectSlug,
      '--repo-url', repoUrl,
      '--branch', repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    // Create jobs with different priorities (0-4)
    // Use --phase backlog to prevent the orchestrator from picking up jobs during tests.
    // In k8s mode, the orchestrator would try to execute 'ready' jobs, which would fail
    // because integration tests use file:// URLs that aren't supported in k8s runtime.
    const priorities = [0, 1, 2, 3, 4];
    const createdJobs: Array<{ id: string; priority: number; phase: string }> = [];

    for (const priority of priorities) {
      const jobRaw = await runEve([
        'job', 'create',
        '--project', project.id,
        '--description', `Priority ${priority} test job - testing priority handling`,
        '--priority', String(priority),
        '--phase', 'backlog',
        '--json',
      ]);
      const job = JSON.parse(jobRaw) as { id: string; priority: number; phase: string };
      createdJobs.push(job);

      expect(job.id).toBeTruthy();
      expect(job.priority).toBe(priority);
      expect(job.phase).toBe('backlog');  // created in backlog to avoid orchestrator pickup
    }

    // Verify all jobs appear in list
    const listRaw = await runEve(['job', 'list', '--project', project.id, '--json']);
    const list = JSON.parse(listRaw) as { jobs: Array<{ id: string }> };

    for (const created of createdJobs) {
      const found = list.jobs.find(j => j.id === created.id);
      expect(found, `Job ${created.id} should be in list`).toBeTruthy();
    }
  }, 60000);

  /**
   * Test job phase transitions.
   */
  it('transitions job through phases', async () => {
    // Setup org and project
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project', 'ensure',
      '--org', org.id,
      '--name', `${projectName}P`,  // unique project for phase test
      '--slug', 'IntgPhs',  // explicit unique slug (4-8 chars)
      '--repo-url', repoUrl,
      '--branch', repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    // Create job in backlog phase with a far-future defer_until so the orchestrator
    // never claims it, even after the test moves it to 'ready' (claim queries exclude
    // deferred jobs; manual phase updates and claims ignore defer_until).
    const deferUntil = new Date(Date.now() + 3_600_000).toISOString();
    const jobRaw = await runEve([
      'job', 'create',
      '--project', project.id,
      '--description', 'Phase transition test - testing lifecycle transitions',
      '--phase', 'backlog',
      '--defer-until', deferUntil,
      '--json',
    ]);
    const job = JSON.parse(jobRaw) as { id: string; phase: string };
    expect(job.phase).toBe('backlog');

    // Transition: backlog → ready
    const readyRaw = await runEve([
      'job', 'update', job.id,
      '--phase', 'ready',
      '--json',
    ]);
    const readyJob = JSON.parse(readyRaw) as { phase: string };
    expect(readyJob.phase).toBe('ready');

    // Transition: ready → active
    const activeRaw = await runEve([
      'job', 'update', job.id,
      '--phase', 'active',
      '--json',
    ]);
    const activeJob = JSON.parse(activeRaw) as { phase: string };
    expect(activeJob.phase).toBe('active');

    // Close the job
    const closedRaw = await runEve([
      'job', 'close', job.id,
      '--reason', 'Test completed',
      '--json',
    ]);
    const closedJob = JSON.parse(closedRaw) as { phase: string; close_reason: string };
    expect(closedJob.phase).toBe('done');
    expect(closedJob.close_reason).toBe('Test completed');
  }, 60000);

  /**
   * Test job hierarchy (parent/child jobs).
   */
  it('creates hierarchical jobs', async () => {
    // Setup org and project
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRaw = await runEve([
      'project', 'ensure',
      '--org', org.id,
      '--name', `${projectName}H`,  // unique project for hierarchy test
      '--slug', 'IntgHier',  // explicit unique slug
      '--repo-url', repoUrl,
      '--branch', repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    // Create parent job in backlog phase to avoid orchestrator pickup
    // In k8s mode, 'ready' jobs would be executed and fail on file:// URLs
    const parentRaw = await runEve([
      'job', 'create',
      '--project', project.id,
      '--description', 'Parent job - this is the root of the hierarchy',
      '--phase', 'backlog',
      '--json',
    ]);
    const parent = JSON.parse(parentRaw) as { id: string; depth: number };
    expect(parent.depth).toBe(0);

    // Create child job in backlog phase
    const childRaw = await runEve([
      'job', 'create',
      '--project', project.id,
      '--description', 'Child job - this is a sub-task of the parent',
      '--parent', parent.id,
      '--phase', 'backlog',
      '--json',
    ]);
    const child = JSON.parse(childRaw) as { id: string; parent_id: string; depth: number };
    expect(child.parent_id).toBe(parent.id);
    expect(child.depth).toBe(1);
    expect(child.id).toMatch(new RegExp(`^${parent.id}\\.\\d+$`)); // e.g., parent-id.1

    // View tree
    const treeRaw = await runEve(['job', 'tree', parent.id, '--json']);
    const tree = JSON.parse(treeRaw) as { id: string; children?: Array<{ id: string }> };
    expect(tree.id).toBe(parent.id);
    expect(tree.children).toBeDefined();
    expect(tree.children?.length).toBeGreaterThan(0);
    expect(tree.children?.[0].id).toBe(child.id);
  }, 60000);
});
