import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  createDb,
  environmentHealthQueries,
  systemSettingsQueries,
  type HealthIssue,
} from '@eve/db';
import type { AuthMintResponse } from '@eve/shared';

const apiUrl =
  process.env.EVE_API_URL ||
  `http://localhost:${process.env.EVE_API_PORT || '4701'}`;
const databaseUrl =
  process.env.DATABASE_URL ||
  `postgres://${process.env.EVE_DB_USER || 'eve'}:${process.env.EVE_DB_PASSWORD || 'eve'}@localhost:${process.env.EVE_DB_PORT || '4703'}/${process.env.EVE_DB_NAME_TEST || 'eve_test'}`;
const hasDatabaseUrl = Boolean(databaseUrl);
const internalToken = process.env.EVE_INTERNAL_API_KEY || 'test-internal-key';
const repoRoot = path.resolve(process.cwd(), '../..');

const db = databaseUrl ? createDb(databaseUrl) : null;
const healthChecks = db ? environmentHealthQueries(db) : null;
const settings = db ? systemSettingsQueries(db) : null;

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

function buildProjectSlug(prefix: string): string {
  return `${prefix}${randomSuffix()}`.replace(/[^a-z0-9]/g, '').slice(0, 8);
}

function parseJsonField<T>(value: T | string | null | undefined): T | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }
  return value;
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

async function ensureOrg(name: string): Promise<{ id: string; name: string }> {
  return requestJson('/orgs/ensure', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
}

async function ensureProject(orgId: string, name: string, slug: string): Promise<{ id: string; slug: string }> {
  const repoPath = path.resolve(repoRoot, 'tests/fixtures/repos/e2e-project');
  const repoUrl = process.env.EVE_INTEGRATION_REPO_URL || `file://${repoPath}`;

  return requestJson('/projects/ensure', {
    method: 'POST',
    body: JSON.stringify({
      org_id: orgId,
      name,
      slug,
      repo_url: repoUrl,
      branch: process.env.EVE_INTEGRATION_REPO_BRANCH || 'main',
    }),
  });
}

async function createEnvironment(projectId: string, name: string): Promise<{ id: string; name: string }> {
  return requestJson(`/projects/${projectId}/envs`, {
    method: 'POST',
    body: JSON.stringify({
      name,
      type: 'persistent',
      overrides: {},
    }),
  });
}

async function deleteProject(projectId: string): Promise<void> {
  await fetch(`${apiUrl}/projects/${projectId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleted: true }),
  });
}

async function deleteOrg(orgId: string): Promise<void> {
  await fetch(`${apiUrl}/orgs/${orgId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deleted: true }),
  });
}

async function mintMemberToken(orgId: string): Promise<string> {
  const result = await requestJson<AuthMintResponse>('/auth/mint', {
    method: 'POST',
    body: JSON.stringify({
      email: `sentinel-member-${Date.now()}-${randomSuffix()}@example.com`,
      org_id: orgId,
      role: 'member',
    }),
  });
  return result.access_token;
}

