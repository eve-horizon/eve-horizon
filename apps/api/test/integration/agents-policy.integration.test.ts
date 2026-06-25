import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
const projectName = `integration-agents-${Date.now()}`;
const projectSlug = `agt${Math.random().toString(36).substring(2, 6)}`;
const repoBranch = process.env.EVE_INTEGRATION_REPO_BRANCH || 'main';

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;
const gitSha = '1111111111111111111111111111111111111111';

async function runEve(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(eveBin, args, {
    cwd: repoRoot,
    env: { ...process.env, EVE_API_URL: apiUrl },
  });
  return stdout.trim();
}

async function requestJson<T>(requestPath: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiUrl}${requestPath}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Request failed: ${response.status} ${body}`);
  }

  return response.json() as Promise<T>;
}

describe('integration agents policy', () => {
  it('parses x-eve.agents and serves agents endpoint', async () => {
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
      projectSlug,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const project = JSON.parse(projectRaw) as { id: string };

    const manifestYaml = `
services:
  api:
    image: test/api:latest
x-eve:
  defaults:
    harness: mclaude
  agents:
    version: 1
    availability:
      drop_unavailable: true
    profiles:
      primary-orchestrator:
        - harness: mclaude
          model: opus-4.5
          reasoning_effort: high
      primary-reviewer:
        - harness: mclaude
          model: opus-4.5
          reasoning_effort: high
        - harness: codex
          model: gpt-5.2-codex
          reasoning_effort: x-high
`;

    const manifest = await requestJson<{
      id: string;
      parsed_agents: Record<string, unknown> | null;
    }>(`/projects/${project.id}/manifest`, {
      method: 'POST',
      body: JSON.stringify({
        yaml: manifestYaml,
        git_sha: gitSha,
        branch: 'main',
      }),
    });

    expect(manifest.id).toBeTruthy();
    expect(manifest.parsed_agents).toBeTruthy();

    const agentsConfig = await requestJson<{
      project_id: string;
      policy: Record<string, unknown> | null;
      manifest_defaults: Record<string, unknown> | null;
    }>(`/projects/${project.id}/agents`);

    expect(agentsConfig.project_id).toBe(project.id);
    expect(agentsConfig.policy).toBeTruthy();
    expect(agentsConfig.manifest_defaults).toBeTruthy();

    const agentsWithHarnesses = await requestJson<{
      harnesses?: { data: Array<{ name: string; auth: { available: boolean } }> };
    }>(`/projects/${project.id}/agents?include_harnesses=true`);

    expect(agentsWithHarnesses.harnesses?.data?.length).toBeGreaterThan(0);
    const mclaudeEntry = agentsWithHarnesses.harnesses?.data?.find((h) => h.name === 'mclaude');
    expect(mclaudeEntry).toBeTruthy();
    expect(typeof mclaudeEntry?.auth.available).toBe('boolean');
  }, 60_000);
});
