import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface AnalyticsSummary {
  window: string;
  window_start: string;
  window_end: string;
  projects: number;
  jobs: { created: number; completed: number; failed: number; active: number };
  pipelines: { runs: number; success_rate: number; avg_duration_s: number };
  deployments: { total: number; successful: number; rollbacks: number };
  environments: { total: number; healthy: number; degraded: number; unknown: number };
}

export interface EnvHealthSummary {
  total: number;
  healthy: number;
  degraded: number;
  unknown: number;
  as_of: string;
}

export interface CostByAgent {
  agent: string;
  attempts: number;
  total_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
}

export interface OrgEvent {
  id: string;
  project_id: string;
  project_slug: string;
  type: string;
  source: string;
  status: string;
  created_at: string;
}

export interface SpendSummary {
  org_id: string;
  summary: {
    since?: string;
    until?: string;
    base_total_usd: string;
    billed_total: string;
    billed_currency: string;
    attempts: number;
  };
}

export function useAnalyticsSummary(orgId: string | null, window = '7d') {
  return useQuery({
    queryKey: ['analytics-summary', orgId, window],
    queryFn: () => api<AnalyticsSummary>(`/orgs/${orgId}/analytics/summary?window=${window}`),
    enabled: !!orgId,
    refetchInterval: 30_000,
  });
}

export function useEnvHealth(orgId: string | null) {
  return useQuery({
    queryKey: ['env-health', orgId],
    queryFn: () => api<EnvHealthSummary>(`/orgs/${orgId}/analytics/env-health`),
    enabled: !!orgId,
    refetchInterval: 10_000,
  });
}

export function useCostByAgent(orgId: string | null, window = '7d') {
  return useQuery({
    queryKey: ['cost-by-agent', orgId, window],
    queryFn: async () => {
      const res = await api<{ agents: CostByAgent[] }>(`/orgs/${orgId}/analytics/cost-by-agent?window=${window}`);
      return res.agents ?? [];
    },
    enabled: !!orgId,
    refetchInterval: 60_000,
  });
}

export function useOrgEvents(orgId: string | null, limit = 15) {
  return useQuery({
    queryKey: ['org-events', orgId, limit],
    queryFn: () =>
      api<{ items: OrgEvent[] }>(`/orgs/${orgId}/events?limit=${limit}`),
    enabled: !!orgId,
    refetchInterval: 5_000,
  });
}

export function useOrgSpend(orgId: string | null, since?: string) {
  return useQuery({
    queryKey: ['org-spend', orgId, since],
    queryFn: () => {
      const params = new URLSearchParams();
      if (since) params.set('since', since);
      return api<SpendSummary>(`/orgs/${orgId}/spend?${params}`);
    },
    enabled: !!orgId,
    refetchInterval: 60_000,
  });
}
