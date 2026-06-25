import 'reflect-metadata';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockLatestForMonth = vi.fn();
const mockCloudLatestForScope = vi.fn();
const mockSumSpendByProject = vi.fn();
const mockProjectList = vi.fn();
const mockEnvListActive = vi.fn();
const mockOrgList = vi.fn();

vi.mock('@eve/db', () => ({
  cloudCostSnapshotQueries: vi.fn(() => ({
    latestForScope: mockCloudLatestForScope,
  })),
  environmentCostSnapshotQueries: vi.fn(() => ({
    latestForMonth: mockLatestForMonth,
  })),
  spendQueries: vi.fn(() => ({
    sumSpendByProject: mockSumSpendByProject,
  })),
  projectQueries: vi.fn(() => ({
    list: mockProjectList,
  })),
  environmentQueries: vi.fn(() => ({
    listActive: mockEnvListActive,
  })),
  orgQueries: vi.fn(() => ({
    list: mockOrgList,
  })),
}));

import { AppCostService, allocateAppCosts } from './app-cost.service.js';

const NOW = new Date('2026-06-15T12:00:00Z');

function envSnapshot(overrides: Record<string, unknown>) {
  return {
    id: 'ecs_x',
    aggregation_key: 'env:x',
    environment_id: 'env_a',
    org_id: 'org_1',
    project_id: 'proj_1',
    environment_slug: 'org / proj / production',
    scope: 'environment',
    source: 'opencost',
    window_start: new Date('2026-06-01T00:00:00Z'),
    window_end: new Date('2026-06-15T00:00:00Z'),
    amount_usd: '10',
    shared_amount_usd: null,
    confidence: 'estimate',
    breakdown_json: null,
    observed_at: new Date('2026-06-15T07:00:00Z'),
    ...overrides,
  };
}

describe('allocateAppCosts', () => {
  it('allocates the bill proportionally to opencost weights', () => {
    const result = allocateAppCosts(
      [
        { environment_id: 'env_a', amount_usd: 30 },
        { environment_id: 'env_b', amount_usd: 10 },
      ],
      60, // shared overhead estimate
      200, // bill
    );
    // denominator = 100, factor = 2
    expect(result.method).toBe('bill_allocated_by_opencost');
    expect(result.factor).toBe(2);
    expect(result.byEnvironment.get('env_a')).toBe(60);
    expect(result.byEnvironment.get('env_b')).toBe(20);
    expect(result.platform_overhead_usd).toBe(120);
    // Allocations + overhead reconcile to the bill exactly
    expect(60 + 20 + 120).toBe(200);
  });

  it('passes opencost estimates through when no bill exists', () => {
    const result = allocateAppCosts(
      [{ environment_id: 'env_a', amount_usd: 42.5 }],
      10,
      null,
    );
    expect(result.method).toBe('opencost_direct');
    expect(result.factor).toBeNull();
    expect(result.byEnvironment.get('env_a')).toBe(42.5);
    expect(result.platform_overhead_usd).toBe(10);
  });

  it('treats the whole bill as overhead when there is no usage signal', () => {
    const result = allocateAppCosts([], 0, 150);
    expect(result.platform_overhead_usd).toBe(150);
    expect(result.byEnvironment.size).toBe(0);
  });

  it('clamps negative estimates to zero', () => {
    const result = allocateAppCosts(
      [
        { environment_id: 'env_a', amount_usd: -5 },
        { environment_id: 'env_b', amount_usd: 10 },
      ],
      0,
      20,
    );
    expect(result.byEnvironment.get('env_a')).toBe(0);
    expect(result.byEnvironment.get('env_b')).toBe(20);
  });
});

