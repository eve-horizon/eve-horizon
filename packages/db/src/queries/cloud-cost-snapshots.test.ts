import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import { cloudCostSnapshotQueries } from './cloud-cost-snapshots.js';

const testDbUrl = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL;

if (!testDbUrl) {
  throw new Error('TEST_DATABASE_URL or DATABASE_URL environment variable is required for tests');
}

describe('cloudCostSnapshotQueries', () => {
  let db: ReturnType<typeof postgres>;
  let costs: ReturnType<typeof cloudCostSnapshotQueries>;

  const scopeKey = `example-cluster-${Math.random().toString(36).slice(2, 8)}`;
  const windowStart = new Date('2026-06-01T00:00:00.000Z');
  const firstObservedAt = new Date('2026-06-04T08:00:00.000Z');
  const secondObservedAt = new Date('2026-06-04T09:00:00.000Z');

  beforeAll(async () => {
    db = postgres(testDbUrl);
    costs = cloudCostSnapshotQueries(db);
  });

  afterAll(async () => {
    await db.end();
  });

  beforeEach(async () => {
    await db`DELETE FROM cloud_cost_snapshots WHERE scope_key = ${scopeKey}`;
  });

  it('generates a ccs id when omitted and upserts by provider/source/scope/month', async () => {
    const created = await costs.upsert({
      provider: 'aws',
      source: 'aws_cost_explorer',
      account_id: '000000000000',
      scope_type: 'cluster',
      scope_key: scopeKey,
      scope_label: 'Example Eve cluster',
      window_start: windowStart,
      window_end: new Date('2026-06-04T00:00:00.000Z'),
      mtd_through: '2026-06-03',
      amount: '23.43',
      projected_amount: '234.30',
      currency: 'USD',
      filter_json: { tags: { Project: 'eve-horizon', Environment: 'staging' } },
      breakdown_json: { by_service: [{ service: 'EKS', amount: 12.5, currency: 'USD' }] },
      observed_at: firstObservedAt,
    });

    expect(created.id).toMatch(/^ccs_/);

    const updated = await costs.upsert({
      provider: 'aws',
      source: 'aws_cost_explorer',
      scope_type: 'cluster',
      scope_key: scopeKey,
      scope_label: 'Eve staging cluster',
      window_start: windowStart,
      window_end: new Date('2026-06-05T00:00:00.000Z'),
      mtd_through: '2026-06-04',
      amount: '31.50',
      projected_amount: '236.25',
      currency: 'USD',
      coverage: 'complete',
      observed_at: secondObservedAt,
    });

    expect(updated.id).toBe(created.id);
    expect(updated.amount).toBe('31.50');
    expect(updated.coverage).toBe('complete');

    const rows = await costs.latestForMonth({ windowStart, provider: 'aws', source: 'aws_cost_explorer' });
    expect(rows.filter((row) => row.scope_key === scopeKey)).toHaveLength(1);
  });

  it('returns latest scope lookup and freshness', async () => {
    await costs.upsert({
      provider: 'aws',
      source: 'aws_cost_explorer',
      scope_type: 'cluster',
      scope_key: scopeKey,
      scope_label: 'Eve staging cluster',
      window_start: windowStart,
      window_end: new Date('2026-06-04T00:00:00.000Z'),
      amount: '23.43',
      currency: 'USD',
      observed_at: firstObservedAt,
    });

    const row = await costs.latestForScope({
      provider: 'aws',
      source: 'aws_cost_explorer',
      scopeType: 'cluster',
      scopeKey,
      windowStart,
    });
    const freshness = await costs.freshnessForScope({
      provider: 'aws',
      source: 'aws_cost_explorer',
      scopeType: 'cluster',
      scopeKey,
      windowStart,
    });

    expect(row?.scope_key).toBe(scopeKey);
    expect(row?.amount).toBe('23.43');
    expect(freshness.observed_at?.toISOString()).toBe(firstObservedAt.toISOString());
  });

  it('keeps provider/source uniqueness independent', async () => {
    await costs.upsert({
      provider: 'aws',
      source: 'aws_cost_explorer',
      scope_type: 'cluster',
      scope_key: scopeKey,
      scope_label: 'Eve staging cluster',
      window_start: windowStart,
      window_end: new Date('2026-06-04T00:00:00.000Z'),
      amount: '23.43',
    });
    await costs.upsert({
      provider: 'gcp',
      source: 'gcp_billing_export',
      scope_type: 'cluster',
      scope_key: scopeKey,
      scope_label: 'Eve staging cluster',
      window_start: windowStart,
      window_end: new Date('2026-06-04T00:00:00.000Z'),
      amount: '10.00',
    });

    const rows = await costs.latestForMonth({ windowStart, scopeType: 'cluster' });
    expect(rows.filter((row) => row.scope_key === scopeKey)).toHaveLength(2);
  });
});
