import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSystem } from '../src/commands/system';

vi.mock('../src/lib/client', () => ({
  requestJson: vi.fn(),
  requestRaw: vi.fn(),
}));

import { requestJson } from '../src/lib/client';

const context = {
  apiUrl: 'http://example.test',
  token: 'token',
  profile: null,
  profileName: null,
  projectId: undefined,
};

const response = {
  window: {
    month: '2026-06',
    start: '2026-06-01T00:00:00.000Z',
    end: '2026-06-02T09:00:00.000Z',
  },
  source: 'opencost',
  total_usd: '184.21',
  env_total_usd: '87.81',
  shared_usd: '96.40',
  env_count: 2,
  observed_at: '2026-06-02T09:00:00.000Z',
  stale: false,
  stale_after_hours: 26,
  environments: [
    {
      environment_id: 'env_a',
      org_id: 'org_a',
      project_id: 'proj_a',
      environment_slug: 'acme / App A / prod',
      amount_usd: '42.18',
      shared_amount_usd: null,
      confidence: 'estimate',
      observed_at: '2026-06-02T09:00:00.000Z',
    },
    {
      environment_id: 'env_b',
      org_id: 'org_b',
      project_id: 'proj_b',
      environment_slug: 'sandbox',
      amount_usd: '31.06',
      shared_amount_usd: null,
      confidence: 'estimate',
      observed_at: '2026-06-02T09:00:00.000Z',
    },
  ],
};

describe('system env-cost', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(requestJson).mockReset();
  });

  it('passes month and source filters to the admin cost endpoint', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(response);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleSystem(
      'env-cost',
      [],
      { month: '2026-06', source: 'opencost', all: true },
      context as never,
    );

    expect(requestJson).toHaveBeenCalledWith(
      context,
      '/admin/cost/environments?month=2026-06&source=opencost',
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Environment Cost Estimates'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('acme / App A / prod'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Shared overhead: $96.40'));
  });

  it('emits the raw API payload for JSON output', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(response);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleSystem('env-cost', [], { json: true }, context as never);

    expect(requestJson).toHaveBeenCalledWith(context, '/admin/cost/environments');
    expect(log).toHaveBeenCalledWith(JSON.stringify(response));
  });
});

describe('system cloud-cost', () => {
  const cloudResponse = {
    window: {
      month: '2026-06',
      start: '2026-06-01T00:00:00.000Z',
      end: '2026-06-04T00:00:00.000Z',
      mtd_through: '2026-06-03',
    },
    provider: 'aws',
    source: 'aws_cost_explorer',
    scope: {
      type: 'cluster',
      key: 'eve-cluster',
      label: 'Eve staging cluster',
    },
    amount: '23.43',
    projected_amount: '234.30',
    currency: 'USD',
    confidence: 'estimate',
    coverage: 'undercount',
    observed_at: '2026-06-04T07:00:00.000Z',
    stale: false,
    stale_after_hours: 26,
    filter: {
      tags: {
        Project: 'eve-horizon',
        Environment: 'staging',
      },
    },
    breakdown: {
      metric: 'UnblendedCost',
      projection_caveat: 'early-month estimate based on 3 finalized days',
      by_service: [
        { service: 'Amazon Elastic Kubernetes Service', amount: 12.5, currency: 'USD' },
      ],
    },
  };

  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(requestJson).mockReset();
  });

  it('passes scope, provider, source, and month to the cloud cost endpoint', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(cloudResponse);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleSystem(
      'cloud-cost',
      [],
      {
        scope: 'cluster',
        'scope-key': 'eve-cluster',
        provider: 'aws',
        source: 'aws_cost_explorer',
        month: '2026-06',
      },
      context as never,
    );

    expect(requestJson).toHaveBeenCalledWith(
      context,
      '/admin/cost/cloud?scope_type=cluster&scope_key=eve-cluster&month=2026-06&provider=aws&source=aws_cost_explorer',
    );
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Monthly Eve staging cluster cloud cost'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('AWS Cost Explorer UnblendedCost'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Coverage: undercount'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Top services: EKS $12.50'));
  });

  it('emits the raw cloud API payload for JSON output', async () => {
    vi.mocked(requestJson).mockResolvedValueOnce(cloudResponse);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await handleSystem('cloud-cost', [], { json: true }, context as never);

    expect(requestJson).toHaveBeenCalledWith(context, '/admin/cost/cloud');
    expect(log).toHaveBeenCalledWith(JSON.stringify(cloudResponse));
  });
});
