import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const repoRoot = path.resolve(process.cwd(), '../..');
const eveBin = path.join(repoRoot, 'packages', 'cli', 'bin', 'eve.js');

const orgNameOrId = process.env.EVE_INTEGRATION_ORG || 'default-test-org';
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

async function requestAllowError(requestPath: string, init?: RequestInit): Promise<Response> {
  return fetch(`${apiUrl}${requestPath}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers || {}),
    },
  });
}

async function ensureProject(name: string, slug: string): Promise<{ id: string }> {
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
    name,
    '--slug',
    slug,
    '--repo-url',
    repoUrl,
    '--branch',
    repoBranch,
    '--force',
    '--json',
  ]);
  return JSON.parse(projectRaw) as { id: string };
}

async function queryAuthMe(): Promise<{ user_id: string }> {
  const response = await requestAllowError('/auth/me');
  if (!response.ok) {
    throw new Error(`auth/me failed: ${response.status} ${await response.text()}`);
  }
  const body = (await response.json()) as { authenticated?: boolean; user_id?: string };
  if (!body.authenticated || !body.user_id) {
    throw new Error('auth/me did not return an authenticated user');
  }
  return { user_id: body.user_id };
}

async function grantAgentMemoryScope(orgId: string, userId: string): Promise<void> {
  const unique = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const roleName = `agent_memory_${unique}`;

  const roleResponse = await requestAllowError(`/orgs/${orgId}/access/roles`, {
    method: 'POST',
    body: JSON.stringify({
      name: roleName,
      scope: 'org',
      permissions: ['orgdocs:read', 'orgdocs:write'],
      description: 'Agent memory integration scope role',
    }),
  });
  if (!roleResponse.ok) {
    throw new Error(`Create role failed: ${roleResponse.status} ${await roleResponse.text()}`);
  }

  const bindResponse = await requestAllowError(`/orgs/${orgId}/access/bindings`, {
    method: 'POST',
    body: JSON.stringify({
      role_name: roleName,
      principal_type: 'user',
      principal_id: userId,
      scope_json: {
        orgdocs: {
          allow_prefixes: ['/agents/**', '/knowledge/**'],
        },
      },
    }),
  });
  if (!bindResponse.ok) {
    throw new Error(`Bind role failed: ${bindResponse.status} ${await bindResponse.text()}`);
  }
}

describe('agent memory platform integration', () => {
  it('supports memory + kv + lifecycle + unified search + thread distillation', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    await ensureProject(`integration-memory-${Date.now()}`, `mem${suffix.slice(0, 4)}`);
    const me = await queryAuthMe();
    await grantAgentMemoryScope(org.id, me.user_id);

    const memoryKey = `auth-retry-${suffix}`;
    const stalePath = `/agents/shared/memory/context/stale-${suffix}.md`;
    const docsPath = `/knowledge/doc-${suffix}.md`;
    const threadKey = `agent-memory-${suffix}`;
    const tokenMemory = `tok-memory-${suffix}`;
    const tokenDocs = `tok-docs-${suffix}`;
    const tokenThread = `tok-thread-${suffix}`;

    const memory = await requestJson<{
      id: string;
      path: string;
      metadata: Record<string, unknown>;
    }>(`/orgs/${org.id}/agents/reviewer/memory`, {
      method: 'POST',
      body: JSON.stringify({
        category: 'learnings',
        key: memoryKey,
        content: `Memory about retries ${tokenMemory}`,
        tags: ['auth', 'retry'],
        confidence: 0.9,
      }),
    });
    expect(memory.id).toBeTruthy();
    expect(memory.path).toContain(`/agents/reviewer/memory/learnings/${memoryKey}.md`);
    expect(memory.metadata).toBeTruthy();

    const listed = await requestJson<{ documents: Array<{ path: string }> }>(
      `/orgs/${org.id}/agents/reviewer/memory?category=learnings`,
    );
    expect(listed.documents.some((doc) => doc.path.endsWith(`${memoryKey}.md`))).toBe(true);

    const got = await requestJson<{ path: string; content: string }>(
      `/orgs/${org.id}/agents/reviewer/memory/${encodeURIComponent(memoryKey)}?category=learnings`,
    );
    expect(got.path.endsWith(`${memoryKey}.md`)).toBe(true);
    expect(got.content).toContain(tokenMemory);

    const kvSet = await requestJson<{ key: string; namespace: string; value: unknown }>(
      `/orgs/${org.id}/agents/reviewer/kv/default/last_commit`,
      {
        method: 'PUT',
        body: JSON.stringify({
          value: 'abc123',
          ttl_seconds: 600,
        }),
      },
    );
    expect(kvSet.key).toBe('last_commit');
    expect(kvSet.namespace).toBe('default');
    expect(kvSet.value).toBe('abc123');

    const kvGet = await requestJson<{ value: unknown }>(
      `/orgs/${org.id}/agents/reviewer/kv/default/last_commit`,
    );
    expect(kvGet.value).toBe('abc123');

    const kvMget = await requestJson<{ entries: Array<{ key: string }> }>(
      `/orgs/${org.id}/agents/reviewer/kv/default/mget`,
      {
        method: 'POST',
        body: JSON.stringify({ keys: ['last_commit'] }),
      },
    );
    expect(kvMget.entries.map((entry) => entry.key)).toContain('last_commit');

    const pastReview = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
    await requestJson(`/orgs/${org.id}/docs`, {
      method: 'POST',
      body: JSON.stringify({
        path: stalePath,
        content: `Lifecycle doc ${tokenDocs}`,
        review_due: pastReview,
      }),
    });
    await requestJson(`/orgs/${org.id}/docs`, {
      method: 'POST',
      body: JSON.stringify({
        path: docsPath,
        content: `Knowledge doc ${tokenDocs}`,
      }),
    });

    const stale = await requestJson<{ documents: Array<{ path: string }> }>(
      `/orgs/${org.id}/docs/stale?overdue_by=12h`,
    );
    expect(stale.documents.some((doc) => doc.path === stalePath)).toBe(true);

    const nextReview = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
    const reviewed = await requestJson<{ path: string; review_due: string | null }>(
      `/orgs/${org.id}/docs/review?path=${encodeURIComponent(stalePath)}`,
      {
        method: 'POST',
        body: JSON.stringify({ next_review: nextReview }),
      },
    );
    expect(reviewed.path).toBe(stalePath);
    expect(reviewed.review_due).toBeTruthy();

    const staleAfterReview = await requestJson<{ documents: Array<{ path: string }> }>(
      `/orgs/${org.id}/docs/stale?overdue_by=12h`,
    );
    expect(staleAfterReview.documents.some((doc) => doc.path === stalePath)).toBe(false);

    const orgThread = await requestJson<{ id: string }>(`/orgs/${org.id}/threads`, {
      method: 'POST',
      body: JSON.stringify({ key: threadKey }),
    });
    expect(orgThread.id).toBeTruthy();

    await requestJson(`/orgs/${org.id}/threads/${orgThread.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        direction: 'inbound',
        actor_type: 'user',
        actor_id: 'integration-user',
        body: `Discussing rollout and retries ${tokenThread}`,
      }),
    });

    const searchMemory = await requestJson<{ data: Array<{ source: string }> }>(
      `/orgs/${org.id}/search?q=${encodeURIComponent(tokenMemory)}&sources=memory,docs,threads`,
    );
    expect(searchMemory.data.some((row) => row.source === 'memory')).toBe(true);

    const searchDocs = await requestJson<{ data: Array<{ source: string }> }>(
      `/orgs/${org.id}/search?q=${encodeURIComponent(tokenDocs)}&sources=memory,docs,threads`,
    );
    expect(searchDocs.data.some((row) => row.source === 'docs')).toBe(true);

    const searchThreads = await requestJson<{ data: Array<{ source: string }> }>(
      `/orgs/${org.id}/search?q=${encodeURIComponent(tokenThread)}&sources=memory,docs,threads`,
    );
    expect(searchThreads.data.some((row) => row.source === 'threads')).toBe(true);

    const distilled = await requestJson<{
      status: string;
      path: string;
      message_count: number;
    }>(`/orgs/${org.id}/threads/${orgThread.id}/distill`, {
      method: 'POST',
      body: JSON.stringify({
        agent: 'reviewer',
        category: 'decisions',
        key: `distill-${suffix}`,
      }),
    });
    expect(distilled.status).toBe('ok');
    expect(distilled.path).toContain(`/agents/reviewer/memory/decisions/distill-${suffix}.md`);
    expect(distilled.message_count).toBeGreaterThan(0);

    const distilledDoc = await requestJson<{ content: string }>(
      `/orgs/${org.id}/docs/by-path?path=${encodeURIComponent(distilled.path)}`,
    );
    expect(distilledDoc.content).toContain('# Thread Distillation');

    const threadAfter = await requestJson<{ summary: string | null }>(
      `/orgs/${org.id}/threads/${orgThread.id}`,
    );
    expect(threadAfter.summary).toContain('Distilled');

    const kvDelete = await requestJson<{ success: boolean }>(
      `/orgs/${org.id}/agents/reviewer/kv/default/last_commit`,
      { method: 'DELETE' },
    );
    expect(kvDelete.success).toBe(true);

    const kvGone = await requestAllowError(`/orgs/${org.id}/agents/reviewer/kv/default/last_commit`);
    expect(kvGone.status).toBe(404);
  }, 120_000);

  it('propagates agent context hints into routed job hints', async () => {
    const suffix = Math.random().toString(36).slice(2, 8);
    const uniqueSlug = `code-reviewer-${suffix.slice(0, 4)}`;
    const orgRaw = await runEve(['org', 'ensure', orgNameOrId, '--json']);
    const org = JSON.parse(orgRaw) as { id: string };
    const project = await ensureProject(`integration-context-${Date.now()}`, `ctx${suffix.slice(0, 4)}`);

    const agentsYaml = `
version: 1
agents:
  reviewer:
    slug: ${uniqueSlug}
    skill: eve-reviewer
    workflow: assistant
    context:
      memory:
        categories: [learnings, decisions]
        max_items: 5
        max_age: 30d
      docs:
        - path: /agents/shared/memory/conventions/
          recursive: true
      parent_attachments:
        names: [plan.md]
      threads:
        coordination: true
        max_messages: 15
`;

    const teamsYaml = `
version: 1
teams: {}
`;

    const chatYaml = `
version: 1
default_route: route_default
routes:
  - id: route_default
    match: ".*"
    target: agent:reviewer
`;

    await requestJson(`/projects/${project.id}/agents/sync`, {
      method: 'POST',
      body: JSON.stringify({
        agents_yaml: agentsYaml,
        teams_yaml: teamsYaml,
        chat_yaml: chatYaml,
        git_sha: '1111111111111111111111111111111111111111',
        branch: 'main',
      }),
    });

    const routed = await requestJson<{ job_ids: string[] }>(`/projects/${project.id}/chat/route`, {
      method: 'POST',
      body: JSON.stringify({
        provider: 'slack',
        account_id: 'T111',
        channel_id: 'C123',
        user_id: 'U999',
        text: 'hydrate context for reviewer',
      }),
    });
    expect(routed.job_ids.length).toBe(1);

    const job = await requestJson<{
      hints?: {
        agent_context?: {
          agent_slug?: string;
          memory?: { categories?: string[]; max_items?: number; max_age?: string };
          docs?: Array<{ path: string; recursive?: boolean }>;
          parent_attachments?: { names?: string[] };
          threads?: { coordination?: boolean; max_messages?: number };
        };
      };
    }>(`/jobs/${routed.job_ids[0]}`);

    expect(job.hints?.agent_context?.agent_slug).toBe(uniqueSlug);
    expect(job.hints?.agent_context?.memory?.categories).toEqual(['learnings', 'decisions']);
    expect(job.hints?.agent_context?.memory?.max_items).toBe(5);
    expect(job.hints?.agent_context?.memory?.max_age).toBe('30d');
    expect(job.hints?.agent_context?.docs?.[0]?.path).toBe('/agents/shared/memory/conventions/');
    expect(job.hints?.agent_context?.threads?.coordination).toBe(true);
    expect(job.hints?.agent_context?.threads?.max_messages).toBe(15);
    expect(job.hints?.agent_context?.parent_attachments?.names).toEqual(['plan.md']);
  }, 90_000);
});
