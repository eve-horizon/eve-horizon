import { Logger } from '@nestjs/common';
import { describe, it, expect, vi } from 'vitest';
import {
  EnvCostCollectorService,
  OpenCostSource,
  monthStartUtc,
  normalizeOpenCostAllocations,
  toOpenCostWindowTimestamp,
  type CostSource,
} from './env-cost-collector.service.js';

describe('env cost collector helpers', () => {
  it('normalizes OpenCost array and allocation-map shapes', () => {
    const allocations = normalizeOpenCostAllocations({
      data: {
        sets: [
          {
            allocations: {
              'eve-org-project-prod': {
                properties: {
                  namespace: 'eve-org-project-prod',
                  labels: { 'eve.env_id': 'env_123' },
                },
                totalCost: '12.345',
                sharedCost: 1.25,
              },
              __idle__: {
                properties: {},
                totalCost: 3,
              },
            },
          },
        ],
      },
    });

    expect(allocations).toHaveLength(2);
    expect(allocations[0]).toMatchObject({
      key: 'eve-org-project-prod',
      namespace: 'eve-org-project-prod',
      envId: 'env_123',
      amountUsd: 12.345,
      sharedAmountUsd: 1.25,
    });
    expect(allocations[1]).toMatchObject({
      key: '__idle__',
      namespace: null,
      amountUsd: 3,
    });
  });

  it('normalizes OpenCost data arrays containing allocation maps', () => {
    const allocations = normalizeOpenCostAllocations({
      code: 200,
      data: [
        {
          'eve-org-project-prod': {
            name: 'eve-org-project-prod',
            properties: { namespace: 'eve-org-project-prod' },
            totalCost: 9.5,
          },
          'kube-system': {
            name: 'kube-system',
            properties: { namespace: 'kube-system' },
            totalCost: 1.75,
          },
        },
      ],
    });

    expect(allocations).toHaveLength(2);
    expect(allocations[0]).toMatchObject({
      key: 'eve-org-project-prod',
      namespace: 'eve-org-project-prod',
      amountUsd: 9.5,
    });
    expect(allocations[1]).toMatchObject({
      key: 'kube-system',
      namespace: 'kube-system',
      amountUsd: 1.75,
    });
  });

  it('computes UTC month start', () => {
    expect(monthStartUtc(new Date('2026-06-15T18:30:00.000Z')).toISOString())
      .toBe('2026-06-01T00:00:00.000Z');
  });
});

describe('EnvCostCollectorService.collect', () => {
  function makeService() {
    const service = new EnvCostCollectorService({} as any);
    const listActive = vi.fn().mockResolvedValue([
      {
        id: 'env_123',
        project_id: 'proj_123',
        name: 'prod',
        namespace: 'eve-org-project-prod',
      },
    ]);
    const findProjectById = vi.fn().mockResolvedValue({
      id: 'proj_123',
      org_id: 'org_123',
      name: 'Support Bot',
      slug: 'supbot',
    });
    const findOrgById = vi.fn().mockResolvedValue({ id: 'org_123', name: 'Acme', slug: 'acme' });
    const upsert = vi.fn().mockResolvedValue({});

    (service as any).environments = { listActive };
    (service as any).orgs = { findById: findOrgById };
    (service as any).projects = { findById: findProjectById };
    (service as any).snapshots = { upsert };

    return { service, listActive, findProjectById, findOrgById, upsert };
  }

  it('writes environment and shared-overhead snapshots', async () => {
    const { service, upsert } = makeService();
    const now = new Date('2026-06-02T08:00:00.000Z');
    const source: CostSource = {
      name: 'opencost',
      fetchMonthToDate: vi.fn().mockResolvedValue([
        {
          key: 'eve-org-project-prod',
          namespace: 'eve-org-project-prod',
          envId: 'env_123',
          amountUsd: 12,
          sharedAmountUsd: 1,
          raw: { namespace: 'eve-org-project-prod' },
        },
        {
          key: '__idle__',
          namespace: null,
          envId: null,
          amountUsd: 4,
          sharedAmountUsd: null,
          raw: { name: '__idle__' },
        },
        {
          key: 'kube-system',
          namespace: 'kube-system',
          envId: null,
          amountUsd: 2,
          sharedAmountUsd: null,
          raw: { namespace: 'kube-system' },
        },
      ]),
    };

    await service.collect(source, now);

    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      aggregation_key: 'env:env_123',
      environment_id: 'env_123',
      org_id: 'org_123',
      project_id: 'proj_123',
      environment_slug: 'acme / Support Bot / prod',
      scope: 'environment',
      amount_usd: '12.000000',
      shared_amount_usd: '1.000000',
      window_start: new Date('2026-06-01T00:00:00.000Z'),
      observed_at: now,
    }));
    expect(upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      aggregation_key: 'shared:platform',
      environment_id: null,
      scope: 'shared_overhead',
      amount_usd: '6.000000',
      observed_at: now,
    }));
  });

  it('keeps last-good snapshots untouched when source fetch fails', async () => {
    const { service, upsert } = makeService();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const source: CostSource = {
      name: 'opencost',
      fetchMonthToDate: vi.fn().mockRejectedValue(new Error('opencost down')),
    };

    await service.collect(source, new Date('2026-06-02T08:00:00.000Z'));

    expect(upsert).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('keeps last-good snapshots untouched when source returns no usable allocations', async () => {
    const { service, upsert } = makeService();
    const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    const source: CostSource = {
      name: 'opencost',
      fetchMonthToDate: vi.fn().mockResolvedValue([]),
    };

    await service.collect(source, new Date('2026-06-02T08:00:00.000Z'));

    expect(upsert).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      '[env-cost] Source returned no usable allocations; leaving last-good snapshots untouched',
    );
    warnSpy.mockRestore();
  });
});

describe('OpenCostSource window formatting', () => {
  it('strips fractional seconds from window timestamps', () => {
    expect(toOpenCostWindowTimestamp(new Date('2026-06-01T00:00:00.000Z'))).toBe(
      '2026-06-01T00:00:00Z',
    );
    expect(toOpenCostWindowTimestamp(new Date('2026-06-02T16:40:00.123Z'))).toBe(
      '2026-06-02T16:40:00Z',
    );
  });

  it('requests /allocation with a millisecond-free window (OpenCost rejects fractional seconds)', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [] }),
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      const source = new OpenCostSource('http://opencost.opencost.svc.cluster.local:9003', {
        shareIdle: false,
        timeoutMs: 10_000,
      });
      await source.fetchMonthToDate({
        start: new Date('2026-06-01T00:00:00.000Z'),
        end: new Date('2026-06-02T16:40:00.000Z'),
      });

      const calledUrl = String(fetchMock.mock.calls[0][0]);
      expect(calledUrl).toContain(
        'window=2026-06-01T00%3A00%3A00Z%2C2026-06-02T16%3A40%3A00Z',
      );
      expect(calledUrl).not.toMatch(/\.\d{3}Z/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
