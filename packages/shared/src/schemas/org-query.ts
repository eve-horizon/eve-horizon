import { z } from 'zod';

// ============================================================================
// Cursor-based pagination
// ============================================================================

export const CursorPaginationSchema = z.object({
  limit: z.number().int().nonnegative(),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

export type CursorPagination = z.infer<typeof CursorPaginationSchema>;

// ============================================================================
// Org Job Query
// ============================================================================

export const OrgJobQueryParamsSchema = z.object({
  status: z.string().optional(),
  agent_slug: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export type OrgJobQueryParams = z.infer<typeof OrgJobQueryParamsSchema>;

/** Lightweight job item for cross-project listing (avoids sending full JSONB blobs). */
export const OrgJobItemSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  project_slug: z.string(),
  project_name: z.string(),
  title: z.string(),
  phase: z.string(),
  priority: z.number().int(),
  assignee: z.string().nullable(),
  labels: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
});

export type OrgJobItem = z.infer<typeof OrgJobItemSchema>;

export const OrgJobListResponseSchema = z.object({
  items: z.array(OrgJobItemSchema),
  pagination: CursorPaginationSchema,
});

export type OrgJobListResponse = z.infer<typeof OrgJobListResponseSchema>;

// ============================================================================
// Org Job Stats
// ============================================================================

export const OrgJobStatsProjectEntrySchema = z.object({
  project_id: z.string(),
  project_name: z.string(),
  count: z.number().int(),
});

export type OrgJobStatsProjectEntry = z.infer<typeof OrgJobStatsProjectEntrySchema>;

export const OrgJobStatsResponseSchema = z.object({
  total: z.number().int(),
  by_phase: z.record(z.string(), z.number().int()),
  by_project: z.array(OrgJobStatsProjectEntrySchema),
});

export type OrgJobStatsResponse = z.infer<typeof OrgJobStatsResponseSchema>;

// ============================================================================
// Org Event Query
// ============================================================================

export const OrgEventQueryParamsSchema = z.object({
  type: z.string().optional(),
  since: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export type OrgEventQueryParams = z.infer<typeof OrgEventQueryParamsSchema>;

/** Lightweight event item for cross-project listing. */
export const OrgEventItemSchema = z.object({
  id: z.string(),
  project_id: z.string(),
  project_slug: z.string(),
  type: z.string(),
  source: z.string(),
  status: z.string(),
  created_at: z.string(),
});

export type OrgEventItem = z.infer<typeof OrgEventItemSchema>;

export const OrgEventListResponseSchema = z.object({
  items: z.array(OrgEventItemSchema),
  pagination: CursorPaginationSchema,
});

export type OrgEventListResponse = z.infer<typeof OrgEventListResponseSchema>;

// ============================================================================
// Org Agents Query
// ============================================================================

export const OrgAgentItemSchema = z.object({
  project_id: z.string(),
  project_slug: z.string(),
  project_name: z.string(),
  agent_id: z.string(),
  agent_slug: z.string().nullable(),
  agent_name: z.string().nullable(),
  agent_description: z.string().nullable(),
  role: z.string().nullable(),
  workflow: z.string().nullable(),
  gateway_policy: z.string(),
});

export type OrgAgentItem = z.infer<typeof OrgAgentItemSchema>;

export const OrgAgentsListResponseSchema = z.object({
  items: z.array(OrgAgentItemSchema),
  total: z.number().int(),
});

export type OrgAgentsListResponse = z.infer<typeof OrgAgentsListResponseSchema>;
