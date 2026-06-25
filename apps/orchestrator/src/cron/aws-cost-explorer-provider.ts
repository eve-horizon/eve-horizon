import {
  addUtcDays,
  daysInUtcMonth,
  monthStartUtc,
  utcDateString,
  wholeUtcDaysBetween,
  type CloudCostProvider,
  type CloudCostResult,
  type CloudCostScopeConfig,
} from './cloud-cost-provider.js';

type CostExplorerRequest = {
  TimePeriod: { Start: string; End: string };
  Granularity: 'MONTHLY';
  Metrics: string[];
  Filter: {
    And: Array<{ Tags: { Key: string; Values: string[] } }>;
  };
  GroupBy: Array<{ Type: 'DIMENSION'; Key: 'SERVICE' }>;
};

type CostExplorerMetric = {
  Amount?: string;
  Unit?: string;
};

type CostExplorerGroup = {
  Keys?: string[];
  Metrics?: Record<string, CostExplorerMetric>;
};

type CostExplorerResultByTime = {
  Total?: Record<string, CostExplorerMetric>;
  Groups?: CostExplorerGroup[];
};

type CostExplorerResponse = {
  ResultsByTime?: CostExplorerResultByTime[];
};

type CostExplorerClientLike = {
  send(command: unknown): Promise<CostExplorerResponse>;
};

type CostExplorerSdk = {
  CostExplorerClient: new (config: { region: string }) => CostExplorerClientLike;
  GetCostAndUsageCommand: new (input: CostExplorerRequest) => unknown;
};

const AWS_CE_REGION = 'us-east-1';
const METRIC = 'UnblendedCost';

export class AwsCostExplorerProvider implements CloudCostProvider {
  readonly provider = 'aws';
  readonly source = 'aws_cost_explorer';

  private client: CostExplorerClientLike | null;

  constructor(private readonly opts: {
    client?: CostExplorerClientLike;
    sdkLoader?: () => Promise<CostExplorerSdk>;
  } = {}) {
    this.client = opts.client ?? null;
  }

  async fetchMonthToDate(scope: CloudCostScopeConfig, now: Date): Promise<CloudCostResult | null> {
    const windowStart = monthStartUtc(now);
    const windowEnd = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    if (windowEnd.getTime() <= windowStart.getTime()) {
      return null;
    }

    const daysElapsed = wholeUtcDaysBetween(windowStart, windowEnd);
    if (daysElapsed <= 0) {
      return null;
    }

    const projectTagValue = readAwsTag(scope.filter, 'Project');
    const environmentTagValue = readAwsTag(scope.filter, 'Environment');
    const request: CostExplorerRequest = {
      Granularity: 'MONTHLY',
      Metrics: [METRIC],
      TimePeriod: {
        Start: utcDateString(windowStart),
        End: utcDateString(windowEnd),
      },
      Filter: {
        And: [
          { Tags: { Key: 'Project', Values: [projectTagValue] } },
          { Tags: { Key: 'Environment', Values: [environmentTagValue] } },
        ],
      },
      GroupBy: [{ Type: 'DIMENSION', Key: 'SERVICE' }],
    };

    const client = await this.getClient();
    const sdk = await this.getSdk();
    const response = await client.send(new sdk.GetCostAndUsageCommand(request));
    const rows = normalizeServiceRows(response, scope.currency);
    const nonZeroRows = rows.filter((row) => row.amount > 0);
    const totalFromResponse = parseMetricAmount(response.ResultsByTime?.[0]?.Total?.[METRIC]?.Amount);
    const serviceTotal = nonZeroRows.reduce((sum, row) => sum + row.amount, 0);
    const amount = totalFromResponse > 0 ? totalFromResponse : serviceTotal;

    if (amount <= 0 || nonZeroRows.length === 0) {
      return null;
    }

    const daysInMonth = daysInUtcMonth(windowStart);
    const projectedAmount = amount / daysElapsed * daysInMonth;
    const mtdThrough = utcDateString(addUtcDays(windowEnd, -1));
    const projectionCaveat = daysElapsed < 4
      ? `early-month estimate based on ${daysElapsed} finalized day${daysElapsed === 1 ? '' : 's'}`
      : undefined;

    return {
      amount,
      projectedAmount,
      currency: nonZeroRows[0]?.currency ?? scope.currency,
      windowStart,
      windowEnd,
      mtdThrough,
      confidence: 'estimate',
      coverage: scope.coverage,
      filter: scope.filter,
      breakdown: {
        metric: METRIC,
        days_elapsed: daysElapsed,
        days_in_month: daysInMonth,
        ...(projectionCaveat ? { projection_caveat: projectionCaveat } : {}),
        by_service: nonZeroRows.map((row) => ({
          service: row.service,
          amount: roundMoney(row.amount),
          currency: row.currency,
        })),
        provider_metadata: {
          ce_end_exclusive: request.TimePeriod.End,
        },
      },
    };
  }

  private async getClient(): Promise<CostExplorerClientLike> {
    if (this.client) return this.client;
    const sdk = await this.getSdk();
    this.client = new sdk.CostExplorerClient({ region: AWS_CE_REGION });
    return this.client;
  }

  private async getSdk(): Promise<CostExplorerSdk> {
    if (this.opts.sdkLoader) return this.opts.sdkLoader();
    return await import('@aws-sdk/client-cost-explorer') as CostExplorerSdk;
  }
}

function readAwsTag(filter: Record<string, unknown>, key: 'Project' | 'Environment'): string {
  const tags = filter.tags;
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
    throw new Error(`AWS cloud cost filter missing tags.${key}`);
  }
  const value = (tags as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`AWS cloud cost filter missing tags.${key}`);
  }
  return value.trim();
}

function normalizeServiceRows(response: CostExplorerResponse, fallbackCurrency: string): Array<{
  service: string;
  amount: number;
  currency: string;
}> {
  const groups = response.ResultsByTime?.flatMap((period) => period.Groups ?? []) ?? [];
  return groups
    .map((group) => {
      const metric = group.Metrics?.[METRIC];
      return {
        service: group.Keys?.[0] ?? 'Unknown',
        amount: parseMetricAmount(metric?.Amount),
        currency: metric?.Unit ?? fallbackCurrency,
      };
    })
    .filter((row) => Number.isFinite(row.amount))
    .sort((a, b) => b.amount - a.amount || a.service.localeCompare(b.service));
}

function parseMetricAmount(value: string | undefined): number {
  if (!value) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function roundMoney(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}