describe.skipIf(!hasDatabaseUrl)('integration sentinel', () => {
  let orgId = '';
  let projectId = '';
  let environmentId = '';
  let environmentSlug = '';

  beforeEach(async () => {
    if (!healthChecks) {
      throw new Error('DATABASE_URL is required');
    }

    const suffix = randomSuffix();
    const org = await ensureOrg(`SentinelOrg${suffix}`);
    orgId = org.id;

    const projectSlug = buildProjectSlug('sntl');
    const project = await ensureProject(orgId, `SentinelProj${suffix}`, projectSlug);
    projectId = project.id;

    const environment = await createEnvironment(projectId, 'test');
    environmentId = environment.id;
    environmentSlug = `${orgId}/${projectSlug}/test`;

    const issues: HealthIssue[] = [
      {
        type: 'crash_loop_backoff',
        pod: `sentinel-crash-${suffix}`,
        restarts: 12,
        reason: 'CrashLoopBackOff',
      },
    ];

    await healthChecks.upsert({
      environment_id: environmentId,
      project_id: projectId,
      org_id: orgId,
      environment_slug: environmentSlug,
      status: 'critical',
      issue_signature: 'crash_loop_backoff',
      issues_json: issues,
      pod_count: 1,
      healthy_pod_count: 0,
      degraded_since: new Date(Date.now() - 5 * 60 * 1000),
      consecutive_degraded_ticks: 3,
      actions_taken_json: [
        {
          type: 'scale_to_zero',
          deployment: `sentinel-crash-${suffix}`,
          at: new Date().toISOString(),
        },
      ],
    });
  });

  afterEach(async () => {
    if (healthChecks && environmentId) {
      await healthChecks.deleteByEnvironmentId(environmentId).catch(() => {});
    }
    if (settings) {
      await Promise.all([
        settings.delete('sentinel.enabled'),
        settings.delete('sentinel.slack.integration_id'),
        settings.delete('sentinel.slack.channel_id'),
      ]).catch(() => {});
    }
    if (projectId) {
      await deleteProject(projectId).catch(() => {});
    }
    if (orgId) {
      await deleteOrg(orgId).catch(() => {});
    }

    orgId = '';
    projectId = '';
    environmentId = '';
    environmentSlug = '';
  });

  afterAll(async () => {
    await db?.end();
  });

  it('returns environment health summary for system admins', async () => {
    const response = await requestJson<{
      summary: { total: number; healthy: number; degraded: number; critical: number };
      environments: Array<{
        environment_id: string;
        environment_slug: string;
        status: string;
        issues_json: HealthIssue[] | string | null;
        consecutive_degraded_ticks: number;
      }>;
    }>('/system/env-health?status=critical&limit=10');

    expect(response.summary.total).toBeGreaterThanOrEqual(1);
    expect(response.summary.critical).toBeGreaterThanOrEqual(1);

    const entry = response.environments.find((item) => item.environment_id === environmentId);
    const issues = parseJsonField<HealthIssue[]>(entry?.issues_json);
    expect(entry?.environment_slug).toBe(environmentSlug);
    expect(entry?.status).toBe('critical');
    expect(entry?.consecutive_degraded_ticks).toBe(3);
    expect(issues?.[0]?.type).toBe('crash_loop_backoff');
  });

  it('returns 403 for non-system-admin env-health access', async () => {
    const memberToken = await mintMemberToken(orgId);

    const response = await fetch(`${apiUrl}/system/env-health`, {
      headers: {
        Authorization: `Bearer ${memberToken}`,
      },
    });

    expect(response.status).toBe(403);
  });

  it('accepts platform-notify with a valid internal token', async () => {
    const response = await fetch(`${apiUrl}/internal/platform-notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eve-internal-token': internalToken,
      },
      body: JSON.stringify({
        severity: 'critical',
        type: 'env.health.critical',
        environment: {
          org_slug: 'sentinel-org',
          project_slug: 'sentinel-proj',
          env_name: 'test',
          environment_id: environmentId,
        },
        issues: [
          {
            type: 'crash_loop_backoff',
            pod: 'sentinel-crash',
            restarts: 12,
          },
        ],
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { delivered: boolean; reason?: string };
    expect(body.delivered).toBe(false);
    expect(body.reason).toBe('sentinel disabled');
  });

  it('returns 401 for platform-notify without the internal token', async () => {
    const response = await fetch(`${apiUrl}/internal/platform-notify`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        severity: 'critical',
        type: 'env.health.critical',
      }),
    });

    expect(response.status).toBe(401);
  });

  it('accepts platform-respond with a valid internal token', async () => {
    const response = await fetch(`${apiUrl}/internal/platform-respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-eve-internal-token': internalToken,
      },
      body: JSON.stringify({
        text: 'degraded',
        channel_id: 'C123TEST',
        thread_ts: '1234.5678',
      }),
    });

    expect(response.status).toBe(200);
    const body = await response.json() as { text: string };
    expect(body.text).toContain('Degraded & Critical Environments');
    expect(body.text).toContain(environmentSlug);
    expect(body.text).toContain('crash_loop_backoff');
  });

  it('returns 401 for platform-respond without the internal token', async () => {
    const response = await fetch(`${apiUrl}/internal/platform-respond`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        text: 'health',
      }),
    });

    expect(response.status).toBe(401);
  });

  it('stores and reads sentinel system settings', async () => {
    const values = {
      'sentinel.enabled': 'true',
      'sentinel.slack.integration_id': `int_${randomSuffix()}`,
      'sentinel.slack.channel_id': `C${Date.now()}`,
    } as const;

    for (const [key, value] of Object.entries(values)) {
      const response = await fetch(`${apiUrl}/system/settings/${key}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ value }),
      });

      expect(response.status).toBe(200);
    }

    const enabled = await requestJson<{ key: string; value: string }>('/system/settings/sentinel.enabled');
    const integration = await requestJson<{ key: string; value: string }>('/system/settings/sentinel.slack.integration_id');
    const channel = await requestJson<{ key: string; value: string }>('/system/settings/sentinel.slack.channel_id');

    expect(enabled.value).toBe(values['sentinel.enabled']);
    expect(integration.value).toBe(values['sentinel.slack.integration_id']);
    expect(channel.value).toBe(values['sentinel.slack.channel_id']);
  });
});
