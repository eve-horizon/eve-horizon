import { z } from 'zod';

export const SpendSummarySchema = z.object({
  since: z.string().nullable(),
  until: z.string().nullable(),
  base_total_usd: z.string(),
  billed_total: z.string(),
  billed_currency: z.string(),
  attempts: z.number().int(),
});

export type SpendSummary = z.infer<typeof SpendSummarySchema>;

export const SpendTopJobSchema = z.object({
  job_id: z.string(),
  title: z.string(),
  base_total_usd: z.string(),
  billed_total: z.string(),
  billed_currency: z.string(),
  attempts: z.number().int(),
});

export type SpendTopJob = z.infer<typeof SpendTopJobSchema>;

export const ProjectSpendResponseSchema = z.object({
  project_id: z.string(),
  summary: SpendSummarySchema,
  top_jobs: z.array(SpendTopJobSchema).optional(),
});

export type ProjectSpendResponse = z.infer<typeof ProjectSpendResponseSchema>;

export const OrgSpendResponseSchema = z.object({
  org_id: z.string(),
  summary: SpendSummarySchema,
});

export type OrgSpendResponse = z.infer<typeof OrgSpendResponseSchema>;

export const JobAttemptCostSummarySchema = z.object({
  attempt_number: z.number().int(),
  status: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  base_total_usd: z.string(),
  billed_total: z.string(),
  billed_currency: z.string(),
  receipt: z.record(z.unknown()).nullable().optional(),
});

export type JobAttemptCostSummary = z.infer<typeof JobAttemptCostSummarySchema>;

export const JobCompareResponseSchema = z.object({
  job_id: z.string(),
  attempts: z.array(JobAttemptCostSummarySchema),
});

export type JobCompareResponse = z.infer<typeof JobCompareResponseSchema>;

export const AdminRecomputeReceiptsRequestSchema = z.object({
  since: z.string().optional(),
  project_id: z.string().optional(),
  dry_run: z.boolean().optional(),
  force: z.boolean().optional(),
});

export type AdminRecomputeReceiptsRequest = z.infer<typeof AdminRecomputeReceiptsRequestSchema>;

export const AdminRecomputeReceiptsResponseSchema = z.object({
  since: z.string().nullable(),
  project_id: z.string().nullable(),
  dry_run: z.boolean(),
  force: z.boolean(),
  scanned_attempts: z.number().int(),
  updated_attempts: z.number().int(),
  skipped_attempts: z.number().int(),
  errors: z.array(z.object({ attempt_id: z.string(), error: z.string() })).optional(),
});

export type AdminRecomputeReceiptsResponse = z.infer<typeof AdminRecomputeReceiptsResponseSchema>;

