import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import {
  environmentCostSnapshotQueries,
  type EnvironmentCostSnapshot,
} from './environment-cost-snapshots.js';
import {
  generateEnvironmentCostSnapshotId,
  generateEnvironmentId,
  generateOrgId,
  generateProjectId,
} from '@eve/shared';

const testDbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!testDbUrl) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL environment variable is required for tests');
}

describe('environmentCostSnapshotQueries', () => {
  let db: ReturnType<typeof postgres>;
  let costs: ReturnType<typeof environmentCostSnapshotQueries>;

  const suffix = Math.random().toString(36).slice(2, 8);
  const orgId = generateOrgId();
  const projectId = generateProjectId();
  const envId = generateEnvironmentId();
  const windowStart = new Date('2026-06-01T00:00:00.000Z');
  const firstObservedAt = new Date('2026-06-02T08:00:00.000Z');
  const secondObservedAt = new Date('2026-06-02T09:00:00.000Z');

  beforeAll(async () => {
    db = postgres(testDbUrl);
    costs = environmentCostSnapshotQueries(db);
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db`DELETE FROM projects WHERE id = ${projectId}`;
    await db`DELETE FROM orgs WHERE id = ${orgId}`;
    await db`
      INSERT INTO orgs (id, name, slug)
      VALUES (${orgId}, ${`Cost Test Org ${suffix}`}, ${`ct${suffix}`})
    `;
    await db`
      INSERT INTO projects (id, org_id, name, slug, repo_url, branch)
      VALUES (${projectId}, ${orgId}, ${`Cost Test Project ${suffix}`}, ${`ct${suffix.slice(0, 6)}`}, 'https://example.com/repo.git', 'main')
    `;
    await db`
      INSERT INTO environments (id, project_id, name, type, namespace)
      VALUES (${envId}, ${projectId}, 'prod', 'persistent', ${`eve-ct-${suffix}-prod`})
    `;
  });

  async function upsertEnvironment(amountUsd: string): Promise<EnvironmentCostSnapshot> {
    return costs.upsert({
      id: generateEnvironmentCostSnapshotId(),
      aggregation_key: `env:${envId}`,
      environment_id: envId,
      org_id: orgId,
      project_id: projectId,
      environment_slug: 'prod',
      scope: 'environment',
      source: 'opencost',
      window_start: windowStart,
      window_end: firstObservedAt,
      amount_usd: amountUsd,
      confidence: 'estimate',
      breakdown_json: { name: 'namespace-a' },
      observed_at: firstObservedAt,
    });
  }

  it('upserts shared overhead with null environment_id without duplicate rows', async () => {
    await costs.upsert({
      id: generateEnvironmentCostSnapshotId(),
      aggregation_key: 'shared:platform',
      environment_id: null,
      environment_slug: null,
      scope: 'shared_overhead',
      source: 'opencost',
      window_start: windowStart,
      window_end: firstObservedAt,
      amount_usd: '10.25',
      confidence: 'estimate',
      breakdown_json: { name: '__idle__' },
      observed_at: firstObservedAt,
    });

    const updated = await costs.upsert({
      id: generateEnvironmentCostSnapshotId(),
      aggregation_key: 'shared:platform',
      environment_id: null,
      environment_slug: null,
      scope: 'shared_overhead',
      source: 'opencost',
      window_start: windowStart,
      window_end: secondObservedAt,
      amount_usd: '12.50',
      confidence: 'estimate',
      breakdown_json: { name: '__idle__', updated: true },
      observed_at: secondObservedAt,
    });

    expect(updated.amount_usd).toBe('12.50');
    const rows = await costs.latestForMonth(windowStart, 'opencost');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.scope).toBe('shared_overhead');
    expect(rows[0]?.environment_id).toBeNull();
  });

  it('returns latest rows, totals, and freshness for a month', async () => {
    await upsertEnvironment('21.75');
    await costs.upsert({
      id: generateEnvironmentCostSnapshotId(),
      aggregation_key: 'shared:platform',
      environment_id: null,
      scope: 'shared_overhead',
      source: 'opencost',
      window_start: windowStart,
      window_end: secondObservedAt,
      amount_usd: '8.25',
      confidence: 'estimate',
      breakdown_json: { name: '__unallocated__' },
      observed_at: secondObservedAt,
    });

    const rows = await costs.latestForMonth(windowStart, 'opencost');
    expect(rows.map((row) => row.scope)).toEqual(['environment', 'shared_overhead']);

    const totals = await costs.totalForMonth(windowStart, 'opencost');
    expect(totals).toEqual({
      total_usd: '30.00',
      env_total_usd: '21.75',
      shared_usd: '8.25',
      env_count: 1,
    });

    const freshness = await costs.freshnessForMonth(windowStart, 'opencost');
    expect(freshness.observed_at?.toISOString()).toBe(secondObservedAt.toISOString());
  });
});
