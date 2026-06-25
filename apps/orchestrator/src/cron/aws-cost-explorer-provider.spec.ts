import { describe, expect, it, vi } from 'vitest';
import { AwsCostExplorerProvider } from './aws-cost-explorer-provider.js';
import type { CloudCostScopeConfig } from './cloud-cost-provider.js';

class FakeGetCostAndUsageCommand {
  constructor(readonly input: unknown) {}
}

const scope: CloudCostScopeConfig = {
  provider: 'aws',
  source: 'aws_cost_explorer',
  accountId: '000000000000',
  scopeType: 'cluster',
  scopeKey: 'eve-cluster',
  scopeLabel: 'Eve staging cluster',
  currency: 'USD',
  coverage: 'undercount',
  filter: {
    tags: {
      Project: 'eve-horizon',
      Environment: 'staging',
    },
  },
};

describe('AwsCostExplorerProvider', () => {
  it('builds the tagged Cost Explorer request and normalizes service rows', async () => {
    const send = vi.fn().mockResolvedValue({
      ResultsByTime: [
        {
          Groups: [
            {
              Keys: ['Amazon Relational Database Service'],
              Metrics: { UnblendedCost: { Amount: '3.2100000000', Unit: 'USD' } },
            },
            {
              Keys: ['Amazon Elastic Kubernetes Service'],
              Metrics: { UnblendedCost: { Amount: '6.3000000000', Unit: 'USD' } },
            },
          ],
        },
      ],
    });
    const provider = new AwsCostExplorerProvider({
      client: { send },
      sdkLoader: async () => ({
        CostExplorerClient: class {} as never,
        GetCostAndUsageCommand: FakeGetCostAndUsageCommand,
      }),
    });

    const result = await provider.fetchMonthToDate(scope, new Date('2026-06-04T12:00:00Z'));

    expect(send).toHaveBeenCalledTimes(1);
    const command = send.mock.calls[0][0] as FakeGetCostAndUsageCommand;
    expect(command.input).toMatchObject({
      Granularity: 'MONTHLY',
      Metrics: ['UnblendedCost'],
      TimePeriod: { Start: '2026-06-01', End: '2026-06-04' },
      Filter: {
        And: [
          { Tags: { Key: 'Project', Values: ['eve-horizon'] } },
          { Tags: { Key: 'Environment', Values: ['staging'] } },
        ],
      },
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    });
    expect(result).toMatchObject({
      amount: 9.51,
      projectedAmount: 95.1,
      currency: 'USD',
      mtdThrough: '2026-06-03',
      coverage: 'undercount',
      breakdown: {
        metric: 'UnblendedCost',
        days_elapsed: 3,
        days_in_month: 30,
        projection_caveat: 'early-month estimate based on 3 finalized days',
        by_service: [
          { service: 'Amazon Elastic Kubernetes Service', amount: 6.3, currency: 'USD' },
          { service: 'Amazon Relational Database Service', amount: 3.21, currency: 'USD' },
        ],
        provider_metadata: {
          ce_end_exclusive: '2026-06-04',
        },
      },
    });
  });

  it('returns null on the first UTC day of the month', async () => {
    const send = vi.fn();
    const provider = new AwsCostExplorerProvider({
      client: { send },
      sdkLoader: async () => ({
        CostExplorerClient: class {} as never,
        GetCostAndUsageCommand: FakeGetCostAndUsageCommand,
      }),
    });

    const result = await provider.fetchMonthToDate(scope, new Date('2026-06-01T12:00:00Z'));

    expect(result).toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns null for lagged empty or zero Cost Explorer responses', async () => {
    const send = vi.fn().mockResolvedValue({
      ResultsByTime: [
        {
          Total: { UnblendedCost: { Amount: '0', Unit: 'USD' } },
          Groups: [
            {
              Keys: ['Amazon Elastic Kubernetes Service'],
              Metrics: { UnblendedCost: { Amount: '0', Unit: 'USD' } },
            },
          ],
        },
      ],
    });
    const provider = new AwsCostExplorerProvider({
      client: { send },
      sdkLoader: async () => ({
        CostExplorerClient: class {} as never,
        GetCostAndUsageCommand: FakeGetCostAndUsageCommand,
      }),
    });

    const result = await provider.fetchMonthToDate(scope, new Date('2026-06-04T12:00:00Z'));

    expect(result).toBeNull();
  });
});
