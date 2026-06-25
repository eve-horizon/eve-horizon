import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
const projectName = `integration-agent-sync-${Date.now()}`;
const projectSlug = `ags${Math.random().toString(36).substring(2, 6)}`;
const repoBranch = process.env.EVE_INTEGRATION_REPO_BRANCH || 'main';

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;
const gitSha = '1111111111111111111111111111111111111111';

function buildAgentSlug(prefix: string): string {
  const suffix = Math.random().toString(36).substring(2, 5);
  const base = `${prefix}${suffix}`.toLowerCase().replace(/[^a-z0-9]/g, '');
  const trimmed = base.slice(0, 8);
  if (trimmed.length >= 4) {
    return trimmed;
  }
  return `${trimmed}a`.slice(0, 4);
}

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

describe('integration agent config sync', () => {
  it('syncs agents, teams, and routes and exposes project endpoints', async () => {
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

    const agentsYaml = `
version: 1
agents:
  mission_control:
    skill: eve-mission-control
    workflow: assistant
    harness_profile: primary-orchestrator
  reviewer:
    skill: eve-reviewer
    workflow: review
`;

    const teamsYaml = `
version: 1
teams:
  ops:
    lead: mission_control
    members: [reviewer]
    dispatch:
      mode: fanout
`;

    const chatYaml = `
version: 1
default_route: route_default
routes:
  - id: route_default
    match: ".*"
    target: team:ops
`;

    const syncResponse = await requestJson<{
      id: string;
      parsed_agents: Record<string, unknown> | null;
      parsed_teams: Record<string, unknown> | null;
      parsed_routes: Array<Record<string, unknown>> | null;
    }>(`/projects/${project.id}/agents/sync`, {
      method: 'POST',
      body: JSON.stringify({
        agents_yaml: agentsYaml,
        teams_yaml: teamsYaml,
        chat_yaml: chatYaml,
        git_sha: gitSha,
        branch: 'main',
      }),
    });

    expect(syncResponse.id).toBeTruthy();
    expect(syncResponse.parsed_agents).toBeTruthy();
    expect(syncResponse.parsed_teams).toBeTruthy();
    expect(syncResponse.parsed_routes?.length).toBe(1);

    const agentsConfig = await requestJson<{
      agents?: Array<{ id: string }>;
    }>(`/projects/${project.id}/agents`);

    expect(agentsConfig.agents?.length).toBe(2);

    const teams = await requestJson<{
      teams: Array<{ id: string; members: string[] }>;
    }>(`/projects/${project.id}/teams`);
    expect(teams.teams.length).toBe(1);
    expect(teams.teams[0].members.length).toBeGreaterThan(0);

    const routes = await requestJson<{
      routes: Array<{ id: string; target: string }>;
    }>(`/projects/${project.id}/routes`);
    expect(routes.routes.length).toBe(1);
    expect(routes.routes[0].target).toContain('team:');

    const threads = await requestJson<{ threads: Array<{ id: string }> }>(
      `/projects/${project.id}/threads`
    );
    expect(Array.isArray(threads.threads)).toBe(true);

    const schedules = await requestJson<{ schedules: Array<{ id: string }> }>(
      `/projects/${project.id}/schedules`
    );
    expect(Array.isArray(schedules.schedules)).toBe(true);
  }, 60_000);

  it('rejects duplicate agent slugs across org', async () => {
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };

    const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
    const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

    const projectRawA = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `${projectName}-a`,
      '--slug',
      `agsa${Math.random().toString(36).substring(2, 4)}`,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const projectA = JSON.parse(projectRawA) as { id: string };

    const projectRawB = await runEve([
      'project',
      'ensure',
      '--org',
      org.id,
      '--name',
      `${projectName}-b`,
      '--slug',
      `agsb${Math.random().toString(36).substring(2, 4)}`,
      '--repo-url',
      repoUrl,
      '--branch',
      repoBranch,
      '--force',
      '--json',
    ]);
    const projectB = JSON.parse(projectRawB) as { id: string };

    const duplicateSlug = buildAgentSlug('dup');

    const agentsYaml = `
version: 1
agents:
  mission_control:
    slug: ${duplicateSlug}
    skill: eve-mission-control
    workflow: assistant
`;

    const teamsYaml = `
version: 1
teams:
  ops:
    lead: mission_control
`;

    const chatYaml = `
version: 1
routes: []
`;

    await requestJson(`/projects/${projectA.id}/agents/sync`, {
      method: 'POST',
      body: JSON.stringify({
        agents_yaml: agentsYaml,
        teams_yaml: teamsYaml,
        chat_yaml: chatYaml,
        git_sha: gitSha,
        branch: 'main',
      }),
    });

    let failed = false;
    try {
      await requestJson(`/projects/${projectB.id}/agents/sync`, {
        method: 'POST',
        body: JSON.stringify({
          agents_yaml: agentsYaml,
          teams_yaml: teamsYaml,
          chat_yaml: chatYaml,
          git_sha: gitSha,
          branch: 'main',
        }),
      });
    } catch (error) {
      failed = true;
      const message = error instanceof Error ? error.message : String(error);
      expect(message).toContain(`Agent slug ${duplicateSlug} already used`);
    }
    expect(failed).toBe(true);
  }, 60_000);
});
