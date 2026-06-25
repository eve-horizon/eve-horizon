import { z } from 'zod';

// ---------------------------------------------------------------------------
// Window parameter
// ---------------------------------------------------------------------------

export const AnalyticsWindowSchema = z.enum(['1d', '7d', '30d', '90d']).default('7d');
export type AnalyticsWindow = z.infer<typeof AnalyticsWindowSchema>;

// ---------------------------------------------------------------------------
// Job stats
// ---------------------------------------------------------------------------

export const AnalyticsJobStatsSchema = z.object({
  created: z.number(),
  completed: z.number(),
  failed: z.number(),
  active: z.number(),
});

export type AnalyticsJobStats = z.infer<typeof AnalyticsJobStatsSchema>;

// ---------------------------------------------------------------------------
// Pipeline stats
// ---------------------------------------------------------------------------

export const AnalyticsPipelineStatsSchema = z.object({
  runs: z.number(),
  success_rate: z.number(),
  avg_duration_s: z.number(),
});

export type AnalyticsPipelineStats = z.infer<typeof AnalyticsPipelineStatsSchema>;

// ---------------------------------------------------------------------------
// Deployment stats (placeholder for now)
// ---------------------------------------------------------------------------

export const AnalyticsDeploymentStatsSchema = z.object({
  total: z.number(),
  successful: z.number(),
  rollbacks: z.number(),
});

export type AnalyticsDeploymentStats = z.infer<typeof AnalyticsDeploymentStatsSchema>;

// ---------------------------------------------------------------------------
// Environment health
// ---------------------------------------------------------------------------

export const AnalyticsEnvHealthSchema = z.object({
  total: z.number(),
  healthy: z.number(),
  degraded: z.number(),
  unknown: z.number(),
});

export type AnalyticsEnvHealth = z.infer<typeof AnalyticsEnvHealthSchema>;

// ---------------------------------------------------------------------------
// Org-wide summary
// ---------------------------------------------------------------------------

export const AnalyticsSummarySchema = z.object({
  as_of: z.string(),
  window_start: z.string(),
  window_end: z.string(),
  window: z.string(),
  projects: z.number(),
  jobs: AnalyticsJobStatsSchema,
  pipelines: AnalyticsPipelineStatsSchema,
  deployments: AnalyticsDeploymentStatsSchema,
  environments: AnalyticsEnvHealthSchema,
});

export type AnalyticsSummary = z.infer<typeof AnalyticsSummarySchema>;