describe('AppCostService.getAppCosts', () => {
  let service: AppCostService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockLatestForMonth.mockResolvedValue([]);
    mockCloudLatestForScope.mockResolvedValue(null);
    mockSumSpendByProject.mockResolvedValue([]);
    mockProjectList.mockResolvedValue([]);
    mockEnvListActive.mockResolvedValue([]);
    mockOrgList.mockResolvedValue([]);
    service = new AppCostService({} as never);
  });

  it('returns an empty report with method none when no data exists', async () => {
    const report = await service.getAppCosts({ orgId: 'org_1', now: NOW });
    expect(report.method).toBe('none');
    expect(report.apps).toEqual([]);
    expect(report.bill).toBeNull();
    expect(report.totals.total_usd).toBe('0.0000');
    expect(report.infra.stale).toBe(true);
  });

  it('groups environments under apps and merges LLM spend', async () => {
    mockLatestForMonth.mockResolvedValue([
      envSnapshot({ environment_id: 'env_a', project_id: 'proj_1', amount_usd: '30' }),
      envSnapshot({ environment_id: 'env_b', project_id: 'proj_2', amount_usd: '10', aggregation_key: 'env:b' }),
      envSnapshot({
        aggregation_key: 'shared:platform',
        scope: 'shared_overhead',
        environment_id: null,
        org_id: null,
        project_id: null,
        amount_usd: '60',
      }),
    ]);
    mockCloudLatestForScope.mockResolvedValue({
      provider: 'aws',
      source: 'aws_cost_explorer',
      amount: '200',
      projected_amount: '400',
      currency: 'USD',
      confidence: 'estimate',
      coverage: 'complete',
      observed_at: new Date('2026-06-15T07:00:00Z'),
    });
    mockSumSpendByProject.mockResolvedValue([
      { project_id: 'proj_1', org_id: 'org_1', base_total_usd: '5.5', attempts: 12 },
    ]);
    mockProjectList.mockResolvedValue([
      { id: 'proj_1', org_id: 'org_1', name: 'Shop', slug: 'shop' },
      { id: 'proj_2', org_id: 'org_1', name: 'Blog', slug: 'blog' },
    ]);
    mockEnvListActive.mockResolvedValue([
      { id: 'env_a', name: 'production', namespace: 'eve-acme-shop-production' },
      { id: 'env_b', name: 'staging', namespace: 'eve-acme-blog-staging' },
    ]);

    const report = await service.getAppCosts({ orgId: 'org_1', now: NOW });

    expect(report.method).toBe('bill_allocated_by_opencost');
    // Org scope: bill amounts and cluster figures are redacted, provenance kept
    expect(report.bill?.amount).toBeNull();
    expect(report.bill?.provider).toBe('aws');
    expect(report.bill?.coverage).toBe('complete');
    expect(report.infra.allocation_factor).toBe('2.000000');
    expect(report.infra.platform_overhead_usd).toBeNull();
    expect(report.infra.cluster_env_total_usd).toBeNull();

    expect(report.apps).toHaveLength(2);
    const shop = report.apps.find((a) => a.project_id === 'proj_1')!;
    expect(shop.project_name).toBe('Shop');
    expect(shop.cloud_usd).toBe('60.0000');
    expect(shop.llm_usd).toBe('5.5000');
    expect(shop.total_usd).toBe('65.5000');
    expect(shop.environments[0]).toMatchObject({
      environment_id: 'env_a',
      env_name: 'production',
      namespace: 'eve-acme-shop-production',
      opencost_usd: '30.0000',
      cloud_usd: '60.0000',
    });

    // Sorted by total descending: shop (65.5) before blog (20)
    expect(report.apps[0]!.project_id).toBe('proj_1');
    expect(report.totals.cloud_usd).toBe('80.0000');
    expect(report.totals.total_usd).toBe('85.5000');
  });

  it('filters environments to the requested org but allocates cluster-wide', async () => {
    mockLatestForMonth.mockResolvedValue([
      envSnapshot({ environment_id: 'env_a', org_id: 'org_1', project_id: 'proj_1', amount_usd: '25' }),
      envSnapshot({
        environment_id: 'env_other',
        org_id: 'org_2',
        project_id: 'proj_other',
        amount_usd: '75',
        aggregation_key: 'env:other',
      }),
    ]);
    mockCloudLatestForScope.mockResolvedValue({
      provider: 'aws',
      source: 'aws_cost_explorer',
      amount: '300',
      projected_amount: null,
      currency: 'USD',
      confidence: 'reconciled',
      coverage: 'complete',
      observed_at: new Date('2026-06-15T07:00:00Z'),
    });
    mockProjectList.mockResolvedValue([{ id: 'proj_1', org_id: 'org_1', name: 'Shop', slug: 'shop' }]);

    const report = await service.getAppCosts({ orgId: 'org_1', now: NOW });

    // factor = 300 / 100 = 3 → org_1's env gets 75, other org's 225 is not exposed
    expect(report.apps).toHaveLength(1);
    expect(report.apps[0]!.cloud_usd).toBe('75.0000');
    expect(report.apps.some((a) => a.project_id === 'proj_other')).toBe(false);
    expect(report.org_id).toBe('org_1');
  });

  it('includes org labels in the admin (cross-org) report', async () => {
    mockLatestForMonth.mockResolvedValue([
      envSnapshot({ environment_id: 'env_a', org_id: 'org_1', project_id: 'proj_1' }),
      envSnapshot({
        environment_id: 'env_other',
        org_id: 'org_2',
        project_id: 'proj_other',
        aggregation_key: 'env:other',
      }),
    ]);
    mockProjectList.mockResolvedValue([
      { id: 'proj_1', org_id: 'org_1', name: 'Shop', slug: 'shop' },
      { id: 'proj_other', org_id: 'org_2', name: 'Other', slug: 'other' },
    ]);
    mockOrgList.mockResolvedValue([
      { id: 'org_1', slug: 'acme', name: 'Acme' },
      { id: 'org_2', slug: 'globex', name: 'Globex' },
      { id: 'org_3', slug: 'unused', name: 'Unused' },
    ]);

    const report = await service.getAppCosts({ now: NOW });

    expect(report.org_id).toBeNull();
    expect(report.apps).toHaveLength(2);
    expect(report.infra.cluster_env_total_usd).toBe('20.0000');
    expect(report.infra.platform_overhead_usd).toBe('0.0000');
    expect(report.orgs).toEqual([
      { org_id: 'org_1', org_slug: 'acme', org_name: 'Acme' },
      { org_id: 'org_2', org_slug: 'globex', org_name: 'Globex' },
    ]);
  });
});
