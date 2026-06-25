import 'reflect-metadata';
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PERMISSION_KEY } from '../auth/permission.decorator.js';

const mockLatestForMonth = vi.fn();
const mockTotalForMonth = vi.fn();
const mockFreshnessForMonth = vi.fn();
const mockCloudLatestForScope = vi.fn();

vi.mock('@eve/db', () => ({
  cloudCostSnapshotQueries: vi.fn(() => ({
    latestForScope: mockCloudLatestForScope,
  })),
  environmentCostSnapshotQueries: vi.fn(() => ({
    latestForMonth: mockLatestForMonth,
    totalForMonth: mockTotalForMonth,
    freshnessForMonth: mockFreshnessForMonth,
  })),
}));

import { CostController } from './cost.controller.js';
import { CostService, parseUtcMonth, utcMonthStart } from './cost.service.js';

describe('CostService', () => {
  let service: CostService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockCloudLatestForScope.mockResolvedValue(null);
    service = new CostService({} as never);
  });

  it('rejects invalid month values', () => {
    expect(() => parseUtcMonth('2026')).toThrow(BadRequestException);
    expect(() => parseUtcMonth('2026-13')).toThrow(BadRequestException);
  });

  it('defaults to the current UTC month', async () => {
    mockLatestForMonth.mockResolvedValue([]);
    mockTotalForMonth.mockResolvedValue({
      total_usd: '0',
      env_total_usd: '0',
      shared_usd: '0',
      env_count: 0,
    });
    mockFreshnessForMonth.mockResolvedValue({ observed_at: null });

    await service.listEnvironmentCosts({ now: new Date('2026-06-15T12:00:00Z') });

    expect(mockLatestForMonth).toHaveBeenCalledWith(new Date('2026-06-01T00:00:00.000Z'), 'opencost');
  });

  it('returns ordered rows and stale freshness metadata', async () => {
    mockLatestForMonth.mockResolvedValue([
      {
        environment_id: 'env_a',
        org_id: 'org_a',
        project_id: 'proj_a',
        environment_slug: 'prod',
        scope: 'environment',
        source: 'opencost',
        window_end: new Date('2026-06-02T09:00:00Z'),
        amount_usd: '42.18',
        shared_amount_usd: null,
        confidence: 'estimate',
        observed_at: new Date('2026-06-01T00:00:00Z'),
      },
      {
        environment_id: null,
        org_id: null,
        project_id: null,
        environment_slug: null,
        scope: 'shared_overhead',
        source: 'opencost',
        window_end: new Date('2026-06-02T09:00:00Z'),
        amount_usd: '12.00',
        shared_amount_usd: null,
        confidence: 'estimate',
        observed_at: new Date('2026-06-01T00:00:00Z'),
      },
    ]);
    mockTotalForMonth.mockResolvedValue({
      total_usd: '54.18',
      env_total_usd: '42.18',
      shared_usd: '12.00',
      env_count: 1,
    });
    mockFreshnessForMonth.mockResolvedValue({ observed_at: new Date('2026-06-01T00:00:00Z') });

    const result = await service.listEnvironmentCosts({
      month: '2026-06',
      now: new Date('2026-06-02T12:00:00Z'),
      staleAfterHours: 26,
    });

    expect(result).toMatchObject({
      window: {
        month: '2026-06',
        start: '2026-06-01T00:00:00.000Z',
        end: '2026-06-02T09:00:00.000Z',
      },
      source: 'opencost',
      total_usd: '54.18',
      shared_usd: '12.00',
      observed_at: '2026-06-01T00:00:00.000Z',
      stale: true,
      stale_after_hours: 26,
      environments: [
        {
          environment_id: 'env_a',
          environment_slug: 'prod',
          amount_usd: '42.18',
          confidence: 'estimate',
        },
      ],
    });
  });

  it('computes UTC month starts', () => {
    expect(utcMonthStart(new Date('2026-06-30T23:59:59Z')).toISOString()).toBe('2026-06-01T00:00:00.000Z');
  });

  it('returns cloud cost snapshots with stale metadata', async () => {
    mockCloudLatestForScope.mockResolvedValue({
      provider: 'aws',
      source: 'aws_cost_explorer',
      scope_type: 'cluster',
      scope_key: 'eve-cluster',
      scope_label: 'Eve staging cluster',
      window_end: new Date('2026-06-04T00:00:00Z'),
      mtd_through: '2026-06-03',
      amount: '23.43',
      projected_amount: '234.30',
      currency: 'USD',
      confidence: 'estimate',
      coverage: 'undercount',
      observed_at: new Date('2026-06-01T00:00:00Z'),
      filter_json: { tags: { Project: 'eve-horizon', Environment: 'staging' } },
      breakdown_json: { by_service: [] },
    });

    const result = await service.getCloudCost({
      month: '2026-06',
      scopeType: 'cluster',
      scopeKey: 'eve-cluster',
      provider: 'aws',
      source: 'aws_cost_explorer',
      now: new Date('2026-06-02T12:00:00Z'),
      staleAfterHours: 26,
    });

    expect(mockCloudLatestForScope).toHaveBeenCalledWith({
      provider: 'aws',
      source: 'aws_cost_explorer',
      scopeType: 'cluster',
      scopeKey: 'eve-cluster',
      windowStart: new Date('2026-06-01T00:00:00.000Z'),
    });
    expect(result).toMatchObject({
      window: {
        month: '2026-06',
        start: '2026-06-01T00:00:00.000Z',
        end: '2026-06-04T00:00:00.000Z',
        mtd_through: '2026-06-03',
      },
      provider: 'aws',
      source: 'aws_cost_explorer',
      scope: { type: 'cluster', key: 'eve-cluster', label: 'Eve staging cluster' },
      amount: '23.43',
      projected_amount: '234.30',
      stale: true,
      coverage: 'undercount',
    });
  });

  it('returns unavailable cloud metadata when no snapshot exists', async () => {
    mockCloudLatestForScope.mockResolvedValue(null);

    const result = await service.getCloudCost({
      month: '2026-06',
      scopeType: 'cluster',
      scopeKey: 'eve-cluster',
    });

    expect(result.amount).toBeNull();
    expect(result.confidence).toBe('unavailable');
    expect(result.scope.key).toBe('eve-cluster');
  });
});

describe('CostController', () => {
  it('requires system admin permission', () => {
    const permissions = Reflect.getMetadata(PERMISSION_KEY, CostController.prototype.listEnvironmentCosts);
    expect(permissions).toEqual(['system:admin']);
    const cloudPermissions = Reflect.getMetadata(PERMISSION_KEY, CostController.prototype.getCloudCost);
    expect(cloudPermissions).toEqual(['system:admin']);
  });

  it('passes query params to the service', async () => {
    const cost = {
      listEnvironmentCosts: vi.fn().mockResolvedValue({ environments: [] }),
      getCloudCost: vi.fn().mockResolvedValue({ amount: '1.00' }),
    };
    const controller = new CostController(cost as never, undefined as never);

    await controller.listEnvironmentCosts('2026-06', 'opencost');
    await controller.getCloudCost('cluster', 'eve-cluster', '2026-06', 'aws', 'aws_cost_explorer');

    expect(cost.listEnvironmentCosts).toHaveBeenCalledWith({ month: '2026-06', source: 'opencost' });
    expect(cost.getCloudCost).toHaveBeenCalledWith({
      scopeType: 'cluster',
      scopeKey: 'eve-cluster',
      month: '2026-06',
      provider: 'aws',
      source: 'aws_cost_explorer',
    });
  });
});
