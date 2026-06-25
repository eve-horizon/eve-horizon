import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

// Mirrors AppCostReport from apps/api/src/billing/app-cost.service.ts
export interface AppCostEnvironment {
  environment_id: string;
  env_name: string | null;
  namespace: string | null;
  opencost_usd: string;
  cloud_usd: string;
  confidence: string;
  observed_at: string;
}

export interface AppCostApp {
  org_id: string;
  project_id: string;
  project_name: string | null;
  project_slug: string | null;
  llm_usd: string;
  llm_attempts: number;
  cloud_usd: string;
  total_usd: string;
  environments: AppCostEnvironment[];
}

export interface AppCostReport {
  org_id: string | null;
  window: { month: string; start: string; end: string | null };
  method: 'bill_allocated_by_opencost' | 'opencost_direct' | 'none';
  bill: {
    provider: string | null;
    source: string | null;
    amount: string | null;
    projected_amount: string | null;
    currency: string | null;
    confidence: string;
    coverage: string;
    observed_at: string | null;
    stale: boolean;
  } | null;
  infra: {
    source: string;
    cluster_env_total_usd: string | null;
    cluster_shared_usd: string | null;
    platform_overhead_usd: string | null;
    allocation_factor: string | null;
    observed_at: string | null;
    stale: boolean;
  };
  llm: { total_usd: string; attempts: number };
  totals: { cloud_usd: string; llm_usd: string; total_usd: string };
  orgs?: Array<{ org_id: string; org_slug: string | null; org_name: string | null }>;
  apps: AppCostApp[];
}

/** Org-scoped per-app cost report (members see their own org). */
export function useAppCosts(orgId: string | null, month?: string) {
  return useQuery({
    queryKey: ['app-costs', orgId, month],
    queryFn: () => {
      const params = new URLSearchParams();
      if (month) params.set('month', month);
      const qs = params.toString();
      return api<AppCostReport>(`/orgs/${orgId}/cost/apps${qs ? `?${qs}` : ''}`);
    },
    enabled: !!orgId,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
}

/** Cross-org per-app cost report — platform admins only. */
export function useAdminAppCosts(enabled: boolean, month?: string) {
  return useQuery({
    queryKey: ['admin-app-costs', month],
    queryFn: () => {
      const params = new URLSearchParams();
      if (month) params.set('month', month);
      const qs = params.toString();
      return api<AppCostReport>(`/admin/cost/apps${qs ? `?${qs}` : ''}`);
    },
    enabled,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });
}

/** Admin bill-backed cloud cost (with by-service breakdown). */
export interface CloudCostBreakdownService {
  service: string;
  amount: number;
  currency: string;
}

export interface AdminCloudCost {
  window: { month: string; start: string; end: string | null; mtd_through: string | null };
  provider: string | null;
  source: string | null;
  amount: string | null;
  projected_amount: string | null;
  currency: string | null;
  confidence: string;
  coverage: string;
  observed_at: string | null;
  stale: boolean;
  breakdown: { by_service?: CloudCostBreakdownService[] } & Record<string, unknown>;
}

export function useAdminCloudCost(enabled: boolean, month?: string) {
  return useQuery({
    queryKey: ['admin-cloud-cost', month],
    queryFn: () => {
      const params = new URLSearchParams();
      if (month) params.set('month', month);
      const qs = params.toString();
      return api<AdminCloudCost>(`/admin/cost/cloud${qs ? `?${qs}` : ''}`);
    },
    enabled,
    refetchInterval: 300_000,
    staleTime: 120_000,
  });
}

/** Recent UTC months for the month picker, newest first. */
export function recentMonths(count = 6): Array<{ value: string; label: string }> {
  const months: Array<{ value: string; label: string }> = [];
  const now = new Date();
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const value = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const label = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    months.push({ value, label });
  }
  return months;
}
