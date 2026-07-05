import { Logger } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { CloudCostCollectorService } from './cloud-cost-collector.service.js';
import type { CloudCostProvider, CloudCostScopeConfig } from './cloud-cost-provider.js';

const scope: CloudCostScopeConfig = {
  provider: 'aws',
  source: 'aws_cost_explorer',
  accountId: '000000000000',
  scopeType: 'cluster',
  scopeKey: 'eve-cluster',
  scopeLabel: 'Eve staging cluster',
  currency: 'USD',
  coverage: 'undercount',
  filter: { tags: { Project: 'eve-horizon', Environment: 'staging' } },
};

describe('CloudCostCollectorService.collect', () => {
  function makeService() {
    const service = new CloudCostCollectorService({} as never);
    const upsert = vi.fn().mockResolvedValue({});
    (service as any).snapshots = { upsert };
    return { service, upsert };
  }

  it('is a disabled no-op when no provider is injected', async () => {
    const original = process.env.EVE_CLOUD_COST_ENABLED;
    delete process.env.EVE_CLOUD_COST_ENABLED;
    const { service, upsert } = makeService();
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

    await service.collect(undefined, new Date('2026-06-04T12:00:00Z'));

    expect(upsert).not.toHaveBeenCalled();
    logSpy.mockRestore();
    if (original == null) {
      delete process.env.EVE_CLOUD_COST_ENABLED;
    } else {
      process.env.EVE_CLOUD_COST_ENABLED = original;
    }
  });

  it('does not write a snapshot when the provider throws', async () => {
    const { service, upsert } = makeService();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const provider: CloudCostProvider = {
      provider: 'aws',
      source: 'aws_cost_explorer',
      fetchMonthToDate: vi.fn().mockRejectedValue(new Error('CE denied')),
    };

    await service.collect(provider, new Date('2026-06-04T12:00:00Z'), scope);

    expect(upsert).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith('[cloud-cost] Provider fetch failed: CE denied');
    warnSpy.mockRestore();
  });

  it('does not write a snapshot when the provider returns null', async () => {
    const { service, upsert } = makeService();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const provider: CloudCostProvider = {
      provider: 'aws',
      source: 'aws_cost_explorer',
      fetchMonthToDate: vi.fn().mockResolvedValue(null),
    };

    await service.collect(provider, new Date('2026-06-04T12:00:00Z'), scope);

    expect(upsert).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('writes one generic cloud snapshot on success', async () => {
    const { service, upsert } = makeService();
    const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    const now = new Date('2026-06-04T12:00:00Z');
    const provider: CloudCostProvider = {
      provider: 'aws',
      source: 'aws_cost_explorer',
      fetchMonthToDate: vi.fn().mockResolvedValue({
        amount: 23.43,
        projectedAmount: 234.3,
        currency: 'USD',
        windowStart: new Date('2026-06-01T00:00:00Z'),
        windowEnd: new Date('2026-06-04T00:00:00Z'),
        mtdThrough: '2026-06-03',
        confidence: 'estimate',
        coverage: 'undercount',
        filter: scope.filter,
        breakdown: { by_service: [] },
      }),
    };

    await service.collect(provider, now, scope);

    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'aws',
      source: 'aws_cost_explorer',
      scope_type: 'cluster',
      scope_key: 'eve-cluster',
      amount: '23.430000',
      projected_amount: '234.300000',
      mtd_through: '2026-06-03',
      coverage: 'undercount',
      observed_at: now,
    }));
    logSpy.mockRestore();
  });

  it('throws for unsupported configured providers', async () => {
    const originalProvider = process.env.EVE_CLOUD_COST_PROVIDER;
    const originalEnabled = process.env.EVE_CLOUD_COST_ENABLED;
    process.env.EVE_CLOUD_COST_ENABLED = 'true';
    process.env.EVE_CLOUD_COST_PROVIDER = 'gcp';
    const { service } = makeService();

    await expect(service.collect(undefined, new Date('2026-06-04T12:00:00Z'))).rejects.toThrow(
      'Unsupported cloud cost provider',
    );

    if (originalProvider == null) {
      delete process.env.EVE_CLOUD_COST_PROVIDER;
    } else {
      process.env.EVE_CLOUD_COST_PROVIDER = originalProvider;
    }
    if (originalEnabled == null) {
      delete process.env.EVE_CLOUD_COST_ENABLED;
    } else {
      process.env.EVE_CLOUD_COST_ENABLED = originalEnabled;
    }
  });
});
